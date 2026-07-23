# flowbun_conversation — Home Assistant custom component

Makes a flowbun flow the **conversation agent** of a Home Assistant Assist
pipeline. Your ESPHome voice satellite keeps talking to Home Assistant as
normal — wake word and speech-to-text stay wherever they are today — and only
the "what should I say and do?" stage is forwarded to flowbun:

```
ESP32 satellite ──audio──▶ HA (STT) ──text──▶ flowbun @http/in ──▶ ... ──▶ reply text ──▶ HA (TTS) ──audio──▶ ESP32
```

The flowbun side of this is the `voice-assist` package from flowbun-registry
(`@http/in` → `voice_gate` → `@ai/agent` → `voice_reply`).

## Install

1. Copy this folder into your Home Assistant config as
   `config/custom_components/flowbun_conversation/` and restart HA.
2. Settings → Devices & services → Add integration → **Flowbun Conversation**.
   - **Endpoint URL**: the `@http/in` node's address, e.g.
     `http://<flowbun-host>:8130/converse` (publish the port from the flowbun
     container).
   - **Bearer token**: must match the `@http/in` node's `token` config.
   - **Reply timeout**: keep it a few seconds above the flow's own
     `replyTimeoutMs`.
3. Settings → Voice assistants → your pipeline → **Conversation agent** →
   *Flowbun*.
4. Test by **typing** into the Assist chat first — it exercises exactly the
   same stage as the satellite, with no microphone in the loop.

## Wire protocol

`POST` to the endpoint, `Authorization: Bearer <token>`:

```json
{ "text": "turn on the kitchen lights", "conversation_id": "01J...", "device_id": "abc123", "language": "en" }
```

Expected `200` reply (anything else, or a timeout, becomes a spoken fallback
so the satellite never goes silent):

```json
{ "text": "Done — the kitchen lights are on.", "conversation_id": "01J..." }
```

`conversation_id` round-trips so the flow can keep per-conversation history;
`device_id` identifies the satellite so the flow can prefer entities in the
room the voice came from.

## Status

Written against the Home Assistant 2025/2026 `conversation` platform API
(`ConversationEntity` / `async_process`). Not yet exercised against a live HA
instance — if the API has drifted, expect the fix to be small and local to
`conversation.py`.
