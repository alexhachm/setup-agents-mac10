# DAS Trader Hotkey Management System — Design Document

> Research and design by Worker 1, 2026-02-27

---

## Part 1: DAS Trader Hotkey Scripting Language Reference

### 1.1 Overview

DAS Trader Pro uses a proprietary scripting language for hotkeys that controls order execution, position management, and window automation. Scripts are semicolon-delimited command sequences that manipulate montage windows, calculate position sizes, and send orders.

### 1.2 Two Syntax Styles

**Simple/Legacy Style** — flat semicolon-delimited assignments:
```
ROUTE=SMRTL;Price=Bid-0.05;Share=Pos;TIF=DAY+;SELL=Send
```

**Advanced/Object Style** — using `$` variables and window objects:
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
$MONTAGE.TriggerOrder=RT:STOP STOPTYPE:MARKET PX:$mystop ACT:SELL STOPPRICE:$mystop QTY:Pos TIF:DAY+;
```

### 1.3 Variables

| Type | Syntax | Examples |
|------|--------|----------|
| Custom variables | `$name=value` | `$risk=20`, `$mystop=price`, `$buyprice=Ask` |
| Market data | Direct reference | `Ask`, `Bid`, `Last`, `Price` (chart-clicked), `Open`, `High`, `Low`, `PCL` (prev close) |
| Position data | Direct reference | `Pos` (position size), `AvgCost` (avg entry price), `Share` (from previous order) |
| Object properties | `$obj.Property` | `$MONTAGE.Ask`, `$MONTAGE.Bid`, `$MONTAGE.Pos`, `$MONTAGE.AvgCost` |
| String variables | `$name="value"` | `$MONTAGE.ROUTE="LIMIT"` |
| Integer/Float | `$name=number` | `$risk=20`, `$MyNumber=55.45` |

### 1.4 Operators

| Operator | Description |
|----------|-------------|
| `+` | Addition |
| `-` | Subtraction |
| `*` | Multiplication |
| `/` | Division |
| `>=`, `<=`, `==`, `>`, `<` | Comparison (in conditionals) |

**CRITICAL**: Operations execute **left-to-right regardless of standard precedence**. Example: `1 + 1 / 2 = 1` (not 1.5). The result of `1+1=2`, then `2/2=1`.

### 1.5 Built-in Functions

| Function | Description |
|----------|-------------|
| `Round(value, decimals)` | Round to N decimal places |
| `ROUND2` | Shorthand: round Price to 2 decimals |
| `Max(a, b)` | Maximum of two values |
| `Min(a, b)` | Minimum of two values |
| `ABS(value)` | Absolute value |
| `RoundNearestMultiple(value, mult)` | Round to nearest multiple |
| `GetWindowObj("name")` | Get window object by name |
| `GetAccountObj(account)` | Get account object (e.g., `.Equity`, `.BP`) |
| `GetQuoteObj("symbol")` | Get quote data for a symbol |
| `GetCurrPos()` | Get current available position |
| `GetBar()` | Get bar data |
| `GetStudyVal()` | Get study/indicator values |
| `GetChartLv1()` | Get chart Level 1 data |
| `PlaySound(file, device, flag)` | Play audio file (mp3/wav) |
| `Speak(text)` | Text-to-speech |
| `Wait(ms)` | Pause execution for N milliseconds |
| `Exec(script)` | Execute script from a variable |
| `ExecHotkey(name)` | Execute a named hotkey script |
| `StrLen(string)` | Get string length |
| `StrFind(string, search)` | Find substring position |

### 1.6 Control Flow

```
// If/else (added August 2023)
if ($price > 100) {
  $share = 10;
} else if ($price > 50) {
  $share = 20;
} else {
  $share = 50;
}

// While loop
while ($count < 5) {
  // ... commands
  $count = $count + 1;
}

// For loop
for ($i = 0; $i < 10; $i = $i + 1) {
  // ... commands
}
```

Scripts can repeat actions up to 200 times.

### 1.7 Order Commands

| Command | Style | Description |
|---------|-------|-------------|
| `BUY=Send` | Simple | Send buy order |
| `SELL=Send` | Simple | Send sell order |
| `$montage.Buy` | Advanced | Send buy order via object |
| `$montage.Sell` | Advanced | Send sell order via object |
| `Send=Reverse` | Both | Reverse current position |
| `Send=AddShare` | Both | Add to current position |

### 1.8 Route Types

| Route | Description |
|-------|-------------|
| `LIMIT` / `SMRTL` | Limit orders |
| `MARKET` / `SMRTM` | Market orders |
| `STOP` | Stop orders |
| `ARCAL` | ARCA Limit |
| `ARCAM` | ARCA Market |

Convention: Routes ending in `M` = market, `L` = limit, `S` = stop, `P` = pegged. Broker-specific routes vary (e.g., IB uses `SMRTL`/`SMRTM`).

### 1.9 Order Properties

| Property | Values | Description |
|----------|--------|-------------|
| `ROUTE` | String | Order routing destination |
| `Price` | Number/expr | Order price |
| `Share` | Number/expr | Quantity (`Pos`, `Pos*0.5`, `BP*0.25`, `Located`, `Input`) |
| `TIF` | `DAY`, `DAY+`, `GTC`, `GTC+` | Time in force |
| `StopPrice` | Number/expr | Stop trigger price |
| `StopType` | `Market`, `Limit`, `LimitP`, `Trailing`, `Range` | Type of stop |
| `TogSShare` | — | Toggle share quantity |
| `PostOnly` | — | Post-only order flag |
| `FixTags` | `tag1=val1\|tag2=val2` | Custom FIX protocol tags |

### 1.10 Cancel Commands

| Command | Description |
|---------|-------------|
| `CXL ALL` | Cancel all orders |
| `CXL ALLSYMB` | Cancel all for current symbol |
| `CXL STOP` | Cancel stop orders only |
| `CXL FIRSTSYMB` | Cancel oldest order for symbol |
| `CXL INBID` | Cancel bid-side orders |
| `CXL INOFFER` | Cancel offer-side orders |
| `CXL ABOVEAVGCOST` | Cancel orders above avg cost |
| `CXL BELOWAVGCOST` | Cancel orders below avg cost |
| `CXL ABOVEEQAVGCOST` | Cancel orders at/above avg cost |
| `CXL BELOWEQAVGCOST` | Cancel orders at/below avg cost |
| `CXL CLOSEST` | Cancel order closest to market |
| `CXL FURTHEST` | Cancel order furthest from market |
| `PANIC` | Cancel ALL orders + flatten ALL positions |

### 1.11 TriggerOrder Syntax

TriggerOrders are conditional secondary orders attached to a primary order:

```
TriggerOrder=RT:STOP STOPTYPE:MARKET PX:$price ACT:SELL STOPPRICE:$stop QTY:Pos TIF:DAY+
```

**Range/OCO style** (bracket orders):
```
TriggerOrder=RT:STOP STOPTYPE:RANGEMKT LowPrice:$stop HighPrice:$target ACT:SELL QTY:POS TIF:DAY+
```

- Up to 5 trigger orders per position
- `CXLSYMB:ALL` or `CXLSYMB:CurrSym` cancels related orders before sending
- TriggerOrder parameters: `RT`, `STOPTYPE`, `PX`, `ACT`, `STOPPRICE`, `QTY`, `TIF`, `LowPrice`, `HighPrice`, `PREF`

### 1.12 Miscellaneous Commands

| Command | Description |
|---------|-------------|
| `RemoveAllTrendlines` | Remove trend lines from current symbol |
| `RemoveAllTrendlines AllSymbolsAllCharts` | Remove all trend lines everywhere |
| `LoadSetting filename.cst` | Load chart/layout settings file |
| `AlertName=X;AlertType=X;AlertOperator=X;AddAlert` | Create price alerts |
| `NewWindow TradingSetting` | Open settings dialog |
| `MuteOrUnmuteAllSound` | Toggle all sounds |
| `//` | Line comment |

### 1.13 Constraints & Gotchas

- **Max script length**: 4096 characters
- **Left-to-right evaluation**: No operator precedence — use parentheses or intermediate variables
- **Semicolons required**: Every statement must end with `;`
- **Straight quotes only**: Must use `"` not curly quotes `""`
- **Case sensitivity**: Variable names are case-sensitive
- **Montage window naming**: Must match exact window name (e.g., `"MONTAGE1"`)

---

## Part 2: Scripting System Parser & Execution Model

### 2.1 Architecture Overview

The hotkey scripting system in our app will parse, validate, and simulate DAS Trader scripts. It does **not** execute real trades — it provides a script editor with syntax highlighting, validation, template library, and export capability.

```
┌──────────────────────────────────────────────────────┐
│                  Hotkey Manager UI                    │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────┐  │
│  │  Script      │  │  Template    │  │  Hotkey    │  │
│  │  Editor      │  │  Library     │  │  List      │  │
│  └──────┬──────┘  └──────┬───────┘  └─────┬──────┘  │
│         │                │                 │          │
│  ┌──────▼────────────────▼─────────────────▼──────┐  │
│  │              Script Engine (JS)                 │  │
│  │  ┌──────────┐  ┌───────────┐  ┌─────────────┐ │  │
│  │  │  Lexer   │→ │  Parser   │→ │  Validator  │ │  │
│  │  └──────────┘  └───────────┘  └─────────────┘ │  │
│  └────────────────────────────────────────────────┘  │
│                                                      │
│  ┌────────────────────────────────────────────────┐  │
│  │              Storage (localStorage)             │  │
│  │  - User scripts     - Keyboard bindings        │  │
│  │  - Custom templates  - Script categories       │  │
│  └────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────┘
```

### 2.2 Lexer Design

The lexer tokenizes DAS script text into a stream of tokens.

**Token Types:**
```javascript
const TokenType = {
  // Literals
  NUMBER:       'NUMBER',       // 20, 55.45, 0.005
  STRING:       'STRING',       // "LIMIT", "DAY+"
  IDENTIFIER:   'IDENTIFIER',   // ROUTE, Price, Share, Ask, Bid
  VARIABLE:     'VARIABLE',     // $risk, $mystop, $MONTAGE

  // Operators
  ASSIGN:       'ASSIGN',       // =
  PLUS:         'PLUS',         // +
  MINUS:        'MINUS',        // -
  MULTIPLY:     'MULTIPLY',     // *
  DIVIDE:       'DIVIDE',       // /
  DOT:          'DOT',          // .

  // Comparison
  GT:           'GT',           // >
  LT:           'LT',          // <
  GTE:          'GTE',          // >=
  LTE:          'LTE',          // <=
  EQ:           'EQ',           // ==

  // Delimiters
  SEMICOLON:    'SEMICOLON',    // ;
  LPAREN:       'LPAREN',       // (
  RPAREN:       'RPAREN',       // )
  LBRACE:       'LBRACE',       // {
  RBRACE:       'RBRACE',       // }
  COMMA:        'COMMA',        // ,
  COLON:        'COLON',        // :

  // Keywords
  IF:           'IF',
  ELSE:         'ELSE',
  WHILE:        'WHILE',
  FOR:          'FOR',
  BUY:          'BUY',
  SELL:         'SELL',
  SEND:         'SEND',

  // Special
  COMMENT:      'COMMENT',      // // ...
  TRIGGER:      'TRIGGER',      // TriggerOrder=...
  CXL:          'CXL',          // CXL command
  EOF:          'EOF'
};
```

### 2.3 Parser Design

The parser builds an AST from the token stream. It handles DAS's left-to-right evaluation model.

**AST Node Types:**
```javascript
// Assignment: ROUTE=SMRTL  or  $risk=20
{ type: 'Assignment', target: 'ROUTE', value: { type: 'StringLiteral', value: 'SMRTL' } }

// Arithmetic (left-to-right, no precedence)
{ type: 'BinaryExpr', op: '-', left: {...}, right: {...} }

// Function call: Round($buyprice*1.005, 2)
{ type: 'FunctionCall', name: 'Round', args: [...] }

// Object access: $MONTAGE.Ask
{ type: 'MemberExpr', object: '$MONTAGE', property: 'Ask' }

// Order send: BUY=Send or $MONTAGE.Buy
{ type: 'OrderSend', side: 'BUY', method: 'Send' }

// Cancel: CXL ALLSYMB
{ type: 'CancelOrder', scope: 'ALLSYMB' }

// TriggerOrder: TriggerOrder=RT:STOP STOPTYPE:MARKET ...
{ type: 'TriggerOrder', params: { RT: 'STOP', STOPTYPE: 'MARKET', ... } }

// Control flow
{ type: 'IfStatement', condition: {...}, consequent: [...], alternate: [...] }
{ type: 'WhileStatement', condition: {...}, body: [...] }
{ type: 'ForStatement', init: {...}, condition: {...}, update: {...}, body: [...] }
```

### 2.4 Validator

The validator checks the AST for common errors:

1. **Required fields check**: Orders need ROUTE, Price (usually), Share, TIF
2. **Type validation**: Price must resolve to number, ROUTE to known string
3. **Undefined variable detection**: Warn on use of unassigned `$` variables
4. **Route validation**: Check against known route names
5. **TriggerOrder param check**: Validate required RT, ACT, QTY params
6. **Script length check**: Warn if > 4096 chars
7. **Operator precedence warning**: Flag expressions with mixed operators that may behave unexpectedly due to L-to-R evaluation

**Validation output:**
```javascript
{
  errors: [{ line: 3, col: 5, message: 'Undefined variable $mystop', severity: 'error' }],
  warnings: [{ line: 7, col: 1, message: 'Mixed operators without grouping — DAS evaluates left-to-right', severity: 'warning' }],
  info: [{ line: 1, col: 1, message: 'Route SMRTL is an Interactive Brokers limit route', severity: 'info' }]
}
```

### 2.5 Storage Model

Scripts stored in `localStorage` with this schema:

```javascript
{
  hotkeys: [
    {
      id: 'hk_001',
      name: 'Long Entry — $20 Risk + Stop',
      category: 'entry',         // entry | exit | stop | cancel | utility
      keyboard: 'F1',            // keyboard shortcut binding
      script: '...',             // raw DAS script text
      description: 'Buy at Ask with $20 risk, auto stop-loss at clicked price',
      tags: ['long', 'risk-managed', 'stop-loss'],
      createdAt: '2026-02-27T00:00:00Z',
      updatedAt: '2026-02-27T00:00:00Z'
    }
  ],
  templates: [
    {
      id: 'tpl_001',
      name: 'Static Risk Long Entry',
      category: 'entry',
      script: '...',
      description: '...',
      parameters: [              // user-configurable template params
        { name: 'risk', label: 'Risk Amount ($)', type: 'number', default: 20 },
        { name: 'route', label: 'Route', type: 'select', options: ['SMRTL','LIMIT','ARCAL'], default: 'SMRTL' }
      ]
    }
  ],
  settings: {
    defaultRoute: 'SMRTL',
    defaultTif: 'DAY+',
    defaultRisk: 20,
    montageWindow: 'MONTAGE1',
    broker: 'interactive-brokers'  // affects available routes
  }
}
```

---

## Part 3: Hotkey Manager UI Design

### 3.1 Panel Layout

The hotkey manager will be a new panel section in the dashboard, following the existing panel pattern. It will also support the popout window system.

```
┌──────────────────────────────────────────────────────────────┐
│  Hotkey Manager                                     [+] [⚙] │
├──────────────────┬───────────────────────────────────────────┤
│  📋 Hotkey List  │  Script Editor                            │
│                  │                                           │
│  ┌────────────┐  │  Name: [Long Entry - $20 Risk        ]   │
│  │ ENTRY      │  │  Key:  [F1    ▾]  Category: [Entry   ▾]  │
│  │  F1 Long   │  │                                           │
│  │  F2 Short  │  │  ┌─────────────────────────────────────┐  │
│  │            │  │  │ $MONTAGE=GetWindowObj("MONTAGE1");  │  │
│  │ EXIT       │  │  │ $MONTAGE.CXL ALLSYMB;              │  │
│  │  F5 Sell½  │  │  │ $buyprice=$MONTAGE.Ask;            │  │
│  │  F6 Flat   │  │  │ $risk=20;                          │  │
│  │            │  │  │ $mystop=$MONTAGE.price;             │  │
│  │ STOP       │  │  │ $pricetostop=$buyprice-$mystop;    │  │
│  │  F9 Trail  │  │  │ $amount=$risk/$pricetostop;        │  │
│  │            │  │  │ $MONTAGE.share=$amount;             │  │
│  │ CANCEL     │  │  │ $MONTAGE.ROUTE="LIMIT";            │  │
│  │  ESC CxlA  │  │  │ $MONTAGE.Price=Round($buyprice*... │  │
│  │            │  │  │ $MONTAGE.TIF="DAY+";               │  │
│  │ UTILITY    │  │  │ $MONTAGE.Buy;                      │  │
│  │  F12 Panic │  │  │ $MONTAGE.TriggerOrder=RT:STOP ...  │  │
│  │            │  │  └─────────────────────────────────────┘  │
│  └────────────┘  │                                           │
│                  │  Validation:  ✅ No errors                │
│  [+ New Hotkey]  │  Description: [Auto stop at clicked px ]  │
│  [📂 Templates]  │                                           │
│                  │  [💾 Save]  [▶ Validate]  [📋 Copy DAS]   │
└──────────────────┴───────────────────────────────────────────┘
```

### 3.2 Component Breakdown

#### A. Hotkey List Sidebar (Left)
- Grouped by category: Entry, Exit, Stop, Cancel, Utility
- Each item shows: keyboard shortcut + name
- Click to select and load in editor
- Drag to reorder within category
- Right-click for context menu (duplicate, delete, export)
- `[+ New Hotkey]` button at bottom
- `[📂 Templates]` button opens template browser

#### B. Script Editor (Right)
- **Header fields**: Name (text input), Keyboard binding (dropdown), Category (dropdown)
- **Code editor area**: Monospace textarea with line numbers
  - Syntax highlighting via CSS classes (keywords blue, variables green, strings orange, comments gray)
  - Line numbers in gutter
  - Tab indentation support
- **Validation status bar**: Shows errors/warnings inline below editor
- **Description field**: One-line text input for notes
- **Action buttons**:
  - Save — save to localStorage
  - Validate — run parser + validator, show results
  - Copy DAS — copy raw script to clipboard for pasting into DAS Trader

#### C. Template Browser (Modal/Overlay)
- Grid of template cards showing name, description, category
- Click to preview script
- "Use Template" button creates new hotkey from template
- Parameter form for configurable templates (e.g., risk amount, route)
- Built-in templates for common patterns + user-created templates

#### D. Settings (Gear Icon)
- Default route selection
- Default TIF
- Default risk amount
- Montage window name
- Broker selection (determines available routes)
- Import/Export all hotkeys as JSON

### 3.3 Syntax Highlighting Rules

CSS classes applied by a lightweight tokenizer running on input:

```css
.hs-keyword   { color: #ff7b72; }   /* ROUTE, BUY, SELL, CXL, TriggerOrder */
.hs-variable  { color: #7ee787; }   /* $risk, $MONTAGE, $buyprice */
.hs-property  { color: #79c0ff; }   /* .Ask, .Bid, .Price, .Share */
.hs-string    { color: #ffa657; }   /* "LIMIT", "DAY+" */
.hs-number    { color: #d2a8ff; }   /* 20, 0.005, 100 */
.hs-function  { color: #d2a8ff; }   /* Round(), GetWindowObj() */
.hs-operator  { color: #8b949e; }   /* =, +, -, *, / */
.hs-comment   { color: #484f58; font-style: italic; }  /* // ... */
.hs-builtin   { color: #58a6ff; }   /* Ask, Bid, Pos, AvgCost */
.hs-error     { text-decoration: wavy underline red; }
```

### 3.4 Built-in Template Library

| Template | Category | Description |
|----------|----------|-------------|
| Static Risk Long Entry | Entry | Buy at Ask with fixed $ risk, stop at chart price |
| Static Risk Short Entry | Entry | Sell at Bid with fixed $ risk, stop at chart price |
| Long Entry + 3R Target | Entry | Buy with stop + OCO bracket at 3× risk:reward |
| Short Entry + 3R Target | Entry | Sell with stop + OCO bracket at 3× risk:reward |
| Percent Risk Entry | Entry | Risk based on % of account equity |
| Stop Order Long | Entry | Buy stop entry with auto stop-loss + target |
| Stop Order Short | Entry | Sell stop entry with auto stop-loss + target |
| Half Position Exit (Long) | Exit | Sell 50% + move stop to breakeven |
| Half Position Exit (Short) | Exit | Cover 50% + move stop to breakeven |
| Full Exit Long | Exit | Flatten long position at market |
| Full Exit Short | Exit | Flatten short position at market |
| Quarter Scale-Out | Exit | Sell 25% of position |
| Trailing Stop | Stop | Set trailing stop order |
| Breakeven Stop | Stop | Move stop to average cost |
| Cancel All Symbol | Cancel | Cancel all orders for current symbol |
| Cancel All | Cancel | Cancel all open orders |
| PANIC Flatten | Cancel | Cancel all + flatten everything |
| Set Stop Price | Utility | Store chart-clicked price as stop variable |
| Remove Trendlines | Utility | Clear all trend lines |
| Price Alert Above | Utility | Set alert when price rises above level |
| Price Alert Below | Utility | Set alert when price drops below level |

### 3.5 Export Format

When user clicks "Copy DAS", the script is formatted for direct paste into DAS Trader:

```
// For simple scripts: single-line semicolon-delimited
ROUTE=SMRTL;Price=Bid-0.05;Share=Pos;TIF=DAY+;SELL=Send

// For advanced scripts: preserved multi-line
$MONTAGE=GetWindowObj("MONTAGE1");
$MONTAGE.CXL ALLSYMB;
...
```

### 3.6 File Structure

New files to create:
```
gui/public/
  hotkey-manager.js       — UI logic for hotkey manager panel
  hotkey-engine.js        — Lexer, parser, validator
  hotkey-templates.js     — Built-in template library
  hotkey-manager.css      — Additional styles for editor/highlighting
```

Modifications to existing files:
```
gui/public/index.html    — Add hotkey manager section
gui/public/app.js        — Wire up panel in renderState + settings menu
gui/public/popout.html   — Add hotkey manager support
gui/public/popout.js     — Add hotkey manager panel renderer
gui/public/styles.css    — Add syntax highlighting + editor styles
```

### 3.7 Integration with Existing Panel System

The hotkey manager panel follows the established pattern:

```html
<!-- In index.html -->
<section id="hotkey-panel" style="grid-column: 1 / -1;">
  <div class="panel-header" data-panel="hotkeys">
    <h2>Hotkey Manager</h2>
  </div>
  <div id="hotkey-manager"></div>
</section>
```

```javascript
// In app.js — renderState()
// Hotkey panel is client-side only (no server state needed)
// Initialized once on page load

// In app.js — settings menu
const titles = { ..., hotkeys: 'Hotkey Manager' };
```

### 3.8 Data Flow

```
User edits script in editor
  → Lightweight tokenizer runs on every keystroke (debounced 300ms)
  → Applies syntax highlighting classes to overlay div
  → On "Validate" click:
      → Full lexer tokenizes script
      → Parser builds AST
      → Validator checks AST for errors
      → Results displayed in validation bar
  → On "Save":
      → Script stored in localStorage
      → Hotkey list re-rendered
  → On "Copy DAS":
      → Raw script text copied to clipboard
      → Toast notification shown
```

---

## Part 4: Implementation Roadmap

### Phase 1 (This Task): Research + Design ✅
- Research DAS Trader hotkey language
- Document full command set
- Design parser/execution model
- Design UI layout
- Output: This design document

### Phase 2: Core Script Engine
- Implement lexer (tokenizer)
- Implement parser (AST builder)
- Implement validator
- Unit tests for parsing common script patterns

### Phase 3: UI — Hotkey List + Editor
- HTML structure for hotkey manager panel
- Script editor with textarea + line numbers
- Hotkey list sidebar with categories
- Save/load from localStorage
- Copy to clipboard

### Phase 4: Syntax Highlighting
- Lightweight tokenizer for real-time highlighting
- CSS overlay approach (textarea + pre overlay)
- Debounced re-highlighting on input

### Phase 5: Template Library
- Built-in templates data
- Template browser modal
- Parameterized template instantiation
- User template creation

### Phase 6: Import/Export + Settings
- Settings panel (default route, TIF, risk, broker)
- JSON export/import of all hotkeys
- Popout window support

---

## References

- [DAS Trader Official Hotkey User Guide](https://dastrader.com/documents/HotKeys.pdf)
- [DAS Trader Updates / Notice](https://dastrader.com/notice.html)
- [Guardian Trading — Basic Hotkeys](https://www.guardiantrading.com/basic-set-of-hotkeys-for-das-trader-pro/)
- [Guardian Trading — Advanced Hotkey Prep](https://www.guardiantrading.com/how-to-prepare-your-das-trader-pro-for-advanced-hotkeys-scripting/)
- [Peter Benci — DAS Trader Hotkeys Part 1](https://traderpeter.substack.com/p/das-trader-hotkeys-part-1)
- [Peter Benci — Advanced Hotkeys Part 2](https://traderpeter.substack.com/p/das-trader-advanced-hotkeys-part)
- [DAS Trader Hotkey Generator (GitHub Gist)](https://gist.github.com/onosendi/11ae4c274e87425b02eb676928547960)
- [DASTraderScripts Python Tool](https://github.com/jseparovic/DASTraderScripts)
