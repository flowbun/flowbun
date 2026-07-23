"""Config flow for the Flowbun Conversation integration."""

from __future__ import annotations

from typing import Any
from urllib.parse import urlparse

import voluptuous as vol

from homeassistant.config_entries import ConfigFlow, ConfigFlowResult

from .const import CONF_TIMEOUT, CONF_TOKEN, CONF_URL, DEFAULT_TIMEOUT, DOMAIN

STEP_USER_SCHEMA = vol.Schema(
    {
        vol.Required(CONF_URL): str,
        vol.Optional(CONF_TOKEN, default=""): str,
        vol.Optional(CONF_TIMEOUT, default=DEFAULT_TIMEOUT): vol.All(
            vol.Coerce(int), vol.Range(min=5, max=300)
        ),
    }
)


class FlowbunConversationConfigFlow(ConfigFlow, domain=DOMAIN):
    """Handle the config flow: just a URL, an optional token, and a timeout.

    Deliberately no live connection test here: the flowbun flow behind the
    endpoint may be disabled while the user is still setting things up, and
    a test request would run a real (possibly billed) agent turn.
    """

    VERSION = 1

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Handle the initial step."""
        errors: dict[str, str] = {}
        if user_input is not None:
            parsed = urlparse(user_input[CONF_URL])
            if parsed.scheme not in ("http", "https") or not parsed.netloc:
                errors[CONF_URL] = "invalid_url"
            else:
                return self.async_create_entry(
                    title=f"Flowbun ({parsed.netloc})", data=user_input
                )
        return self.async_show_form(
            step_id="user", data_schema=STEP_USER_SCHEMA, errors=errors
        )
