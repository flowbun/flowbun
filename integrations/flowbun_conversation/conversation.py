"""The conversation entity that forwards Assist turns to flowbun."""

from __future__ import annotations

import json
import logging
from collections.abc import AsyncGenerator
from typing import Any, Literal

import aiohttp

from homeassistant.components import conversation
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import MATCH_ALL
from homeassistant.core import HomeAssistant
from homeassistant.helpers import intent
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import CONF_TIMEOUT, CONF_TOKEN, CONF_URL, DEFAULT_TIMEOUT

_LOGGER = logging.getLogger(__name__)

# Spoken when flowbun can't be reached or answers with anything unusable —
# the worst voice failure mode is silence, so every error path must end in
# real speech.
FALLBACK_SPEECH = "Sorry, I couldn't reach my brain. Please try again."


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up the conversation entity from a config entry."""
    async_add_entities([FlowbunConversationEntity(entry)])


class FlowbunConversationEntity(conversation.ConversationEntity):
    """A conversation agent whose brain is a flowbun flow.

    Sends {text, conversation_id, device_id, language} to the flow's
    @http/in endpoint (see the voice-assist flowbun package) and speaks what
    comes back. conversation_id round-trips so the flow can keep
    per-conversation history; device_id lets it prefer entities in the
    speaking satellite's own area.

    Two reply shapes, distinguished by content-type:
    - application/json: one {"text": ...} object, spoken whole (the
      original protocol — also what error paths and non-streaming flows
      produce).
    - application/x-ndjson: the flow is streaming. One {"delta": <piece>}
      line per chunk followed by a closing {"done": true, "status": ...,
      "body": {...}} line (or {"error": ...} if the flow gave up mid-way).
      Deltas are fed into the ChatLog as they arrive, which is what lets
      the Assist pipeline start streaming TTS before the answer is
      complete — the entire point of this shape.
    """

    _attr_has_entity_name = True
    _attr_name = None
    _attr_supported_features = conversation.ConversationEntityFeature.CONTROL

    def __init__(self, entry: ConfigEntry) -> None:
        """Initialize from the config entry."""
        self._entry = entry
        self._attr_unique_id = entry.entry_id
        self._attr_device_info = None

    @property
    def supported_languages(self) -> list[str] | Literal["*"]:
        """Flowbun decides what it understands — don't gate languages here."""
        return MATCH_ALL

    async def _async_handle_message(
        self,
        user_input: conversation.ConversationInput,
        chat_log: conversation.ChatLog,
    ) -> conversation.ConversationResult:
        """Forward one utterance to flowbun and wrap its reply for Assist."""
        data = self._entry.data
        session = async_get_clientsession(self.hass)
        headers = {"content-type": "application/json"}
        if data.get(CONF_TOKEN):
            headers["authorization"] = f"Bearer {data[CONF_TOKEN]}"

        # Omit absent fields rather than sending JSON nulls — flowbun's
        # voice_gate treats null as absent too, but there's no reason to
        # make the wire format ambiguous.
        payload = {
            key: value
            for key, value in {
                "text": user_input.text,
                "conversation_id": user_input.conversation_id,
                "device_id": user_input.device_id,
                "language": user_input.language,
            }.items()
            if value is not None
        }

        speech = FALLBACK_SPEECH
        conversation_id = user_input.conversation_id
        error: str | None = None
        try:
            async with session.post(
                data[CONF_URL],
                json=payload,
                headers=headers,
                timeout=aiohttp.ClientTimeout(
                    total=data.get(CONF_TIMEOUT, DEFAULT_TIMEOUT)
                ),
            ) as resp:
                content_type = resp.headers.get("content-type", "")
                if resp.status == 200 and "application/x-ndjson" in content_type:
                    return await self._async_handle_stream(
                        user_input, chat_log, resp
                    )
                body = await resp.json(content_type=None)
                if resp.status == 200 and isinstance(body, dict) and body.get("text"):
                    speech = str(body["text"])
                    conversation_id = (
                        body.get("conversation_id") or conversation_id
                    )
                else:
                    error = f"flowbun answered {resp.status}: {body!r}"
        except TimeoutError:
            error = "flowbun did not reply in time"
        except aiohttp.ClientError as err:
            error = f"could not reach flowbun: {err}"
        except ValueError as err:  # non-JSON body
            error = f"flowbun sent a non-JSON reply: {err}"

        response = intent.IntentResponse(language=user_input.language)
        if error is not None:
            _LOGGER.warning("Flowbun conversation failed: %s", error)
            # async_set_error text is what Assist actually speaks — keep it
            # human, and keep the technical detail in the log line above.
            response.async_set_error(
                intent.IntentResponseErrorCode.UNKNOWN, FALLBACK_SPEECH
            )
        else:
            # Recorded (not re-spoken — speech below carries the reply) so
            # HA's own chat/debug views show the turn like any agent's.
            chat_log.async_add_assistant_content_without_tools(
                conversation.AssistantContent(
                    agent_id=self.entity_id, content=speech
                )
            )
            response.async_set_speech(speech)
        return conversation.ConversationResult(
            response=response, conversation_id=conversation_id
        )

    async def _async_handle_stream(
        self,
        user_input: conversation.ConversationInput,
        chat_log: conversation.ChatLog,
        resp: aiohttp.ClientResponse,
    ) -> conversation.ConversationResult:
        """Feed an NDJSON delta stream into the chat log as it arrives.

        Pushing deltas through chat_log.async_add_delta_content_stream is
        what fires the Assist pipeline's delta listener, which starts
        streaming TTS after ~60 characters — the speaker begins answering
        while flowbun's model is still generating.
        """
        final_line: dict[str, Any] | None = None
        stream_error: str | None = None

        async def _deltas() -> AsyncGenerator[
            conversation.AssistantContentDeltaDict
        ]:
            nonlocal final_line, stream_error
            yield {"role": "assistant"}
            while raw := await resp.content.readline():
                try:
                    obj = json.loads(raw)
                except ValueError:
                    continue  # tolerate a torn/garbled line, keep reading
                if isinstance(obj.get("delta"), str):
                    yield {"content": obj["delta"]}
                elif obj.get("done"):
                    final_line = obj
                    return
                elif "error" in obj:
                    stream_error = str(obj["error"])
                    return

        async for _content in chat_log.async_add_delta_content_stream(
            self.entity_id, _deltas()
        ):
            pass

        if final_line is None:
            # The flow died mid-stream (its own reply timeout, a crash) —
            # whatever was already spoken can't be unsaid; log why and
            # settle the turn with what the chat log holds.
            _LOGGER.warning(
                "Flowbun stream ended without a final reply: %s",
                stream_error or "connection closed",
            )
        return conversation.async_get_result_from_chat_log(user_input, chat_log)
