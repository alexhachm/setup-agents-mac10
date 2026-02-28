'use strict';

/**
 * DAS-Trader-compatible hotkey script parser.
 *
 * Script syntax:
 *   ROUTE=ARCA;Price=Ask+0.05;Share=100;TIF=DAY;BUY=Send
 *   // comments
 *   CXL
 *   PANIC
 *
 * Supported expression variables:
 *   Market: ASK, BID, LAST, HIGH, LOW, OPEN, CLOSE, VOLUME
 *   Account: BP (buying power), POS (position), AVGCOST
 *   Config: DEFSHARE (default shares)
 *
 * Supported operators: +, -, *, /
 */

// Token types for the expression evaluator
const TokenType = Object.freeze({
  NUMBER: 'NUMBER',
  VARIABLE: 'VARIABLE',
  OPERATOR: 'OPERATOR',
  LPAREN: 'LPAREN',
  RPAREN: 'RPAREN',
});

// Known command names (case-insensitive matching, stored uppercase)
const COMMANDS = new Set([
  'ROUTE', 'PRICE', 'SHARE', 'SHARES', 'SIDE', 'TIF',
  'BUY', 'SELL', 'SHORT', 'COVER',
  'CXL', 'PANIC',
  'STOPPRICE', 'STOPTYPE', 'TRAILPRICE',
  'STOP', 'DEFSHARE',
  'ORDTYPE', 'DISPLAY',
]);

// Standalone commands (no = assignment)
const STANDALONE_COMMANDS = new Set(['CXL', 'PANIC']);

// Known expression variables
const EXPRESSION_VARS = new Set([
  'ASK', 'BID', 'LAST', 'HIGH', 'LOW', 'OPEN', 'CLOSE', 'VOLUME',
  'BP', 'POS', 'AVGCOST', 'DEFSHARE',
  'PRICE', // self-reference in StopPrice=Price-0.10
]);

// Known string values (routes, TIF values, order types, sides)
const STRING_VALUES = new Set([
  // Routes
  'ARCA', 'NYSE', 'NASDAQ', 'BATS', 'EDGA', 'EDGX', 'IEX', 'AMEX',
  'SMAT', 'LAMP', 'NSDQ', 'ISLAND',
  // TIF
  'DAY', 'GTC', 'IOC', 'FOK', 'GTX', 'OPG',
  // Order types
  'LIMIT', 'MARKET', 'STOP', 'STOPLIMIT',
  // Sides
  'B', 'S',
  // Action triggers
  'SEND',
]);

class ParseError extends Error {
  constructor(message, line, column) {
    super(message);
    this.name = 'ParseError';
    this.line = line;
    this.column = column;
  }
}

/**
 * Tokenize an expression string into tokens for the expression evaluator.
 */
function tokenizeExpression(expr) {
  const tokens = [];
  let i = 0;

  while (i < expr.length) {
    const ch = expr[i];

    // Skip whitespace
    if (/\s/.test(ch)) {
      i++;
      continue;
    }

    // Number (integer or decimal)
    if (/[0-9]/.test(ch) || (ch === '.' && i + 1 < expr.length && /[0-9]/.test(expr[i + 1]))) {
      let num = '';
      while (i < expr.length && (/[0-9]/.test(expr[i]) || expr[i] === '.')) {
        num += expr[i++];
      }
      tokens.push({ type: TokenType.NUMBER, value: parseFloat(num) });
      continue;
    }

    // Variable or string identifier
    if (/[A-Za-z_]/.test(ch)) {
      let name = '';
      while (i < expr.length && /[A-Za-z0-9_]/.test(expr[i])) {
        name += expr[i++];
      }
      tokens.push({ type: TokenType.VARIABLE, value: name.toUpperCase() });
      continue;
    }

    // Operators
    if ('+-*/'.includes(ch)) {
      tokens.push({ type: TokenType.OPERATOR, value: ch });
      i++;
      continue;
    }

    // Parentheses
    if (ch === '(') {
      tokens.push({ type: TokenType.LPAREN });
      i++;
      continue;
    }
    if (ch === ')') {
      tokens.push({ type: TokenType.RPAREN });
      i++;
      continue;
    }

    throw new ParseError(`Unexpected character "${ch}" in expression`, null, i);
  }

  return tokens;
}

/**
 * Parse an expression token stream into an AST.
 * Grammar:
 *   expr     → term (('+' | '-') term)*
 *   term     → factor (('*' | '/') factor)*
 *   factor   → NUMBER | VARIABLE | '(' expr ')' | ('+' | '-') factor
 */
function parseExpressionAST(tokens) {
  let pos = 0;

  function peek() { return pos < tokens.length ? tokens[pos] : null; }
  function advance() { return tokens[pos++]; }

  function parseExpr() {
    let left = parseTerm();
    while (peek() && peek().type === TokenType.OPERATOR && (peek().value === '+' || peek().value === '-')) {
      const op = advance().value;
      const right = parseTerm();
      left = { type: 'binary', op, left, right };
    }
    return left;
  }

  function parseTerm() {
    let left = parseFactor();
    while (peek() && peek().type === TokenType.OPERATOR && (peek().value === '*' || peek().value === '/')) {
      const op = advance().value;
      const right = parseFactor();
      left = { type: 'binary', op, left, right };
    }
    return left;
  }

  function parseFactor() {
    const token = peek();
    if (!token) throw new ParseError('Unexpected end of expression');

    // Unary minus/plus
    if (token.type === TokenType.OPERATOR && (token.value === '-' || token.value === '+')) {
      advance();
      const operand = parseFactor();
      if (token.value === '-') {
        return { type: 'unary', op: '-', operand };
      }
      return operand;
    }

    if (token.type === TokenType.NUMBER) {
      advance();
      return { type: 'number', value: token.value };
    }

    if (token.type === TokenType.VARIABLE) {
      advance();
      return { type: 'variable', name: token.value };
    }

    if (token.type === TokenType.LPAREN) {
      advance();
      const expr = parseExpr();
      if (!peek() || peek().type !== TokenType.RPAREN) {
        throw new ParseError('Missing closing parenthesis');
      }
      advance();
      return expr;
    }

    throw new ParseError(`Unexpected token: ${JSON.stringify(token)}`);
  }

  const ast = parseExpr();
  if (pos < tokens.length) {
    throw new ParseError(`Unexpected token after expression: ${JSON.stringify(tokens[pos])}`);
  }
  return ast;
}

/**
 * Parse a value string into either a string literal or an expression AST.
 */
function parseValue(valueStr) {
  const trimmed = valueStr.trim();
  if (!trimmed) return { type: 'string', value: '' };

  // Check if it's a pure string value (route name, TIF, etc.)
  const upper = trimmed.toUpperCase();
  if (STRING_VALUES.has(upper) && !/[+\-*/()]/.test(trimmed)) {
    return { type: 'string', value: upper };
  }

  // Check if it's a pure number
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    return { type: 'number', value: parseFloat(trimmed) };
  }

  // Try parsing as an expression
  try {
    const tokens = tokenizeExpression(trimmed);
    if (tokens.length === 0) return { type: 'string', value: trimmed };

    // Single string token with no operators → string value
    if (tokens.length === 1 && tokens[0].type === TokenType.VARIABLE && !EXPRESSION_VARS.has(tokens[0].value)) {
      return { type: 'string', value: tokens[0].value };
    }

    const ast = parseExpressionAST(tokens);
    return { type: 'expression', ast };
  } catch (e) {
    // Fall back to treating as string
    return { type: 'string', value: trimmed };
  }
}

/**
 * Parse a single command statement (e.g. "ROUTE=ARCA" or "CXL").
 */
function parseStatement(statement, lineNum) {
  const trimmed = statement.trim();
  if (!trimmed || trimmed.startsWith('//')) return null;

  // Check for standalone commands
  const upperTrimmed = trimmed.toUpperCase();
  if (STANDALONE_COMMANDS.has(upperTrimmed)) {
    return { command: upperTrimmed, value: null, line: lineNum };
  }

  // Parse key=value
  const eqIndex = trimmed.indexOf('=');
  if (eqIndex === -1) {
    // Could be a standalone command not in the set — treat as error
    throw new ParseError(`Invalid statement: "${trimmed}" — expected COMMAND=VALUE or standalone command`, lineNum);
  }

  const key = trimmed.substring(0, eqIndex).trim().toUpperCase();
  const rawValue = trimmed.substring(eqIndex + 1).trim();

  // Normalize SHARES → SHARE
  const normalizedKey = key === 'SHARES' ? 'SHARE' : key;

  if (!COMMANDS.has(key)) {
    throw new ParseError(`Unknown command: "${key}"`, lineNum);
  }

  return {
    command: normalizedKey,
    value: parseValue(rawValue),
    line: lineNum,
  };
}

/**
 * Parse a full script string into an array of command objects.
 *
 * @param {string} scriptText - The hotkey script text
 * @returns {{ commands: Array, errors: Array }}
 */
function parse(scriptText) {
  if (!scriptText || typeof scriptText !== 'string') {
    return { commands: [], errors: [{ message: 'Empty script', line: 0 }] };
  }

  const commands = [];
  const errors = [];

  // Split by lines first, then by semicolons within each line
  const lines = scriptText.split('\n');

  for (let lineNum = 0; lineNum < lines.length; lineNum++) {
    const line = lines[lineNum].trim();
    if (!line || line.startsWith('//')) continue;

    // Strip inline comments
    const commentIndex = line.indexOf('//');
    const cleanLine = commentIndex >= 0 ? line.substring(0, commentIndex) : line;

    // Split by semicolons
    const statements = cleanLine.split(';');

    for (const stmt of statements) {
      try {
        const parsed = parseStatement(stmt, lineNum + 1);
        if (parsed) commands.push(parsed);
      } catch (e) {
        errors.push({
          message: e.message,
          line: lineNum + 1,
          column: e.column || null,
        });
      }
    }
  }

  return { commands, errors };
}

/**
 * Validate a parsed script for semantic correctness.
 *
 * @param {Array} commands - Parsed commands from parse()
 * @returns {Array} Array of warning/error objects
 */
function validate(commands) {
  const warnings = [];
  let hasSend = false;
  let hasRoute = false;
  let hasPrice = false;
  let hasShare = false;
  let hasSide = false;

  for (const cmd of commands) {
    switch (cmd.command) {
      case 'BUY':
      case 'SELL':
      case 'SHORT':
      case 'COVER':
      case 'STOP':
        hasSend = true;
        hasSide = true; // implied
        break;
      case 'ROUTE':
        hasRoute = true;
        break;
      case 'PRICE':
      case 'STOPPRICE':
        hasPrice = true;
        break;
      case 'SHARE':
        hasShare = true;
        break;
      case 'SIDE':
        hasSide = true;
        break;
      case 'CXL':
      case 'PANIC':
        // Standalone, no requirements
        return warnings;
    }
  }

  if (hasSend && !hasRoute) {
    warnings.push({ type: 'warning', message: 'Order has no ROUTE specified — will use default' });
  }
  if (hasSend && !hasPrice) {
    warnings.push({ type: 'warning', message: 'Order has no PRICE specified — will use market price' });
  }
  if (hasSend && !hasShare) {
    warnings.push({ type: 'warning', message: 'Order has no SHARE count — will use default share size' });
  }

  return warnings;
}

module.exports = {
  parse,
  validate,
  parseValue,
  parseStatement,
  tokenizeExpression,
  parseExpressionAST,
  ParseError,
  COMMANDS,
  STANDALONE_COMMANDS,
  EXPRESSION_VARS,
};
