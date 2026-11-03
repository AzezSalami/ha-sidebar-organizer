# Sidebar Groups

Collapsible groups for the Home Assistant sidebar. Put your dashboards, tools
and admin pages into drop-down groups, and edit them right from the sidebar.

## Why this one

- **Nothing to paste into `configuration.yaml`.** It's a HACS *integration*:
  add it once, and it loads its own frontend code on every page. There's no
  `extra_module_url` and no `hacstag` to keep in sync after updates.
- **No YAML files.** Layouts are saved in Home Assistant's own storage, so they
  follow you to every browser and the companion app.
- **Edit in place.** Right-click (or long-press on touch) any sidebar item to
  open the editor. Drag items between groups, or use the menu and arrows next
  to each one.
- **Per-user layouts, plus a default.** Everyone can have their own layout.
  Admins can also save a default layout for everyone who hasn't made their own.
- **Works with the icon-only sidebar.** When the sidebar is collapsed, clicking
  a group opens a small pop-out menu of its items.
- **Doesn't fight Home Assistant.** It uses the sidebar's built-in navigation
  slot instead of rewriting HA's internals. Hiding panels and HA's own
  ordering (long-press the sidebar title) keep working, and if anything goes
  wrong the stock sidebar shows again.
- The group containing the page you're on opens by itself. Which groups are
  open is remembered per device.

Requires Home Assistant 2026.6 or newer.

## Install

### HACS (custom repository)

1. In HACS, open the ⋮ menu → **Custom repositories**.
2. Add this repository's URL with type **Integration**.
3. Find **Sidebar Groups** in HACS and download it.
4. Restart Home Assistant.
5. Go to **Settings → Devices & services → Add integration**, search for
   **Sidebar Groups**, and add it.
6. Reload the browser page.

### Manual

Copy `custom_components/sidebar_groups` into your Home Assistant
`config/custom_components/` folder, restart, then do steps 5–6 above.

## Use

1. Right-click any item in the sidebar (long-press on phones and tablets).
2. Click **Add group**, give it a name and an icon (any `mdi:` icon name).
3. Drag items into the group, or pick the group from the menu next to an item.
4. Click **Save**.

Admins see **My sidebar** and **Default for everyone** at the top of the
editor. **Use default layout** removes your own layout so the shared default
applies again.

You can also open the editor from the browser console with
`sidebarGroups.openEditor()`.

Settings, Notifications and your profile stay pinned at the bottom of the
sidebar, as in stock Home Assistant. They can't be put into groups.

## Theming

These optional theme variables are supported:

| Variable | What it changes | Default |
| --- | --- | --- |
| `sidebar-groups-indent` | How far items inside a group are indented | `14px` |
| `sidebar-groups-guide-color` | The thin line beside a group's items | `divider-color` |

Everything else uses Home Assistant's own sidebar theme variables
(`sidebar-icon-color`, `sidebar-text-color`, `sidebar-selected-icon-color`, …).

## How it's stored

| Where | Key | Holds |
| --- | --- | --- |
| User data (per user) | `sidebar_groups` | Your layout |
| System data (admins) | `sidebar_groups` | Default layout for everyone |
| Browser `localStorage` | `sidebar-groups:open` | Which groups are open on this device |

A layout looks like this:

```json
{
  "version": 1,
  "ungrouped": "top",
  "groups": [
    {
      "id": "gk2x9a1",
      "name": "Admin",
      "icon": "mdi:shield-account",
      "collapsed": true,
      "items": ["hacs", "developer-tools"]
    }
  ]
}
```

## Uninstall

Remove the integration under **Settings → Devices & services**, then remove it
in HACS and restart. Saved layouts stay in storage, so adding it back restores
them.
