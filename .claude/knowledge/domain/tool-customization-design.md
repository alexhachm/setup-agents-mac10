# Tool Customization Design Document

> Phase 1 Research Output — Task #24
> Date: 2026-02-27

## 1. Research Summary

### DAS Trader Pro Customization Model

DAS Trader Pro provides per-window customization via **right-click → Configure** on each window. Key features:

- **Level 2 Montage**: 8 configurable tier color groups (RGB values), font selection, grid toggle, ECN display toggle
- **Market Viewer**: Column add/remove/reorder, background and row color customization, custom ticker lists
- **Time & Sales**: Custom time & sale colors
- **All Windows**: Font selection, background color, text color modifications
- **Persistence**: Settings saved per-desktop layout file; survives restart when properly configured

### thinkorswim Customization Model

- **Custom Column Sets**: Named, saveable sets of columns applicable across watchlists, option chains, stock hacker, etc.
- **Column Management**: Dual-panel interface (available vs. displayed), add/remove/reorder via drag or arrows
- **Font Size**: Application-wide font size selector in Application Settings
- **Row Height**: Per-panel dropdown with Automatic, Ticksize, and Custom options
- **Color Theming**: Configurable headers, symbol bars, table backgrounds, marked rows, selections, focus states, tooltips

### Grafana Dashboard JSON Model (Data Model Inspiration)

Grafana stores per-panel config in a structured JSON model:
- `gridPos`: Panel position and size (`x`, `y`, `w`, `h`)
- `fieldOverrides`: Per-field display customization
- `options`: Panel-specific display settings
- `schemaVersion`: Migration-friendly versioning

## 2. Current Codebase State

### Existing Panels

| Panel | Data Type | Current Columns/Fields |
|-------|-----------|----------------------|
| Workers | Cards | id, status, domain, current_task_id |
| Requests | List items | id, status, tier, description |
| Tasks | List items | id, status, subject, domain, tier, assigned_to, pr_url |
| Activity Log | Log entries | created_at (time), actor, action, details |

### Current Customization Surface

- **Right-click settings panel**: Already exists on panel headers (`.panel-header[data-panel]`)
- **Current menu items**: Only "Open in new window" (popout)
- **Popout system**: Independent windows per panel with own WebSocket connections
- **Settings persistence**: None currently (no localStorage or DB storage for panel settings)
- **Architecture**: Vanilla JS, single CSS file, no framework

### Key Extension Points

1. `openSettingsPanel()` in `app.js:442` — builds the right-click menu dynamically
2. `renderWorkers/Requests/Tasks/Log()` functions — render panel content with inline HTML
3. `styles.css` — all styling in one file with CSS variables potential
4. `/api/config` endpoint — existing config persistence in SQLite

## 3. Required Customization Features

### 3.1 Column Management (Data Panels: Workers, Requests, Tasks, Log)

- **Column visibility**: Toggle individual columns on/off
- **Column order**: Drag-and-drop or arrow-button reordering
- **Column width**: Resizable columns (drag column border or set fixed width)
- **Column presets**: Save/load named column configurations

### 3.2 Typography (Per-Panel)

- **Font size**: Adjustable per panel (range: 10px–18px, step: 1px)
- **Font family**: Choose between system/monospace/sans-serif
- **Font weight**: Normal or bold for data cells

### 3.3 Colors (Per-Panel)

- **Row background**: Default and alternating row colors
- **Text color**: Primary text color override
- **Accent color**: Badge/link color override
- **Border color**: Panel and item border color
- **Status badge colors**: Customizable per-status color mapping

### 3.4 Density & Spacing (Per-Panel)

- **Row height/padding**: Compact (6px), Default (10px), Comfortable (14px), Custom
- **Item spacing**: Gap between worker cards / request items / task items

### 3.5 Display Toggles (Per-Panel)

- **Show/hide panel borders**: Toggle item card borders
- **Show/hide grid lines**: Toggle separators between items
- **Compact mode**: Collapse secondary info (meta lines) per panel
- **Max visible items**: Configure how many items to show before scrolling

### 3.6 Sorting & Filtering (Data Panels)

- **Default sort column**: Per-panel sort preference
- **Sort direction**: Ascending/descending
- **Filter presets**: Show/hide by status (e.g., hide completed tasks)

## 4. Settings Data Model

### 4.1 Top-Level Schema

```json
{
  "schemaVersion": 1,
  "panels": {
    "workers": { /* PanelSettings */ },
    "requests": { /* PanelSettings */ },
    "tasks": { /* PanelSettings */ },
    "log": { /* PanelSettings */ }
  }
}
```

### 4.2 PanelSettings Schema

```json
{
  "columns": [
    {
      "key": "id",
      "label": "ID",
      "visible": true,
      "width": null,
      "align": "left"
    }
  ],
  "typography": {
    "fontSize": 13,
    "fontFamily": "system",
    "fontWeight": "normal"
  },
  "colors": {
    "rowBackground": null,
    "rowBackgroundAlt": null,
    "textColor": null,
    "accentColor": null,
    "borderColor": null,
    "statusColors": {}
  },
  "density": {
    "rowPadding": "default",
    "itemSpacing": 8
  },
  "display": {
    "showBorders": true,
    "showGridLines": false,
    "compactMode": false,
    "maxVisibleItems": null
  },
  "sorting": {
    "column": null,
    "direction": "asc"
  },
  "filters": {
    "hideStatuses": []
  }
}
```

### 4.3 Column Definitions Per Panel

#### Workers Panel
```json
[
  { "key": "id", "label": "Worker", "visible": true, "width": null, "align": "left" },
  { "key": "status", "label": "Status", "visible": true, "width": null, "align": "left" },
  { "key": "domain", "label": "Domain", "visible": true, "width": null, "align": "left" },
  { "key": "current_task_id", "label": "Task", "visible": true, "width": null, "align": "left" }
]
```

#### Requests Panel
```json
[
  { "key": "id", "label": "ID", "visible": true, "width": null, "align": "left" },
  { "key": "status", "label": "Status", "visible": true, "width": null, "align": "left" },
  { "key": "tier", "label": "Tier", "visible": true, "width": 50, "align": "center" },
  { "key": "description", "label": "Description", "visible": true, "width": null, "align": "left" },
  { "key": "created_at", "label": "Created", "visible": false, "width": null, "align": "left" }
]
```

#### Tasks Panel
```json
[
  { "key": "id", "label": "ID", "visible": true, "width": 50, "align": "left" },
  { "key": "status", "label": "Status", "visible": true, "width": null, "align": "left" },
  { "key": "subject", "label": "Subject", "visible": true, "width": null, "align": "left" },
  { "key": "domain", "label": "Domain", "visible": true, "width": null, "align": "left" },
  { "key": "tier", "label": "Tier", "visible": true, "width": 40, "align": "center" },
  { "key": "assigned_to", "label": "Worker", "visible": true, "width": null, "align": "left" },
  { "key": "pr_url", "label": "PR", "visible": true, "width": 40, "align": "center" },
  { "key": "priority", "label": "Priority", "visible": false, "width": null, "align": "left" },
  { "key": "created_at", "label": "Created", "visible": false, "width": null, "align": "left" }
]
```

#### Activity Log Panel
```json
[
  { "key": "created_at", "label": "Time", "visible": true, "width": 160, "align": "left" },
  { "key": "actor", "label": "Actor", "visible": true, "width": 100, "align": "left" },
  { "key": "action", "label": "Action", "visible": true, "width": null, "align": "left" },
  { "key": "details", "label": "Details", "visible": true, "width": null, "align": "left" }
]
```

### 4.4 Typography Defaults

```json
{
  "fontSize": 13,
  "fontFamily": "system",
  "fontWeight": "normal"
}
```

Valid `fontFamily` values: `"system"`, `"monospace"`, `"sans-serif"`
Valid `fontSize` range: `10` to `18` (pixels)
Valid `fontWeight` values: `"normal"`, `"bold"`

### 4.5 Color Overrides

All color values are nullable strings. When `null`, the existing CSS theme color applies.

```json
{
  "rowBackground": null,
  "rowBackgroundAlt": null,
  "textColor": null,
  "accentColor": null,
  "borderColor": null,
  "statusColors": {
    "idle": null,
    "assigned": null,
    "running": null,
    "completed": null,
    "pending": null,
    "busy": null,
    "resetting": null
  }
}
```

### 4.6 Density Presets

```json
{
  "rowPadding": "default",
  "itemSpacing": 8
}
```

Valid `rowPadding` values: `"compact"` (6px), `"default"` (10px), `"comfortable"` (14px), `"custom"`
When `"custom"`, an additional `"rowPaddingPx"` field is used (integer, 2–24).

### 4.7 Full Default Settings Object

```json
{
  "schemaVersion": 1,
  "panels": {
    "workers": {
      "columns": [
        { "key": "id", "label": "Worker", "visible": true, "width": null, "align": "left" },
        { "key": "status", "label": "Status", "visible": true, "width": null, "align": "left" },
        { "key": "domain", "label": "Domain", "visible": true, "width": null, "align": "left" },
        { "key": "current_task_id", "label": "Task", "visible": true, "width": null, "align": "left" }
      ],
      "typography": { "fontSize": 13, "fontFamily": "system", "fontWeight": "normal" },
      "colors": { "rowBackground": null, "rowBackgroundAlt": null, "textColor": null, "accentColor": null, "borderColor": null, "statusColors": {} },
      "density": { "rowPadding": "default", "itemSpacing": 8 },
      "display": { "showBorders": true, "showGridLines": false, "compactMode": false, "maxVisibleItems": null },
      "sorting": { "column": null, "direction": "asc" },
      "filters": { "hideStatuses": [] }
    },
    "requests": {
      "columns": [
        { "key": "id", "label": "ID", "visible": true, "width": null, "align": "left" },
        { "key": "status", "label": "Status", "visible": true, "width": null, "align": "left" },
        { "key": "tier", "label": "Tier", "visible": true, "width": 50, "align": "center" },
        { "key": "description", "label": "Description", "visible": true, "width": null, "align": "left" },
        { "key": "created_at", "label": "Created", "visible": false, "width": null, "align": "left" }
      ],
      "typography": { "fontSize": 13, "fontFamily": "system", "fontWeight": "normal" },
      "colors": { "rowBackground": null, "rowBackgroundAlt": null, "textColor": null, "accentColor": null, "borderColor": null, "statusColors": {} },
      "density": { "rowPadding": "default", "itemSpacing": 8 },
      "display": { "showBorders": true, "showGridLines": false, "compactMode": false, "maxVisibleItems": 20 },
      "sorting": { "column": null, "direction": "asc" },
      "filters": { "hideStatuses": [] }
    },
    "tasks": {
      "columns": [
        { "key": "id", "label": "ID", "visible": true, "width": 50, "align": "left" },
        { "key": "status", "label": "Status", "visible": true, "width": null, "align": "left" },
        { "key": "subject", "label": "Subject", "visible": true, "width": null, "align": "left" },
        { "key": "domain", "label": "Domain", "visible": true, "width": null, "align": "left" },
        { "key": "tier", "label": "Tier", "visible": true, "width": 40, "align": "center" },
        { "key": "assigned_to", "label": "Worker", "visible": true, "width": null, "align": "left" },
        { "key": "pr_url", "label": "PR", "visible": true, "width": 40, "align": "center" },
        { "key": "priority", "label": "Priority", "visible": false, "width": null, "align": "left" },
        { "key": "created_at", "label": "Created", "visible": false, "width": null, "align": "left" }
      ],
      "typography": { "fontSize": 13, "fontFamily": "system", "fontWeight": "normal" },
      "colors": { "rowBackground": null, "rowBackgroundAlt": null, "textColor": null, "accentColor": null, "borderColor": null, "statusColors": {} },
      "density": { "rowPadding": "default", "itemSpacing": 8 },
      "display": { "showBorders": true, "showGridLines": false, "compactMode": false, "maxVisibleItems": 30 },
      "sorting": { "column": null, "direction": "asc" },
      "filters": { "hideStatuses": ["completed"] }
    },
    "log": {
      "columns": [
        { "key": "created_at", "label": "Time", "visible": true, "width": 160, "align": "left" },
        { "key": "actor", "label": "Actor", "visible": true, "width": 100, "align": "left" },
        { "key": "action", "label": "Action", "visible": true, "width": null, "align": "left" },
        { "key": "details", "label": "Details", "visible": true, "width": null, "align": "left" }
      ],
      "typography": { "fontSize": 12, "fontFamily": "monospace", "fontWeight": "normal" },
      "colors": { "rowBackground": null, "rowBackgroundAlt": null, "textColor": null, "accentColor": null, "borderColor": null, "statusColors": {} },
      "density": { "rowPadding": "compact", "itemSpacing": 0 },
      "display": { "showBorders": false, "showGridLines": true, "compactMode": false, "maxVisibleItems": 50 },
      "sorting": { "column": "created_at", "direction": "desc" },
      "filters": { "hideStatuses": [] }
    }
  }
}
```

## 5. Persistence Strategy

### Option A: localStorage (Recommended for Phase 2)

- **Pro**: Zero backend changes, instant reads, no API latency
- **Pro**: Per-browser settings (useful when different displays have different preferences)
- **Con**: Lost on cache clear, not synced across browsers
- **Key**: `mac10_panel_settings`
- **Migration**: Check `schemaVersion` on load; apply migrations if needed

### Option B: SQLite (via API)

- **Pro**: Persistent across browsers, backed up with project
- **Con**: Requires new API endpoints, async read on page load
- **API**: `GET /api/panel-settings`, `PUT /api/panel-settings`
- **Table**: `panel_settings (id INTEGER PRIMARY KEY, settings_json TEXT, updated_at TEXT)`

### Recommendation

Start with **localStorage** (Option A) for simplicity. Add API sync later if users need cross-device settings.

## 6. UI Access Points

### 6.1 Right-Click Settings Panel (Existing)

Extend the existing `openSettingsPanel()` to add menu items:

```
┌─────────────────────────┐
│ WORKERS                 │
├─────────────────────────┤
│ ↗ Open in new window    │
│ ⊞ Configure columns     │
│ A Font & size            │
│ ◉ Colors                │
│ ≡ Density               │
│ ☐ Display options       │
│ ↕ Sort & filter         │
│ ─────────────────────── │
│ ↺ Reset to defaults     │
├─────────────────────────┤
```

### 6.2 Column Configuration Sub-Panel

Opens inline or as modal when "Configure columns" is clicked:

```
┌──────────────────────────────┐
│ CONFIGURE COLUMNS            │
├──────────────────────────────┤
│ ☑ Worker        [↑] [↓]     │
│ ☑ Status        [↑] [↓]     │
│ ☑ Domain        [↑] [↓]     │
│ ☑ Task          [↑] [↓]     │
├──────────────────────────────┤
│        [Apply] [Reset]       │
└──────────────────────────────┘
```

### 6.3 Settings Overlay Panel

For Font/Colors/Density, a larger overlay panel with form controls:

```
┌──────────────────────────────────┐
│ FONT & SIZE — Workers            │
├──────────────────────────────────┤
│ Font Size:    [─●──────] 13px    │
│ Font Family:  [system ▾]         │
│ Font Weight:  [normal ▾]         │
├──────────────────────────────────┤
│           [Apply] [Reset]        │
└──────────────────────────────────┘
```

## 7. Implementation Phases

### Phase 2: Core Settings Infrastructure
- Add `panelSettings` module with load/save/defaults/merge logic
- Add localStorage persistence with schema versioning
- Extend right-click menu with new items
- Build settings overlay UI component

### Phase 3: Column Management
- Implement column visibility toggles
- Implement column reorder (up/down buttons)
- Update render functions to respect column config

### Phase 4: Typography & Density
- Implement per-panel font controls (size, family, weight)
- Implement density presets (compact/default/comfortable)
- Apply settings via inline styles or CSS custom properties

### Phase 5: Colors & Display
- Implement color picker inputs for per-panel colors
- Implement display toggles (borders, grid lines, compact mode)
- Implement status color overrides

### Phase 6: Sorting & Filtering
- Add sort controls per data panel
- Add status filter toggles
- Persist sort/filter preferences

## 8. Architectural Notes

### CSS Custom Properties Strategy

Rather than inline styles, use CSS custom properties scoped to each panel:

```css
[data-panel="workers"] {
  --panel-font-size: 13px;
  --panel-font-family: system-ui;
  --panel-row-padding: 10px;
  --panel-text-color: #c9d1d9;
  --panel-row-bg: transparent;
  --panel-row-bg-alt: transparent;
  --panel-border-color: #21262d;
  --panel-accent-color: #58a6ff;
  --panel-item-spacing: 8px;
}
```

This keeps the CSS cascade clean and makes per-panel overrides natural.

### Render Function Changes

Current render functions use hardcoded HTML templates. The updated approach:

1. Read panel settings from `panelSettings.get(panelName)`
2. Filter and sort data based on settings
3. Map visible columns in configured order
4. Apply typography and density via CSS custom properties on the panel container
5. Render column-based layout instead of current card layout (for panels that support it)

### Migration from Cards to Table/Column Layout

Workers panel currently uses a card layout. For column customization to be meaningful, panels should support a **table-like layout** mode:

- **Card view** (current): Each item as a card with stacked fields — column order/visibility still applies to which fields show
- **Table view** (new): Proper columnar layout with headers — full column management support

The settings model supports both; the `display.compactMode` toggle can switch between them.

## 9. Research Sources

- [DAS Trader Pro Updates](https://dastrader.com/notice.html)
- [DAS Trader User Manual](https://centerpointsecurities.com/wp-content/uploads/2020/09/DAS-Trader-User-Manual.pdf)
- [DAS Window Formatting - Bear Bull Traders Forum](https://forums.bearbulltraders.com/topic/1936-das-window-formatting/)
- [Level 2 Color Settings - Bear Bull Traders Forum](https://forums.bearbulltraders.com/topic/108-level-2-color-settings/)
- [thinkorswim Custom Column Sets](https://toslc.thinkorswim.com/center/howToTos/thinkManual/Miscellaneous/Custom-Column-Sets)
- [thinkorswim Appearance Settings](https://toslc.thinkorswim.com/center/howToTos/thinkManual/charts/Chart-Style-Settings/appearance)
- [Grafana Dashboard JSON Model](https://grafana.com/docs/grafana/latest/dashboards/build-dashboards/view-dashboard-json-model/)
