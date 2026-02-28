'use strict';

const { parse, validate, ParseError } = require('./script-parser');

/**
 * DAS-Trader-compatible hotkey script executor.
 *
 * Evaluates parsed command ASTs against a market/account context
 * and produces an order or action result.
 */

class ExecutionError extends Error {
  constructor(message, command, line) {
    super(message);
    this.name = 'ExecutionError';
    this.command = command;
    this.line = line;
  }
}

/**
 * Default market context — used when no live data is available.
 */
function defaultContext() {
  return {
    // Market data
    ASK: 0,
    BID: 0,
    LAST: 0,
    HIGH: 0,
    LOW: 0,
    OPEN: 0,
    CLOSE: 0,
    VOLUME: 0,
    // Account data
    BP: 0,      // Buying power
    POS: 0,     // Current position size
    AVGCOST: 0, // Average cost basis
    // Config
    DEFSHARE: 100, // Default share size
    PRICE: 0,      // Resolved price (for StopPrice=Price-0.10 references)
  };
}

/**
 * Evaluate an expression AST node against a context.
 *
 * @param {object} node - AST node from the parser
 * @param {object} ctx - Variable context
 * @returns {number}
 */
function evaluateExpression(node, ctx) {
  switch (node.type) {
    case 'number':
      return node.value;

    case 'variable': {
      const val = ctx[node.name];
      if (val === undefined) {
        throw new ExecutionError(`Unknown variable: ${node.name}`);
      }
      if (typeof val !== 'number') {
        throw new ExecutionError(`Variable ${node.name} is not numeric: ${val}`);
      }
      return val;
    }

    case 'binary': {
      const left = evaluateExpression(node.left, ctx);
      const right = evaluateExpression(node.right, ctx);
      switch (node.op) {
        case '+': return left + right;
        case '-': return left - right;
        case '*': return left * right;
        case '/':
          if (right === 0) throw new ExecutionError('Division by zero');
          return left / right;
        default:
          throw new ExecutionError(`Unknown operator: ${node.op}`);
      }
    }

    case 'unary':
      if (node.op === '-') return -evaluateExpression(node.operand, ctx);
      throw new ExecutionError(`Unknown unary operator: ${node.op}`);

    default:
      throw new ExecutionError(`Unknown AST node type: ${node.type}`);
  }
}

/**
 * Resolve a parsed value (string, number, or expression) to a concrete value.
 *
 * @param {object} parsedValue - From parseValue()
 * @param {object} ctx - Variable context
 * @returns {string|number}
 */
function resolveValue(parsedValue, ctx) {
  if (!parsedValue) return null;

  switch (parsedValue.type) {
    case 'string':
      return parsedValue.value;
    case 'number':
      return parsedValue.value;
    case 'expression':
      return evaluateExpression(parsedValue.ast, ctx);
    default:
      return parsedValue.value;
  }
}

/**
 * Execute a parsed script and produce an action result.
 *
 * @param {string} scriptText - Raw script text
 * @param {object} [marketCtx] - Market/account data context
 * @returns {{ success: boolean, action: object|null, errors: Array, warnings: Array, log: Array }}
 */
function execute(scriptText, marketCtx = {}) {
  const { commands, errors: parseErrors } = parse(scriptText);

  if (parseErrors.length > 0) {
    return {
      success: false,
      action: null,
      errors: parseErrors,
      warnings: [],
      log: [],
    };
  }

  const warnings = validate(commands);
  const ctx = { ...defaultContext(), ...marketCtx };
  const log = [];
  const order = {
    route: null,
    price: null,
    shares: null,
    side: null,
    tif: 'DAY',
    orderType: 'LIMIT',
    stopPrice: null,
    stopType: null,
    trailPrice: null,
    display: null,
  };
  let action = null;
  const errors = [];

  for (const cmd of commands) {
    try {
      switch (cmd.command) {
        case 'ROUTE': {
          const val = resolveValue(cmd.value, ctx);
          order.route = String(val);
          log.push({ command: 'ROUTE', value: order.route, line: cmd.line });
          break;
        }

        case 'PRICE': {
          const val = resolveValue(cmd.value, ctx);
          order.price = typeof val === 'number' ? Math.round(val * 100) / 100 : parseFloat(val);
          ctx.PRICE = order.price; // Update context for StopPrice references
          log.push({ command: 'PRICE', value: order.price, line: cmd.line });
          break;
        }

        case 'SHARE': {
          const val = resolveValue(cmd.value, ctx);
          order.shares = typeof val === 'number' ? Math.max(0, Math.round(val)) : parseInt(val, 10);
          log.push({ command: 'SHARE', value: order.shares, line: cmd.line });
          break;
        }

        case 'SIDE': {
          const val = resolveValue(cmd.value, ctx);
          const side = String(val).toUpperCase();
          if (side === 'B' || side === 'BUY') {
            order.side = 'BUY';
          } else if (side === 'S' || side === 'SELL') {
            order.side = 'SELL';
          } else {
            throw new ExecutionError(`Invalid side: "${val}"`, 'SIDE', cmd.line);
          }
          log.push({ command: 'SIDE', value: order.side, line: cmd.line });
          break;
        }

        case 'TIF': {
          const val = String(resolveValue(cmd.value, ctx)).toUpperCase();
          order.tif = val;
          log.push({ command: 'TIF', value: val, line: cmd.line });
          break;
        }

        case 'ORDTYPE': {
          const val = String(resolveValue(cmd.value, ctx)).toUpperCase();
          order.orderType = val;
          log.push({ command: 'ORDTYPE', value: val, line: cmd.line });
          break;
        }

        case 'STOPPRICE': {
          const val = resolveValue(cmd.value, ctx);
          order.stopPrice = typeof val === 'number' ? Math.round(val * 100) / 100 : parseFloat(val);
          log.push({ command: 'STOPPRICE', value: order.stopPrice, line: cmd.line });
          break;
        }

        case 'STOPTYPE': {
          const val = String(resolveValue(cmd.value, ctx)).toUpperCase();
          order.stopType = val;
          log.push({ command: 'STOPTYPE', value: val, line: cmd.line });
          break;
        }

        case 'TRAILPRICE': {
          const val = resolveValue(cmd.value, ctx);
          order.trailPrice = typeof val === 'number' ? Math.round(val * 100) / 100 : parseFloat(val);
          log.push({ command: 'TRAILPRICE', value: order.trailPrice, line: cmd.line });
          break;
        }

        case 'DISPLAY': {
          const val = resolveValue(cmd.value, ctx);
          order.display = typeof val === 'number' ? Math.max(0, Math.round(val)) : parseInt(val, 10);
          log.push({ command: 'DISPLAY', value: order.display, line: cmd.line });
          break;
        }

        case 'DEFSHARE': {
          const val = resolveValue(cmd.value, ctx);
          ctx.DEFSHARE = typeof val === 'number' ? Math.max(0, Math.round(val)) : parseInt(val, 10);
          log.push({ command: 'DEFSHARE', value: ctx.DEFSHARE, line: cmd.line });
          break;
        }

        case 'BUY': {
          order.side = 'BUY';
          action = { type: 'SEND_ORDER', order: { ...order } };
          log.push({ command: 'BUY', value: 'SEND', line: cmd.line });
          break;
        }

        case 'SELL': {
          order.side = 'SELL';
          action = { type: 'SEND_ORDER', order: { ...order } };
          log.push({ command: 'SELL', value: 'SEND', line: cmd.line });
          break;
        }

        case 'SHORT': {
          order.side = 'SHORT';
          action = { type: 'SEND_ORDER', order: { ...order } };
          log.push({ command: 'SHORT', value: 'SEND', line: cmd.line });
          break;
        }

        case 'COVER': {
          order.side = 'COVER';
          action = { type: 'SEND_ORDER', order: { ...order } };
          log.push({ command: 'COVER', value: 'SEND', line: cmd.line });
          break;
        }

        case 'STOP': {
          action = { type: 'SEND_STOP', order: { ...order } };
          log.push({ command: 'STOP', value: 'SEND', line: cmd.line });
          break;
        }

        case 'CXL': {
          action = { type: 'CANCEL_ALL' };
          log.push({ command: 'CXL', value: null, line: cmd.line });
          break;
        }

        case 'PANIC': {
          action = { type: 'PANIC_CLOSE' };
          log.push({ command: 'PANIC', value: null, line: cmd.line });
          break;
        }

        default:
          warnings.push({ type: 'warning', message: `Unhandled command: ${cmd.command}`, line: cmd.line });
          log.push({ command: cmd.command, value: 'SKIPPED', line: cmd.line });
      }
    } catch (e) {
      errors.push({
        message: e.message,
        command: cmd.command,
        line: cmd.line,
      });
    }
  }

  return {
    success: errors.length === 0,
    action,
    errors,
    warnings,
    log,
  };
}

module.exports = {
  execute,
  evaluateExpression,
  resolveValue,
  defaultContext,
  ExecutionError,
};
