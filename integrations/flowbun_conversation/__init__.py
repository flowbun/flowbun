"""Flowbun Conversation: use a flowbun flow as an Assist conversation agent.

The heavy lifting happens in flowbun (speech-to-text and text-to-speech stay
in Home Assistant's own Assist pipeline) — this integration only forwards the
transcribed text to flowbun's @http/in endpoint and speaks back whatever the
flow replies. See the flowbun repo's integrations/flowbun_conversation/README
for the matching flowbun-side setup (the voice-assist package).
"""

from __future__ import annotations

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant

PLATFORMS: list[Platform] = [Platform.CONVERSATION]


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up Flowbun Conversation from a config entry."""
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload a config entry."""
    return await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
