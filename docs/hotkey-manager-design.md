# DAS Trader Hotkey Manager — Design Document

## 1. DAS Trader Pro Hotkey Language Reference

### 1.1 Scripting Formats

DAS Trader Pro supports two scripting levels:

**Simple format** — Semicolon-separated `key=value` pairs:
```
ROUTE=SMRTL;Price=Ask+0.05;Share=2000;TIF=DAY+;BUY=Send
```

**Advanced format** — Uses `$`-prefixed variables and object references:
```
$MONTAGE=GetWindowObj("MONTAGE1");
$MONTAGE.CXL ALLSYMB;
$buyprice=$MONTAGE.Ask;
$risk=20;
$mystop=$MONTAGE.price;
$pricetostop=$buyprice-$mystop;
$amount=$risk/$pricetostop;
$MONTAGE.share=$amount;
$MONTAGE.ROUTE="LIMIT";
$MONTAGE.Price=Round($buyprice*1.005,2);
$MONTAGE.TIF="DAY+";
$MONTAGE.Buy;
```

Scripts support up to 4096 characters.

### 1.2 Key Binding Format

Hotkeys are bound via the format: `Modifier+Key`

**Modifier keys:** `Ctrl`, `Shift`, `Alt` (combinable with `+`)
**Key names:** A-Z, 0-9, F1-F12, Space, PageUp, PageDown, Home, End, Insert, Delete, arrow keys.

Examples:
- `Ctrl+Shift+Q`
- `Ctrl+PageUp`
- `Space`
- `Shift+F1`

There is no formal file format for bulk import/export — hotkeys are configured via the DAS GUI's hotkey editor.

### 1.3 Command Categories

#### Order Execution
| Command | Description |
|---------|-------------|
| `BUY=Send` | Send buy order (simple format) |
| `SELL=Send` | Send sell order (simple format) |
| `$MONTAGE.Buy` | Send buy order (advanced) |
| `$MONTAGE.Sell` | Send sell order (advanced) |

#### Price Variables
| Variable | Description |
|----------|-------------|
| `Price=Ask` | Level 1 ask price |
| `Price=Bid` | Level 1 bid price |
| `Price=Ask+0.05` | Ask plus offset |
| `Price=Bid-0.05` | Bid minus offset |
| `$MONTAGE.Ask` | Ask (advanced) |
| `$MONTAGE.Bid` | Bid (advanced) |
| `$MONTAGE.AvgCost` | Average entry cost |
| `$MONTAGE.price` | Last clicked chart price |
| `StopPrice=value` | Stop trigger price |

#### Share / Position Sizing
| Expression | Description |
|------------|-------------|
| `Share=100` | Fixed share count |
| `Share=Pos` | Full current position |
| `Share=Pos*0.5` | Half position |
| `Share=Pos*0.25` | Quarter position |
| `DefShare=BP*0.97` | Buying power based sizing |
| `$MONTAGE.Pos` | Current position (advanced) |

#### Route / Order Types
| Route | Description |
|-------|-------------|
| `ROUTE=LIMIT` | Limit order |
| `ROUTE=MARKET` | Market order |
| `ROUTE=SMRTL` | Smart limit routing |
| `ROUTE=SMRTM` | Smart market routing |
| `ROUTE=STOP` | Stop order |
| `StopType=Market` | Market stop |
| `StopType=Limit` | Limit stop |

#### Time In Force
| TIF | Description |
|-----|-------------|
| `TIF=DAY+` | Day order with extended hours |
| `TIF=GTC` | Good till cancelled |

#### Order Management
| Command | Description |
|---------|-------------|
| `CXL ALLSYMB` | Cancel all orders for symbol |

#### Trigger / Conditional Orders
```
TriggerOrder=RT:STOP STOPTYPE:MARKET PX:$mystop ACT:SELL STOPPRICE:$mystop QTY:Pos TIF:DAY+
TriggerOrder=RT:STOP STOPTYPE:RANGEMKT LowPrice:$target HighPrice:$mystop ACT:BUY QTY:POS TIF:DAY+
```

Parameters: `RT` (route type), `STOPTYPE`, `PX`/`STOPPRICE`/`LowPrice`/`HighPrice`, `ACT` (action), `QTY`/`QTYOS`, `TIF`.

#### Chart Commands
| Command | Description |
|---------|-------------|
| `HorizontalLine` | Draw horizontal line |
| `ConfigTrendLine HorzLine DashLine:RRGGBB:W` | Configure line style/color/width |
| `RemoveAllTrendlines` | Remove lines for current symbol |
| `RemoveAllTrendlines AllSymbolsAllCharts` | Remove all lines everywhere |
| `LoadSetting filename.cst` | Load chart settings |

#### Alert Commands
```
Alertname=PriceReached;AlertType=LastPrice;AlertOperator=">=";AddAlert
```

#### Built-in Functions
| Function | Description |
|----------|-------------|
| `Round(value, decimals)` | Round a numeric value |
| `GetWindowObj("name")` | Get window object reference |
| `GetAccountObj(account).Equity` | Account equity value |

### 1.4 Operator Behavior

Supported: `+`, `-`, `*`, `/`

**Critical:** DAS evaluates left-to-right with no operator precedence. `1 + 1 / 2` evaluates to `1` (not `1.5`). Parentheses are not supported in simple format; use intermediate variables in advanced format to control evaluation order.

### 1.5 Variable System (Advanced Format)

- `$varname = expression` — Declare/assign a local variable
- `$MONTAGE.property` — Access object property
- Variables persist within a single script execution
- Variable names are case-insensitive

---

## 2. Data Model Design

### 2.1 HotkeyBinding

The core entity representing a single configured hotkey.

```javascript
{
  id: String,           // UUID
  name: String,         // User label, e.g. "Long Entry $20 Risk"
  key: String,          // Primary key: "Q", "Space", "PageUp", "F1"
  modifiers: {
    ctrl: Boolean,      // default false
    shift: Boolean,     // default false
    alt: Boolean        // default false
  },
  category: String,     // "entry" | "exit" | "scale" | "stop" | "cancel" | "chart" | "alert" | "config"
  script: String,       // Raw DAS command script
  format: String,       // "simple" | "advanced"
  enabled: Boolean,     // default true
  description: String,  // Optional notes about what this hotkey does
  tags: [String],       // Optional tags for filtering: ["long", "risk-20", "stop-loss"]
  order: Number         // Display sort order
}
```

### 2.2 HotkeyCategory

Enum for organizing hotkeys by function.

```javascript
const HOTKEY_CATEGORIES = {
  entry:   { label: "Entry Orders",     color: "#3fb950" },
  exit:    { label: "Exit / Close",     color: "#f85149" },
  scale:   { label: "Scale In/Out",     color: "#d29922" },
  stop:    { label: "Stop Management",  color: "#db6d28" },
  cancel:  { label: "Cancel Orders",    color: "#8b949e" },
  chart:   { label: "Chart Tools",      color: "#58a6ff" },
  alert:   { label: "Alerts",           color: "#bc8cff" },
  config:  { label: "Configuration",    color: "#484f58" }
};
```

### 2.3 ScriptToken (for parsing/syntax highlighting)

Tokens produced by parsing a DAS script string.

```javascript
{
  type: String,    // "command" | "variable" | "operator" | "literal" | "separator" | "function" | "keyword"
  value: String,   // The token text
  start: Number,   // Character offset in script
  end: Number      // End offset
}
```

Token type definitions:
- **command**: `BUY`, `SELL`, `CXL`, `HorizontalLine`, `AddAlert`, etc.
- **variable**: `Price`, `Share`, `Route`, `TIF`, `StopPrice`, `StopType`, `$varname`
- **operator**: `=`, `+`, `-`, `*`, `/`
- **literal**: Numeric values (`100`, `0.05`), string values (`"DAY+"`, `"LIMIT"`)
- **separator**: `;`
- **function**: `Round`, `GetWindowObj`, `GetAccountObj`
- **keyword**: `Send`, `Pos`, `Ask`, `Bid`, `AvgCost`, `BP`, `DefShare`

### 2.4 ActionType

Structured representation of what a hotkey does (parsed from script).

```javascript
{
  type: String,            // "order" | "cancel" | "chart" | "alert" | "config" | "multi"
  // For order actions:
  side: String | null,     // "BUY" | "SELL"
  route: String | null,    // "LIMIT" | "SMRTL" | "STOP" | "MARKET" | "SMRTM"
  priceExpr: String | null,   // "Ask+0.05", "Bid-0.05"
  shareExpr: String | null,   // "100", "Pos*0.5", "DefShare*0.25*Price*0.01"
  tif: String | null,         // "DAY+" | "GTC"
  stopPrice: String | null,   // Stop price expression
  stopType: String | null,    // "Market" | "Limit"
  triggerOrder: {              // Attached conditional order
    route: String,
    stopType: String,
    prices: Object,            // { px, lowPrice, highPrice, stopPrice }
    action: String,            // "BUY" | "SELL"
    quantity: String,          // "Pos", "QTY:100"
    tif: String
  } | null
}
```

### 2.5 HotkeyCollection

Top-level container for all hotkeys with metadata.

```javascript
{
  version: Number,           // Schema version for migrations
  name: String,              // Collection name, e.g. "My Day Trading Setup"
  description: String,       // Optional notes
  hotkeys: [HotkeyBinding],  // Array of hotkey bindings
  defaults: {                // Default values for new hotkeys
    route: String,           // e.g. "SMRTL"
    tif: String,             // e.g. "DAY+"
    riskAmount: Number,      // e.g. 20
    montageWindow: String    // e.g. "MONTAGE1"
  },
  createdAt: String,         // ISO timestamp
  updatedAt: String          // ISO timestamp
}
```

---

## 3. UI Integration Plan

### 3.1 Panel Location

Add a "Hotkeys" panel to the mac10 dashboard, following the same pattern as existing panels (workers, requests, tasks, log). The panel will:

- Live in the grid layout alongside other panels
- Support right-click settings menu (popout, etc.) via existing `panel-header[data-panel]` pattern
- Use the same dark theme styling from `styles.css`

### 3.2 Panel Features

**List View:**
- Display hotkeys grouped by category with color-coded badges
- Show key binding, name, and enabled/disabled status
- Filter by category or search by name/key

**Editor View:**
- Key binding picker (key + modifier checkboxes)
- Category dropdown
- Script textarea with syntax highlighting (token-based)
- Live preview of parsed action summary
- Enable/disable toggle

**Script Builder (stretch):**
- Guided form for common patterns (entry, exit, partial exit)
- Generates script from structured inputs (side, route, price, shares, TIF)
- Option to switch between builder and raw script editing

### 3.3 Storage

Hotkey collections stored as JSON via the existing server API pattern (`/api/hotkeys`). Persisted to a JSON file on disk alongside other mac10 configuration.

### 3.4 Key Files to Modify

| File | Changes |
|------|---------|
| `gui/public/index.html` | Add hotkey panel section to the grid |
| `gui/public/styles.css` | Add hotkey panel styles (editor, badges, key picker) |
| `gui/public/app.js` | Add hotkey rendering, editor logic, API calls |
| `gui/server.js` (if exists) | Add `/api/hotkeys` CRUD endpoints |

---

## 4. Common Hotkey Templates

Pre-built templates to include for quick setup:

1. **Long Entry (Risk-Based)** — Calculate shares from risk amount, buy at ask, set stop
2. **Short Entry (Risk-Based)** — Mirror of long entry
3. **Sell Half + Break-Even Stop** — Partial exit with stop management
4. **Buy to Cover Half + Break-Even Stop** — Short partial exit
5. **Flatten Long** — Close entire long position
6. **Flatten Short** — Close entire short position
7. **Cancel All** — Cancel all pending orders
8. **Draw Support Line (Green)** — Horizontal line tool
9. **Draw Resistance Line (Red)** — Horizontal line tool
10. **Remove All Lines** — Clear chart drawings

---

## 5. Research Sources

- [DAS Trader HotKeys PDF](https://dastrader.com/documents/HotKeys.pdf) — Official command/script user guide
- [Guardian Trading — Basic Hotkeys](https://www.guardiantrading.com/basic-set-of-hotkeys-for-das-trader-pro/) — Entry/exit examples with advanced scripting
- [Guardian Trading — Advanced Scripting](https://www.guardiantrading.com/how-to-prepare-your-das-trader-pro-for-advanced-hotkeys-scripting/) — Setup and variable usage
- [DAS Trader Hotkeys Part 1 (Substack)](https://traderpeter.substack.com/p/das-trader-hotkeys-part-1) — Chart/alert commands
- [DAS Hotkey Generator (GitHub Gist)](https://gist.github.com/onosendi/11ae4c274e87425b02eb676928547960) — Key binding format reference
- [DASTraderScripts (GitHub)](https://github.com/jseparovic/DASTraderScripts) — Python-to-DAS script framework
- [Bear Bull Traders Forum](https://forums.bearbulltraders.com/topic/1607-most-frequently-used-hotkeys/) — Community hotkey examples
