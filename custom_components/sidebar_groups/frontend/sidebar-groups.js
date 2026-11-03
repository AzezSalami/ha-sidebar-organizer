/*
 * Sidebar Groups for Home Assistant
 *
 * Fills the sidebar's built-in "main-navigation" slot with grouped, collapsible
 * panel items. Home Assistant's own sidebar rendering is never patched or
 * rewritten: if this module fails, the stock panel list (the slot's fallback
 * content) simply shows again.
 *
 * Layouts are stored with Home Assistant's frontend storage:
 *   user data   "sidebar_groups"  -> this user's layout (synced across devices)
 *   system data "sidebar_groups"  -> default layout for everyone (admins edit it)
 * Which groups are open is remembered per device in localStorage.
 */

const VERSION = "1.0.0";
const DATA_KEY = "sidebar_groups";
const OPEN_KEY = "sidebar-groups:open";
const FIXED_PANELS = ["profile", "config", "notfound"];
const DEFAULT_GROUP_ICON = "mdi:folder-outline";
const LONG_PRESS_MS = 550;

// Built-in panels have no icon of their own; HA draws them from bundled paths.
const BUILT_IN_ICONS = {
  calendar: "mdi:calendar",
  energy: "mdi:lightning-bolt",
  history: "mdi:chart-box",
  logbook: "mdi:format-list-bulleted-type",
  map: "mdi:map",
  "media-browser": "mdi:play-box-multiple",
  todo: "mdi:clipboard-list",
  home: "mdi:home",
  lovelace: "mdi:view-dashboard",
};

// HA's own default ordering for built-in panels.
const SORT_VALUE_URL_PATHS = { energy: 1, map: 2, logbook: 3, history: 4 };

const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]
  );

const newId = () => "g" + Math.random().toString(36).slice(2, 9);

const isTouch = () => window.matchMedia("(pointer: coarse)").matches;

/* ------------------------------------------------------------------------ */
/* Layout model                                                             */
/* ------------------------------------------------------------------------ */

const normalizeLayout = (value) => {
  if (!value || typeof value !== "object" || !Array.isArray(value.groups)) {
    return null;
  }
  const seen = new Set();
  return {
    version: 1,
    ungrouped: value.ungrouped === "bottom" ? "bottom" : "top",
    groups: value.groups
      .filter((g) => g && typeof g === "object")
      .map((g) => ({
        id: typeof g.id === "string" && g.id ? g.id : newId(),
        name: typeof g.name === "string" && g.name.trim() ? g.name : "Group",
        icon: typeof g.icon === "string" && g.icon ? g.icon : DEFAULT_GROUP_ICON,
        collapsed: Boolean(g.collapsed),
        // A panel may only live in one group; the first one wins.
        items: (Array.isArray(g.items) ? g.items : []).filter((id) => {
          if (typeof id !== "string" || seen.has(id)) return false;
          seen.add(id);
          return true;
        }),
      })),
  };
};

const readOpenState = () => {
  try {
    return JSON.parse(localStorage.getItem(OPEN_KEY) || "{}") || {};
  } catch (e) {
    return {};
  }
};

const writeOpenState = (state) => {
  try {
    localStorage.setItem(OPEN_KEY, JSON.stringify(state));
  } catch (e) {
    /* storage unavailable: open state just won't persist */
  }
};

/* ------------------------------------------------------------------------ */
/* Controller: owns hass, subscriptions and the computed panel list         */
/* ------------------------------------------------------------------------ */

const SG = {
  hass: undefined,
  connection: undefined,
  sidebarData: undefined, // HA's own { panelOrder, hiddenPanels }
  userLayout: undefined, // undefined = not loaded yet, null = none saved
  systemLayout: undefined,
  navs: new Set(),
  _unsubs: [],

  setHass(hass) {
    if (!hass) return;
    this.hass = hass;
    if (hass.connection && hass.connection !== this.connection) {
      this._subscribe(hass.connection);
    }
  },

  _subscribe(connection) {
    this._unsubs.forEach((p) => p.then((u) => u()).catch(() => {}));
    this.connection = connection;
    const sub = (type, key, cb) =>
      connection.subscribeMessage(({ value }) => cb(value), { type, key });
    this._unsubs = [
      sub("frontend/subscribe_user_data", "sidebar", (v) => {
        this.sidebarData = v || {};
        this.refresh();
      }),
      sub("frontend/subscribe_user_data", DATA_KEY, (v) => {
        this.userLayout = normalizeLayout(v);
        this.refresh();
      }),
      sub("frontend/subscribe_system_data", DATA_KEY, (v) => {
        this.systemLayout = normalizeLayout(v);
        this.refresh();
      }),
    ];
    this._unsubs.forEach((p) =>
      p.catch(() => {
        // Older cores or restricted users: behave as if nothing is stored.
        if (this.userLayout === undefined) this.userLayout = null;
        if (this.systemLayout === undefined) this.systemLayout = null;
        this.refresh();
      })
    );
  },

  get ready() {
    return (
      this.hass?.panels &&
      this.sidebarData !== undefined &&
      this.userLayout !== undefined &&
      this.systemLayout !== undefined
    );
  },

  /** The layout in effect for this user, or null for HA's plain list. */
  get layout() {
    return this.userLayout || this.systemLayout || null;
  },

  get usingDefault() {
    return !this.userLayout && Boolean(this.systemLayout);
  },

  refresh() {
    this.navs.forEach((n) => n.refresh());
  },

  defaultPanel() {
    const hass = this.hass;
    let legacy = null;
    try {
      legacy = JSON.parse(localStorage.getItem("defaultPanel") || "null");
    } catch (e) {
      /* ignore */
    }
    const panel =
      hass.userData?.default_panel ||
      hass.systemData?.default_panel ||
      legacy ||
      "home";
    if (panel === "lovelace" && !hass.panels.lovelace?.config) return "home";
    return panel;
  },

  /** Mirrors computePanels() in HA's ha-sidebar.ts. */
  visiblePanels() {
    const hass = this.hass;
    const order = this.sidebarData?.panelOrder || [];
    const hidden = this.sidebarData?.hiddenPanels || [];
    const def = this.defaultPanel();
    const lang = hass.locale?.language || hass.language;
    const cmp = (a, b) =>
      (a || "").localeCompare(b || "", lang, { sensitivity: "accent" });
    const reverse = [...order].reverse();

    const list = Object.values(hass.panels).filter((p) => {
      if (FIXED_PANELS.includes(p.url_path)) return false;
      if (p.url_path === def) return true;
      return !(
        !p.title ||
        p.show_in_sidebar === false ||
        hidden.includes(p.url_path) ||
        (p.default_visible === false && !order.includes(p.url_path))
      );
    });

    const defaultSort = (a, b) => {
      if (a.url_path === def) return -1;
      if (b.url_path === def) return 1;
      const aL = a.component_name === "lovelace";
      const bL = b.component_name === "lovelace";
      if (aL && bL) return cmp(a.title, b.title);
      if (aL) return -1;
      if (bL) return 1;
      const aB = a.url_path in SORT_VALUE_URL_PATHS;
      const bB = b.url_path in SORT_VALUE_URL_PATHS;
      if (aB && bB)
        return SORT_VALUE_URL_PATHS[a.url_path] - SORT_VALUE_URL_PATHS[b.url_path];
      if (aB) return -1;
      if (bB) return 1;
      return cmp(a.title, b.title);
    };

    list.sort((a, b) => {
      const ia = reverse.indexOf(a.url_path);
      const ib = reverse.indexOf(b.url_path);
      if (ia !== ib) return ia < ib ? 1 : -1;
      return defaultSort(a, b);
    });

    return list.map((p) => ({
      id: p.url_path,
      title: hass.localize?.(`panel.${p.title}`) || p.title || p.url_path,
      icon: p.icon || BUILT_IN_ICONS[p.url_path] || "mdi:view-dashboard",
    }));
  },

  /** Splits visible panels into rendered sections according to the layout. */
  sections(layout = this.layout) {
    const panels = this.visiblePanels();
    const byId = new Map(panels.map((p) => [p.id, p]));
    if (!layout) return [{ type: "items", items: panels }];

    const grouped = new Set();
    const groups = layout.groups.map((g) => {
      const items = g.items.filter((id) => byId.has(id)).map((id) => byId.get(id));
      items.forEach((p) => grouped.add(p.id));
      return { type: "group", group: g, items };
    });
    const loose = {
      type: "items",
      items: panels.filter((p) => !grouped.has(p.id)),
    };
    return layout.ungrouped === "bottom" ? [...groups, loose] : [loose, ...groups];
  },

  async save(scope, layout) {
    await this.hass.callWS({
      type: scope === "system" ? "frontend/set_system_data" : "frontend/set_user_data",
      key: DATA_KEY,
      value: layout,
    });
  },

  openEditor() {
    let editor = document.querySelector("sidebar-groups-editor");
    if (!editor) {
      editor = document.createElement("sidebar-groups-editor");
      document.body.appendChild(editor);
    }
    editor.open();
  },
};

window.sidebarGroups = {
  version: VERSION,
  openEditor: () => SG.openEditor(),
};

/* ------------------------------------------------------------------------ */
/* Shared styles (copied from HA's ha-sidebar so items look native)         */
/* ------------------------------------------------------------------------ */

const NAV_STYLES = `
  :host { display: contents; }
  ha-list-item-button {
    flex-shrink: 0;
    margin: 0 var(--ha-space-1, 4px) var(--ha-space-1, 4px);
    border-radius: var(--ha-border-radius-sm, 8px);
    --ha-row-item-min-height: var(--ha-space-10, 40px);
    --ha-row-item-padding-block: 0;
    --ha-row-item-padding-inline: var(--ha-space-3, 12px);
    width: var(--ha-space-12, 48px);
    position: relative;
    transition: width var(--ha-animation-duration-normal, 250ms) ease,
      margin var(--ha-animation-duration-normal, 250ms) ease;
    box-sizing: border-box;
  }
  ha-list-item-button::part(headline) { color: var(--sidebar-text-color); }
  :host([expanded]) ha-list-item-button {
    width: var(--ha-sidebar-expanded-item-width, 248px);
  }
  :host([narrow][expanded]) ha-list-item-button {
    width: calc(240px - var(--safe-area-inset-left, 0px));
  }
  ha-list-item-button.selected::part(headline) {
    color: var(--sidebar-selected-icon-color);
  }
  ha-list-item-button.selected::before {
    border-radius: var(--ha-border-radius-sm, 8px);
    position: absolute;
    inset: 0;
    pointer-events: none;
    content: "";
    background-color: var(--sidebar-selected-icon-color);
    opacity: var(--dark-divider-opacity, 0.12);
  }
  ha-icon[slot="start"] {
    width: var(--ha-space-6, 24px);
    flex-shrink: 0;
    color: var(--sidebar-icon-color);
  }
  ha-list-item-button.selected ha-icon[slot="start"],
  ha-list-item-button.has-selected ha-icon[slot="start"] {
    color: var(--sidebar-selected-icon-color);
  }
  .item-text {
    display: block;
    max-width: 0;
    opacity: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    font-size: var(--ha-font-size-m, 14px);
    font-weight: var(--ha-font-weight-medium, 500);
    transition: max-width var(--ha-animation-duration-normal, 250ms) ease,
      opacity var(--ha-animation-duration-normal, 250ms) ease;
  }
  :host([expanded]) .item-text {
    max-width: 100%;
    opacity: 1;
    transition-delay: 0ms, 80ms;
  }

  /* Group header */
  .group-header .chevron {
    --mdc-icon-size: 20px;
    color: var(--sidebar-icon-color);
    opacity: 0;
    transition: transform var(--ha-animation-duration-normal, 250ms) ease,
      opacity var(--ha-animation-duration-normal, 250ms) ease;
  }
  :host([expanded]) .group-header .chevron { opacity: 1; }
  .group.open .group-header .chevron { transform: rotate(180deg); }
  .group-header .item-text {
    font-weight: var(--ha-font-weight-bold, 600);
  }
  /* Small corner mark so groups read as groups when only icons show. */
  .group-header::after {
    content: "";
    position: absolute;
    inset-inline-end: 5px;
    bottom: 5px;
    width: 0;
    height: 0;
    border-inline-start: 6px solid transparent;
    border-bottom: 6px solid var(--sidebar-icon-color);
    opacity: 0.8;
    transition: opacity var(--ha-animation-duration-normal, 250ms) ease;
    pointer-events: none;
  }
  :host([expanded]) .group-header::after { opacity: 0; }
  .group-header.has-selected::after {
    border-bottom-color: var(--sidebar-selected-icon-color);
  }

  /* Group children: animated open/close with a guide line. */
  .group-items {
    display: grid;
    grid-template-rows: 0fr;
    transition: grid-template-rows var(--ha-animation-duration-normal, 250ms) ease;
  }
  .group-items > .inner {
    min-height: 0;
    overflow: hidden;
    position: relative;
    display: flex;
    flex-direction: column;
  }
  :host([expanded]) .group.open .group-items { grid-template-rows: 1fr; }
  :host([expanded]) .group-items ha-list-item-button {
    margin-inline-start: calc(var(--ha-space-1, 4px) + var(--sidebar-groups-indent, 14px));
    width: calc(var(--ha-sidebar-expanded-item-width, 248px) - var(--sidebar-groups-indent, 14px));
  }
  :host([narrow][expanded]) .group-items ha-list-item-button {
    width: calc(240px - var(--safe-area-inset-left, 0px) - var(--sidebar-groups-indent, 14px));
  }
  .group-items > .inner::before {
    content: "";
    position: absolute;
    inset-inline-start: calc(var(--ha-space-1, 4px) + 23px);
    top: 0;
    bottom: calc(var(--ha-space-1, 4px) + 6px);
    width: 1px;
    background: var(--sidebar-groups-guide-color, var(--divider-color));
  }

  @media (prefers-reduced-motion: reduce) {
    ha-list-item-button, .item-text, .group-items, .chevron { transition: 1ms; }
  }
`;

/* ------------------------------------------------------------------------ */
/* <sidebar-groups-nav>: slotted into ha-sidebar's main-navigation          */
/* ------------------------------------------------------------------------ */

class SidebarGroupsNav extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._open = readOpenState();
    this._userClosed = new Set(); // closed by hand since the last navigation
    this._lastPanel = undefined;
    this._signature = "";
    this._swallowClick = false;
    this._pressTimer = undefined;
    this._pressStart = undefined;

    this.shadowRoot.addEventListener("click", (ev) => this._onClick(ev));
    this.addEventListener(
      "click",
      (ev) => {
        if (this._swallowClick) {
          ev.preventDefault();
          ev.stopPropagation();
          this._swallowClick = false;
        }
      },
      true
    );
    this.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      clearTimeout(this._pressTimer);
      SG.openEditor();
    });
    this.addEventListener("pointerdown", (ev) => this._onPointerDown(ev));
    const cancel = () => clearTimeout(this._pressTimer);
    this.addEventListener("pointerup", cancel);
    this.addEventListener("pointercancel", cancel);
    this.addEventListener("pointermove", (ev) => {
      if (
        this._pressStart &&
        Math.hypot(ev.clientX - this._pressStart.x, ev.clientY - this._pressStart.y) > 10
      ) {
        cancel();
      }
    });
  }

  connectedCallback() {
    SG.navs.add(this);
    this.refresh();
  }

  disconnectedCallback() {
    SG.navs.delete(this);
  }

  attach(sidebar) {
    if (this.sidebar === sidebar) return;
    this.sidebar = sidebar;
    this._observer?.disconnect();
    this._observer = new MutationObserver(() => this.refresh());
    this._observer.observe(sidebar, { attributes: true, attributeFilter: ["expanded", "narrow"] });
  }

  _onPointerDown(ev) {
    if (ev.button !== 0 || ev.pointerType === "mouse") return;
    this._pressStart = { x: ev.clientX, y: ev.clientY };
    clearTimeout(this._pressTimer);
    this._pressTimer = setTimeout(() => {
      this._swallowClick = true;
      setTimeout(() => (this._swallowClick = false), 800);
      SG.openEditor();
    }, LONG_PRESS_MS);
  }

  _isOpen(group) {
    if (this._userClosed.has(group.id)) return false;
    if (group.id in this._open) return this._open[group.id];
    return !group.collapsed;
  }

  refresh() {
    const sidebar = this.sidebar;
    if (!sidebar || !SG.ready) return;
    const expanded = sidebar.hasAttribute("expanded");
    const narrow = sidebar.hasAttribute("narrow");
    this.toggleAttribute("expanded", expanded);
    this.toggleAttribute("narrow", narrow);

    const hass = SG.hass;
    const selected = hass.panelUrl;
    if (selected !== this._lastPanel) {
      this._lastPanel = selected;
      this._userClosed.clear();
    }

    const sections = SG.sections();
    const tooltips = !sidebar.alwaysExpand && !isTouch();
    const signature = JSON.stringify([
      sections.map((s) => [s.group, s.items]),
      selected,
      tooltips,
      this._open,
      [...this._userClosed],
    ]);
    if (signature === this._signature) return;
    this._signature = signature;
    this._render(sections, selected, tooltips);
  }

  _renderItem(p, selected, tooltips, extraClass = "") {
    const id = `sg-panel-${p.id}`;
    return `
      <ha-list-item-button href="/${esc(p.id)}" id="${esc(id)}"
        class="${p.id === selected ? "selected" : ""} ${extraClass}"
        data-panel="${esc(p.id)}">
        <ha-icon slot="start" icon="${esc(p.icon)}"></ha-icon>
        <span class="item-text" slot="headline">${esc(p.title)}</span>
      </ha-list-item-button>
      ${tooltips ? this._tooltip(id, p.title) : ""}`;
  }

  _tooltip(id, text) {
    return `<ha-tooltip for="${esc(id)}" show-delay="0" hide-delay="0" placement="right">${esc(
      text
    )}</ha-tooltip>`;
  }

  _render(sections, selected, tooltips) {
    const html = sections
      .map((s) => {
        if (s.type === "items") {
          return s.items.map((p) => this._renderItem(p, selected, tooltips)).join("");
        }
        if (!s.items.length) return "";
        const g = s.group;
        const hasSelected = s.items.some((p) => p.id === selected);
        // The group holding the current page opens unless closed by hand.
        const open =
          !this._userClosed.has(g.id) && (hasSelected || this._isOpen(g));
        const headerId = `sg-group-${g.id}`;
        return `
          <div class="group ${open ? "open" : ""} ${hasSelected ? "has-selected" : ""}"
            data-group="${esc(g.id)}">
            <ha-list-item-button class="group-header ${hasSelected ? "has-selected" : ""}"
              id="${esc(headerId)}" aria-expanded="${open}">
              <ha-icon slot="start" icon="${esc(g.icon)}"></ha-icon>
              <span class="item-text" slot="headline">${esc(g.name)}</span>
              <ha-icon class="chevron" slot="end" icon="mdi:chevron-down"></ha-icon>
            </ha-list-item-button>
            ${tooltips ? this._tooltip(headerId, g.name) : ""}
            <div class="group-items" ${open ? "" : "inert"}>
              <div class="inner">
                ${s.items.map((p) => this._renderItem(p, selected, tooltips)).join("")}
              </div>
            </div>
          </div>`;
      })
      .join("");
    this.shadowRoot.innerHTML = `<style>${NAV_STYLES}</style>${html}`;
  }

  _onClick(ev) {
    const header = ev
      .composedPath()
      .find((n) => n.classList?.contains("group-header"));
    if (!header) return;
    ev.preventDefault();
    const groupEl = header.closest(".group");
    const id = groupEl.dataset.group;
    const group = SG.layout?.groups.find((g) => g.id === id);
    if (!group) return;

    // Icon-only sidebar: show the group's items in a pop-out menu.
    if (!this.hasAttribute("expanded")) {
      SidebarGroupsFlyout.show(header, group, SG.sections().find((s) => s.group?.id === id).items);
      return;
    }

    const isOpen = groupEl.classList.contains("open");
    if (isOpen) {
      this._userClosed.add(id);
      this._open[id] = false;
    } else {
      this._userClosed.delete(id);
      this._open[id] = true;
    }
    writeOpenState(this._open);
    // Toggle in place so the height animates, then sync the signature.
    groupEl.classList.toggle("open", !isOpen);
    header.setAttribute("aria-expanded", String(!isOpen));
    groupEl.querySelector(".group-items").toggleAttribute("inert", isOpen);
    this._signature = "";
    clearTimeout(this._syncTimer);
    this._syncTimer = setTimeout(() => this.refresh(), 300);
  }
}

/* ------------------------------------------------------------------------ */
/* Pop-out menu for groups when the sidebar shows icons only                */
/* ------------------------------------------------------------------------ */

class SidebarGroupsFlyout extends HTMLElement {
  static show(anchor, group, items) {
    let el = document.querySelector("sidebar-groups-flyout");
    if (!el) {
      el = document.createElement("sidebar-groups-flyout");
      document.body.appendChild(el);
    }
    el._show(anchor, group, items);
  }

  connectedCallback() {
    if (!this.hasAttribute("popover")) this.setAttribute("popover", "auto");
  }

  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this.addEventListener("click", (ev) => {
      if (ev.composedPath().some((n) => n.tagName === "A")) {
        setTimeout(() => this.hidePopover(), 0);
      }
    });
  }

  _show(anchor, group, items) {
    const selected = SG.hass?.panelUrl;
    this.shadowRoot.innerHTML = `
      <style>
        :host {
          margin: 0;
          inset: auto;
          padding: 6px;
          border: 1px solid var(--divider-color);
          border-radius: var(--ha-border-radius-lg, 12px);
          background: var(--card-background-color, var(--sidebar-background-color, #fff));
          color: var(--primary-text-color);
          box-shadow: var(--ha-box-shadow-l, 0 8px 24px rgba(0,0,0,.2));
          min-width: 200px;
          max-width: 320px;
          max-height: 70vh;
          overflow: auto;
          font-family: var(--ha-font-family-body, Roboto, sans-serif);
        }
        .title {
          padding: 6px 10px 8px;
          font-size: var(--ha-font-size-s, 12px);
          font-weight: var(--ha-font-weight-bold, 600);
          color: var(--secondary-text-color);
          text-transform: uppercase;
          letter-spacing: .04em;
        }
        a {
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 0 10px;
          height: 40px;
          border-radius: var(--ha-border-radius-sm, 8px);
          text-decoration: none;
          color: var(--sidebar-text-color, var(--primary-text-color));
          font-size: var(--ha-font-size-m, 14px);
          font-weight: var(--ha-font-weight-medium, 500);
          position: relative;
        }
        a:hover, a:focus-visible { background: var(--secondary-background-color); outline: none; }
        a ha-icon { color: var(--sidebar-icon-color); flex-shrink: 0; }
        a.selected { color: var(--sidebar-selected-icon-color); }
        a.selected ha-icon { color: var(--sidebar-selected-icon-color); }
        a.selected::before {
          content: ""; position: absolute; inset: 0; border-radius: inherit;
          background: var(--sidebar-selected-icon-color);
          opacity: var(--dark-divider-opacity, .12);
        }
        span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      </style>
      <div class="title">${esc(group.name)}</div>
      ${items
        .map(
          (p) => `<a href="/${esc(p.id)}" class="${p.id === selected ? "selected" : ""}">
            <ha-icon icon="${esc(p.icon)}"></ha-icon><span>${esc(p.title)}</span></a>`
        )
        .join("")}`;
    const r = anchor.getBoundingClientRect();
    const rtl = getComputedStyle(anchor).direction === "rtl";
    this.style.top = `${Math.max(8, r.top - 6)}px`;
    if (rtl) {
      this.style.right = `${window.innerWidth - r.left + 8}px`;
      this.style.left = "auto";
    } else {
      this.style.left = `${r.right + 8}px`;
      this.style.right = "auto";
    }
    try {
      this.showPopover();
    } catch (e) {
      /* already open */
    }
    // Keep it on screen.
    const h = this.getBoundingClientRect().height;
    if (r.top - 6 + h > window.innerHeight - 8) {
      this.style.top = `${Math.max(8, window.innerHeight - 8 - h)}px`;
    }
    this.shadowRoot.querySelector("a")?.focus();
  }
}

/* ------------------------------------------------------------------------ */
/* <sidebar-groups-editor>: modal editor                                    */
/* ------------------------------------------------------------------------ */

const EDITOR_STYLES = `
  dialog {
    width: min(560px, calc(100vw - 32px));
    max-height: calc(100vh - 48px);
    padding: 0;
    border: none;
    border-radius: var(--ha-border-radius-xl, 24px);
    background: var(--card-background-color, #fff);
    color: var(--primary-text-color);
    font-family: var(--ha-font-family-body, Roboto, sans-serif);
    box-shadow: var(--ha-box-shadow-l, 0 12px 40px rgba(0,0,0,.3));
    overflow: hidden;
  }
  dialog[open] { display: flex; flex-direction: column; }
  dialog::backdrop { background: rgba(0, 0, 0, 0.4); }
  header {
    display: flex; align-items: center; gap: 8px;
    padding: 16px 16px 8px 24px;
  }
  h2 { flex: 1; margin: 0; font-size: 20px; font-weight: var(--ha-font-weight-normal, 400); }
  .body { overflow: auto; padding: 4px 24px 16px; }
  footer {
    display: flex; gap: 8px; align-items: center;
    padding: 12px 24px 20px;
    border-top: 1px solid var(--divider-color);
  }
  footer .spacer { flex: 1; }
  .hint { color: var(--secondary-text-color); font-size: 13px; margin: 0 0 12px; line-height: 1.4; }
  .scope { display: flex; gap: 0; margin: 4px 0 12px; border: 1px solid var(--divider-color); border-radius: 999px; overflow: hidden; width: fit-content; }
  .scope button { border-radius: 0; border: none; padding: 6px 14px; }
  .scope button[aria-pressed="true"] { background: var(--primary-color); color: var(--text-primary-color, #fff); }
  button {
    font: inherit; font-size: 14px; font-weight: 500; cursor: pointer;
    border-radius: 999px; padding: 8px 16px;
    border: 1px solid var(--divider-color);
    background: transparent; color: var(--primary-text-color);
  }
  button.primary { background: var(--primary-color); color: var(--text-primary-color, #fff); border-color: var(--primary-color); }
  button.danger { color: var(--error-color, #db4437); }
  button:disabled { opacity: .5; cursor: default; }
  button.icon {
    padding: 0; width: 32px; height: 32px; border: none; display: inline-flex;
    align-items: center; justify-content: center; border-radius: 50%;
    color: var(--secondary-text-color); --mdc-icon-size: 20px; flex-shrink: 0;
  }
  button.icon:hover:not(:disabled) { background: var(--secondary-background-color); }
  button.add { width: 100%; border-style: dashed; margin-top: 4px; }
  .card {
    border: 1px solid var(--divider-color);
    border-radius: var(--ha-border-radius-lg, 12px);
    margin-bottom: 12px;
    background: var(--card-background-color);
  }
  .card-head {
    display: flex; gap: 8px; align-items: center;
    padding: 8px 8px 8px 12px;
    border-bottom: 1px solid var(--divider-color);
    flex-wrap: wrap;
  }
  .card-head .name { flex: 1 1 140px; }
  .card-head .icon-field { flex: 0 1 170px; display: flex; align-items: center; gap: 6px; }
  .card-head .icon-field ha-icon { color: var(--secondary-text-color); }
  input[type="text"], select {
    font: inherit; font-size: 14px; color: var(--primary-text-color);
    background: var(--secondary-background-color, transparent);
    border: 1px solid transparent; border-radius: 8px; padding: 6px 8px;
    min-width: 0; width: 100%; box-sizing: border-box;
  }
  input[type="text"]:focus, select:focus { outline: none; border-color: var(--primary-color); }
  input.name { font-weight: 600; }
  .options { display: flex; align-items: center; gap: 6px; font-size: 13px; color: var(--secondary-text-color); padding: 6px 12px; border-bottom: 1px solid var(--divider-color); }
  .items { min-height: 44px; padding: 4px 0; }
  .items.drop-target { background: color-mix(in srgb, var(--primary-color) 8%, transparent); }
  .empty { color: var(--secondary-text-color); font-size: 13px; padding: 12px; text-align: center; }
  .row {
    display: flex; align-items: center; gap: 8px;
    padding: 2px 6px 2px 4px; min-height: 40px;
    position: relative;
  }
  .row .handle { cursor: grab; color: var(--secondary-text-color); --mdc-icon-size: 20px; display: flex; touch-action: none; }
  .row > ha-icon.panel-icon { color: var(--sidebar-icon-color, var(--secondary-text-color)); flex-shrink: 0; }
  .row .title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; }
  .row select { width: auto; max-width: 130px; padding: 4px 6px; font-size: 13px; }
  .row.dragging { opacity: .4; }
  .row.drop-before::before, .row.drop-after::after {
    content: ""; position: absolute; left: 8px; right: 8px; height: 2px;
    background: var(--primary-color); border-radius: 2px;
  }
  .row.drop-before::before { top: -1px; }
  .row.drop-after::after { bottom: -1px; }
  .loose-head { font-weight: 600; flex: 1; padding: 6px 0; }
  .error { color: var(--error-color, #db4437); font-size: 13px; }
  @media (max-width: 480px) {
    .body { padding: 4px 12px 12px; }
    header { padding-left: 16px; }
    footer { padding: 12px 16px 16px; flex-wrap: wrap; }
  }
`;

class SidebarGroupsEditor extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._drag = undefined;
  }

  open() {
    if (!SG.ready) return;
    this._isAdmin = Boolean(SG.hass.user?.is_admin);
    this._scope = "user";
    this._error = "";
    this._load();
    this._render();
    const dialog = this.shadowRoot.querySelector("dialog");
    if (!dialog.open) dialog.showModal();
  }

  _load() {
    const source =
      this._scope === "system" ? SG.systemLayout : SG.userLayout || SG.systemLayout;
    const layout = source
      ? JSON.parse(JSON.stringify(source))
      : { version: 1, ungrouped: "top", groups: [] };
    this._panels = SG.visiblePanels();
    this._byId = new Map(this._panels.map((p) => [p.id, p]));
    // Panels that exist but aren't visible right now (hidden in HA's own
    // sidebar settings, or admin-only): keep them where they were on save.
    this._kept = new Map(
      layout.groups.map((g) => [g.id, g.items.filter((id) => !this._byId.has(id))])
    );
    layout.groups.forEach((g) => (g.items = g.items.filter((id) => this._byId.has(id))));
    this._layout = layout;
    this._dirty = false;
  }

  _loose() {
    const grouped = new Set(this._layout.groups.flatMap((g) => g.items));
    return this._panels.filter((p) => !grouped.has(p.id)).map((p) => p.id);
  }

  _close() {
    this.shadowRoot.querySelector("dialog")?.close();
  }

  _render() {
    const L = this._layout;
    const groups = L.groups;
    const scopeNote =
      this._scope === "system"
        ? "This layout is used by everyone who hasn't made their own."
        : SG.usingDefault
          ? "You're using the shared default layout. Saving here gives you your own copy."
          : "Only you will see this layout, on all your devices.";

    const moveOptions = (current) =>
      `<option value="">Ungrouped</option>` +
      groups
        .map(
          (g) =>
            `<option value="${esc(g.id)}" ${g.id === current ? "selected" : ""}>${esc(g.name)}</option>`
        )
        .join("");

    const row = (id, groupId, index, count) => {
      const p = this._byId.get(id);
      return `
        <div class="row" draggable="true" data-id="${esc(id)}" data-group="${esc(groupId)}">
          <span class="handle" title="Drag to move"><ha-icon icon="mdi:drag-vertical"></ha-icon></span>
          <ha-icon class="panel-icon" icon="${esc(p.icon)}"></ha-icon>
          <span class="title">${esc(p.title)}</span>
          <select data-action="move-to" aria-label="Move ${esc(p.title)} to">${moveOptions(groupId)}</select>
          ${
            groupId
              ? `<button class="icon" data-action="item-up" ${index === 0 ? "disabled" : ""} aria-label="Move up"><ha-icon icon="mdi:arrow-up"></ha-icon></button>
          <button class="icon" data-action="item-down" ${index === count - 1 ? "disabled" : ""} aria-label="Move down"><ha-icon icon="mdi:arrow-down"></ha-icon></button>`
              : `<span style="width:72px;flex-shrink:0"></span>`
          }
        </div>`;
    };

    const itemsBlock = (ids, groupId) =>
      `<div class="items" data-group="${esc(groupId)}">
        ${ids.length ? ids.map((id, i) => row(id, groupId, i, ids.length)).join("") : `<div class="empty">Drag items here, or use the menu next to an item</div>`}
      </div>`;

    const loose = this._loose();
    const looseCard = `
      <div class="card">
        <div class="card-head">
          <span class="loose-head">Ungrouped</span>
          <select data-action="ungrouped-pos" aria-label="Where ungrouped items appear" style="width:auto">
            <option value="top" ${L.ungrouped === "top" ? "selected" : ""}>Above groups</option>
            <option value="bottom" ${L.ungrouped === "bottom" ? "selected" : ""}>Below groups</option>
          </select>
        </div>
        ${itemsBlock(loose, "")}
      </div>`;

    const groupCards = groups
      .map(
        (g, gi) => `
        <div class="card" data-gid="${esc(g.id)}">
          <div class="card-head">
            <span class="icon-field">
              <ha-icon icon="${esc(g.icon)}"></ha-icon>
              <input type="text" data-field="icon" value="${esc(g.icon)}" placeholder="mdi:folder" aria-label="Group icon">
            </span>
            <input type="text" class="name" data-field="name" value="${esc(g.name)}" aria-label="Group name">
            <button class="icon" data-action="group-up" ${gi === 0 ? "disabled" : ""} aria-label="Move group up"><ha-icon icon="mdi:arrow-up"></ha-icon></button>
            <button class="icon" data-action="group-down" ${gi === groups.length - 1 ? "disabled" : ""} aria-label="Move group down"><ha-icon icon="mdi:arrow-down"></ha-icon></button>
            <button class="icon" data-action="group-delete" aria-label="Delete group"><ha-icon icon="mdi:delete-outline"></ha-icon></button>
          </div>
          <label class="options">
            <input type="checkbox" data-field="collapsed" ${g.collapsed ? "checked" : ""}>
            Start collapsed
          </label>
          ${itemsBlock(g.items, g.id)}
        </div>`
      )
      .join("");

    const resetLabel =
      this._scope === "system" ? "Clear default" : "Use default layout";
    const canReset =
      this._scope === "system" ? Boolean(SG.systemLayout) : Boolean(SG.userLayout);

    const scrollTop = this.shadowRoot.querySelector(".body")?.scrollTop || 0;
    const existing = this.shadowRoot.querySelector("dialog");
    const inner = `
      <header>
        <h2>Sidebar groups</h2>
        <button class="icon" data-action="close" aria-label="Close"><ha-icon icon="mdi:close"></ha-icon></button>
      </header>
      <div class="body">
        ${
          this._isAdmin
            ? `<div class="scope" role="group" aria-label="Which layout to edit">
                <button data-action="scope-user" aria-pressed="${this._scope === "user"}">My sidebar</button>
                <button data-action="scope-system" aria-pressed="${this._scope === "system"}">Default for everyone</button>
              </div>`
            : ""
        }
        <p class="hint">${scopeNote} To hide panels or change Home Assistant's own order, long-press the sidebar title.</p>
        ${L.ungrouped === "top" ? looseCard : ""}
        ${groupCards}
        <button class="add" data-action="group-add"><ha-icon icon="mdi:plus" style="--mdc-icon-size:18px;vertical-align:-3px"></ha-icon> Add group</button>
        ${L.ungrouped === "bottom" ? `<div style="height:12px"></div>${looseCard}` : ""}
        ${this._error ? `<p class="error">${esc(this._error)}</p>` : ""}
      </div>
      <footer>
        <button class="danger" data-action="reset" ${canReset ? "" : "disabled"}>${resetLabel}</button>
        <span class="spacer"></span>
        <button data-action="close">Cancel</button>
        <button class="primary" data-action="save">Save</button>
      </footer>`;

    if (existing) {
      existing.innerHTML = inner;
    } else {
      this.shadowRoot.innerHTML = `<style>${EDITOR_STYLES}</style><dialog>${inner}</dialog>`;
      this._bind();
    }
    const body = this.shadowRoot.querySelector(".body");
    if (body) body.scrollTop = scrollTop;
  }

  _bind() {
    const root = this.shadowRoot;
    const dialog = root.querySelector("dialog");
    dialog.addEventListener("cancel", (ev) => {
      if (this._dirty && !confirm("Discard your changes?")) ev.preventDefault();
    });
    root.addEventListener("click", (ev) => this._onAction(ev));
    root.addEventListener("change", (ev) => this._onChange(ev));
    root.addEventListener("input", (ev) => this._onInput(ev));
    root.addEventListener("dragstart", (ev) => this._onDragStart(ev));
    root.addEventListener("dragover", (ev) => this._onDragOver(ev));
    root.addEventListener("dragleave", (ev) => {
      if (ev.target.classList?.contains("items")) ev.target.classList.remove("drop-target");
    });
    root.addEventListener("drop", (ev) => this._onDrop(ev));
    root.addEventListener("dragend", () => this._clearDrag());
  }

  _group(id) {
    return this._layout.groups.find((g) => g.id === id);
  }

  _listFor(groupId) {
    return groupId ? this._group(groupId).items : null;
  }

  /** Moves a panel to a group ("" = ungrouped) at an index (default: end). */
  _move(id, toGroup, index) {
    this._layout.groups.forEach((g) => {
      const i = g.items.indexOf(id);
      if (i >= 0) g.items.splice(i, 1);
    });
    if (toGroup) {
      const items = this._group(toGroup).items;
      items.splice(index ?? items.length, 0, id);
    }
    this._dirty = true;
  }

  async _onAction(ev) {
    const btn = ev.composedPath().find((n) => n.dataset?.action && n.tagName === "BUTTON");
    if (!btn) return;
    const action = btn.dataset.action;
    const card = btn.closest(".card");
    const g = card?.dataset.gid ? this._group(card.dataset.gid) : undefined;
    const row = btn.closest(".row");
    const groups = this._layout.groups;

    switch (action) {
      case "close":
        if (this._dirty && !confirm("Discard your changes?")) return;
        this._close();
        return;
      case "scope-user":
      case "scope-system": {
        const scope = action === "scope-user" ? "user" : "system";
        if (scope === this._scope) return;
        if (this._dirty && !confirm("Discard your changes?")) return;
        this._scope = scope;
        this._load();
        break;
      }
      case "group-add":
        groups.push({ id: newId(), name: "New group", icon: DEFAULT_GROUP_ICON, collapsed: false, items: [] });
        this._dirty = true;
        this._render();
        this.shadowRoot.querySelector(`.card[data-gid="${groups[groups.length - 1].id}"] input.name`)?.select();
        return;
      case "group-up":
      case "group-down": {
        const i = groups.indexOf(g);
        const j = action === "group-up" ? i - 1 : i + 1;
        [groups[i], groups[j]] = [groups[j], groups[i]];
        this._dirty = true;
        break;
      }
      case "group-delete":
        if (g.items.length && !confirm(`Delete "${g.name}"? Its items become ungrouped.`)) return;
        groups.splice(groups.indexOf(g), 1);
        this._dirty = true;
        break;
      case "item-up":
      case "item-down": {
        const list = this._listFor(row.dataset.group);
        const i = list.indexOf(row.dataset.id);
        const j = action === "item-up" ? i - 1 : i + 1;
        [list[i], list[j]] = [list[j], list[i]];
        this._dirty = true;
        break;
      }
      case "reset":
        if (!confirm(this._scope === "system" ? "Remove the default layout for everyone?" : "Remove your layout and use the default?")) return;
        await this._persist(null);
        return;
      case "save":
        await this._persist(this._serialize());
        return;
      default:
        return;
    }
    this._render();
  }

  _onChange(ev) {
    const t = ev.target;
    const action = t.dataset?.action;
    if (action === "move-to") {
      const row = t.closest(".row");
      this._move(row.dataset.id, t.value);
      this._render();
    } else if (action === "ungrouped-pos") {
      this._layout.ungrouped = t.value;
      this._dirty = true;
      this._render();
    } else if (t.dataset?.field === "collapsed") {
      this._group(t.closest(".card").dataset.gid).collapsed = t.checked;
      this._dirty = true;
    }
  }

  _onInput(ev) {
    const t = ev.target;
    const field = t.dataset?.field;
    if (field !== "name" && field !== "icon") return;
    const g = this._group(t.closest(".card").dataset.gid);
    g[field] = t.value;
    this._dirty = true;
    if (field === "icon") {
      t.parentElement.querySelector("ha-icon").setAttribute("icon", t.value || DEFAULT_GROUP_ICON);
    } else {
      // Keep the "move to" menus in sync without a full re-render.
      this.shadowRoot
        .querySelectorAll(`select[data-action="move-to"] option[value="${CSS.escape(g.id)}"]`)
        .forEach((o) => (o.textContent = t.value || "Group"));
    }
  }

  _onDragStart(ev) {
    const row = ev.target.closest?.(".row");
    if (!row) return;
    this._drag = { id: row.dataset.id };
    ev.dataTransfer.effectAllowed = "move";
    ev.dataTransfer.setData("text/plain", row.dataset.id);
    requestAnimationFrame(() => row.classList.add("dragging"));
  }

  _dropPoint(ev) {
    const list = ev.composedPath().find((n) => n.classList?.contains("items"));
    if (!list) return undefined;
    const rows = [...list.querySelectorAll(".row:not(.dragging)")];
    let index = rows.length;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i].getBoundingClientRect();
      if (ev.clientY < r.top + r.height / 2) {
        index = i;
        break;
      }
    }
    return { list, rows, index };
  }

  _onDragOver(ev) {
    if (!this._drag) return;
    const pt = this._dropPoint(ev);
    this._clearMarkers();
    if (!pt) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = "move";
    pt.list.classList.add("drop-target");
    if (!pt.list.dataset.group) return; // ungrouped follows HA order
    if (pt.index < pt.rows.length) pt.rows[pt.index].classList.add("drop-before");
    else pt.rows[pt.rows.length - 1]?.classList.add("drop-after");
  }

  _onDrop(ev) {
    if (!this._drag) return;
    const pt = this._dropPoint(ev);
    if (!pt) return;
    ev.preventDefault();
    const toGroup = pt.list.dataset.group;
    const ids = pt.rows.map((r) => r.dataset.id);
    // Index among the remaining items once the dragged one is removed.
    const before = ids.slice(0, pt.index).filter((id) => id !== this._drag.id).length;
    this._move(this._drag.id, toGroup, before);
    this._clearDrag();
    this._render();
  }

  _clearMarkers() {
    this.shadowRoot
      .querySelectorAll(".drop-before, .drop-after, .drop-target")
      .forEach((n) => n.classList.remove("drop-before", "drop-after", "drop-target"));
  }

  _clearDrag() {
    this._drag = undefined;
    this._clearMarkers();
    this.shadowRoot.querySelectorAll(".dragging").forEach((n) => n.classList.remove("dragging"));
  }

  _serialize() {
    return {
      version: 1,
      ungrouped: this._layout.ungrouped,
      groups: this._layout.groups.map((g) => ({
        id: g.id,
        name: g.name.trim() || "Group",
        icon: g.icon.trim() || DEFAULT_GROUP_ICON,
        collapsed: Boolean(g.collapsed),
        items: [...g.items, ...(this._kept.get(g.id) || [])],
      })),
    };
  }

  async _persist(value) {
    const buttons = this.shadowRoot.querySelectorAll("footer button");
    buttons.forEach((b) => (b.disabled = true));
    try {
      await SG.save(this._scope, value);
      this._dirty = false;
      this._close();
    } catch (err) {
      this._error = `Couldn't save: ${err?.message || err?.code || err}`;
      this._render();
    }
  }
}

/* ------------------------------------------------------------------------ */
/* Bootstrap                                                                */
/* ------------------------------------------------------------------------ */

if (!customElements.get("sidebar-groups-nav")) {
  customElements.define("sidebar-groups-nav", SidebarGroupsNav);
  customElements.define("sidebar-groups-flyout", SidebarGroupsFlyout);
  customElements.define("sidebar-groups-editor", SidebarGroupsEditor);

  const connect = (sidebar) => {
    if (!sidebar || !sidebar.hass) return;
    SG.setHass(sidebar.hass);
    let nav = sidebar.querySelector(":scope > sidebar-groups-nav");
    if (!nav) {
      nav = document.createElement("sidebar-groups-nav");
      nav.slot = "main-navigation";
      nav.attach(sidebar);
      sidebar.appendChild(nav);
    } else {
      nav.attach(sidebar);
      nav.refresh();
    }
  };

  const findSidebar = () =>
    document
      .querySelector("home-assistant, ha-demo")
      ?.shadowRoot?.querySelector("home-assistant-main")
      ?.shadowRoot?.querySelector("ha-sidebar");

  customElements.whenDefined("ha-sidebar").then(() => {
    const proto = customElements.get("ha-sidebar").prototype;
    const original = proto.updated;
    proto.updated = function (changedProps) {
      original.call(this, changedProps);
      try {
        connect(this);
      } catch (err) {
        // Never break HA's sidebar; the stock list stays visible.
        // eslint-disable-next-line no-console
        console.error("[sidebar-groups]", err);
      }
    };
    connect(findSidebar());
  });

  // eslint-disable-next-line no-console
  console.info(`%c SIDEBAR-GROUPS %c ${VERSION} `, "background:#03a9f4;color:#fff;font-weight:700", "");
}
