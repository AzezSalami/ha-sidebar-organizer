"""Sidebar Groups: collapsible groups in the Home Assistant sidebar.

The integration only serves a frontend module and asks the frontend to load
it on every page, so no configuration.yaml or dashboard resource is needed.
Layouts are stored by the frontend in Home Assistant's own user/system data.
"""

from __future__ import annotations

from pathlib import Path

from homeassistant.components.frontend import add_extra_js_url, remove_extra_js_url
from homeassistant.components.http import StaticPathConfig
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant

from .const import DOMAIN, MODULE_URL, STATIC_URL


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Serve the frontend module and register it with the frontend."""
    # Static paths cannot be unregistered, so only register once per run.
    if not hass.data.get(DOMAIN):
        await hass.http.async_register_static_paths(
            [
                StaticPathConfig(
                    STATIC_URL, str(Path(__file__).parent / "frontend"), False
                )
            ]
        )
        hass.data[DOMAIN] = True
    add_extra_js_url(hass, MODULE_URL)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Stop loading the frontend module."""
    remove_extra_js_url(hass, MODULE_URL)
    return True
