'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const {
  execute,
  evaluateExpression,
  resolveValue,
  defaultContext,
  ExecutionError,
} = require('../src/script-executor');
const { parseValue, parseExpressionAST, tokenizeExpression } = require('../src/script-parser');

describe('evaluateExpression', () => {
  it('should evaluate a number literal', () => {
    const ast = { type: 'number', value: 42 };
    assert.strictEqual(evaluateExpression(ast, {}), 42);
  });

  it('should evaluate a variable', () => {
    const ast = { type: 'variable', name: 'ASK' };
    assert.strictEqual(evaluateExpression(ast, { ASK: 150.25 }), 150.25);
  });

  it('should evaluate addition', () => {
    const tokens = tokenizeExpression('ASK+0.05');
    const ast = parseExpressionAST(tokens);
    assert.strictEqual(evaluateExpression(ast, { ASK: 150.00 }), 150.05);
  });

  it('should evaluate subtraction', () => {
    const tokens = tokenizeExpression('BID-0.02');
    const ast = parseExpressionAST(tokens);
    const result = evaluateExpression(ast, { BID: 149.98 });
    assert.ok(Math.abs(result - 149.96) < 0.001);
  });

  it('should evaluate multiplication', () => {
    const tokens = tokenizeExpression('BP*0.25');
    const ast = parseExpressionAST(tokens);
    assert.strictEqual(evaluateExpression(ast, { BP: 100000 }), 25000);
  });

  it('should evaluate division', () => {
    const tokens = tokenizeExpression('POS/2');
    const ast = parseExpressionAST(tokens);
    assert.strictEqual(evaluateExpression(ast, { POS: 500 }), 250);
  });

  it('should throw on division by zero', () => {
    const tokens = tokenizeExpression('POS/0');
    const ast = parseExpressionAST(tokens);
    assert.throws(() => evaluateExpression(ast, { POS: 500 }), /Division by zero/);
  });

  it('should throw on unknown variable', () => {
    const ast = { type: 'variable', name: 'UNKNOWN' };
    assert.throws(() => evaluateExpression(ast, {}), /Unknown variable/);
  });

  it('should evaluate unary minus', () => {
    const ast = { type: 'unary', op: '-', operand: { type: 'number', value: 5 } };
    assert.strictEqual(evaluateExpression(ast, {}), -5);
  });

  it('should respect operator precedence', () => {
    const tokens = tokenizeExpression('ASK+BID*2');
    const ast = parseExpressionAST(tokens);
    const result = evaluateExpression(ast, { ASK: 100, BID: 50 });
    assert.strictEqual(result, 200); // 100 + 50*2 = 200
  });
});

describe('resolveValue', () => {
  it('should resolve string values', () => {
    assert.strictEqual(resolveValue({ type: 'string', value: 'ARCA' }, {}), 'ARCA');
  });

  it('should resolve number values', () => {
    assert.strictEqual(resolveValue({ type: 'number', value: 100 }, {}), 100);
  });

  it('should resolve expression values', () => {
    const tokens = tokenizeExpression('ASK+0.05');
    const ast = parseExpressionAST(tokens);
    assert.strictEqual(resolveValue({ type: 'expression', ast }, { ASK: 150 }), 150.05);
  });

  it('should return null for null input', () => {
    assert.strictEqual(resolveValue(null, {}), null);
  });
});

describe('execute', () => {
  it('should execute a simple buy script', () => {
    const script = 'ROUTE=ARCA;Price=Ask+0.05;Share=100;TIF=DAY;BUY=Send';
    const result = execute(script, { ASK: 150.00 });
    assert.strictEqual(result.success, true);
    assert.ok(result.action);
    assert.strictEqual(result.action.type, 'SEND_ORDER');
    assert.strictEqual(result.action.order.route, 'ARCA');
    assert.strictEqual(result.action.order.price, 150.05);
    assert.strictEqual(result.action.order.shares, 100);
    assert.strictEqual(result.action.order.side, 'BUY');
    assert.strictEqual(result.action.order.tif, 'DAY');
  });

  it('should execute a sell script', () => {
    const script = 'ROUTE=ARCA;Price=Bid-0.02;Share=Pos*0.50;SELL=Send';
    const result = execute(script, { BID: 150.00, POS: 200 });
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.action.type, 'SEND_ORDER');
    assert.strictEqual(result.action.order.side, 'SELL');
    assert.strictEqual(result.action.order.shares, 100); // 200 * 0.50
    assert.ok(Math.abs(result.action.order.price - 149.98) < 0.001);
  });

  it('should execute CXL', () => {
    const result = execute('CXL');
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.action.type, 'CANCEL_ALL');
  });

  it('should execute PANIC', () => {
    const result = execute('PANIC');
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.action.type, 'PANIC_CLOSE');
  });

  it('should handle stop orders', () => {
    const script = 'ROUTE=ARCA;StopPrice=Price-0.10;StopType=Market;STOP=Send';
    const result = execute(script, { PRICE: 150.00 });
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.action.type, 'SEND_STOP');
    assert.ok(Math.abs(result.action.order.stopPrice - 149.90) < 0.001);
    assert.strictEqual(result.action.order.stopType, 'MARKET');
  });

  it('should track execution log', () => {
    const script = 'ROUTE=ARCA;Price=Ask;BUY=Send';
    const result = execute(script, { ASK: 150.00 });
    assert.ok(result.log.length >= 3);
    assert.strictEqual(result.log[0].command, 'ROUTE');
  });

  it('should report parse errors', () => {
    const result = execute('UNKNOWN=123');
    assert.strictEqual(result.success, false);
    assert.ok(result.errors.length > 0);
  });

  it('should report execution errors', () => {
    // Use an expression with an undefined variable
    const script = 'Share=UNKNOWN_VAR*100;BUY=Send';
    const result = execute(script);
    assert.strictEqual(result.success, false);
    assert.ok(result.errors.length > 0);
  });

  it('should handle default share size', () => {
    const script = 'DefShare=200;Share=DEFSHARE;BUY=Send';
    const result = execute(script);
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.action.order.shares, 200);
  });

  it('should round share count to integer', () => {
    const script = 'Share=BP*0.25;BUY=Send';
    const result = execute(script, { BP: 333 });
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.action.order.shares, 83); // 333 * 0.25 = 83.25, rounded to 83
  });

  it('should round price to 2 decimals', () => {
    const script = 'Price=Ask+0.033;BUY=Send';
    const result = execute(script, { ASK: 150.00 });
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.action.order.price, 150.03);
  });

  it('should handle multi-line scripts', () => {
    const script = `
ROUTE=ARCA
Price=Ask+0.05
Share=100
TIF=DAY
BUY=Send
    `;
    const result = execute(script, { ASK: 150.00 });
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.action.type, 'SEND_ORDER');
    assert.strictEqual(result.action.order.side, 'BUY');
  });

  it('should handle SHORT orders', () => {
    const script = 'ROUTE=ARCA;Price=Bid;Share=100;SHORT=Send';
    const result = execute(script, { BID: 150.00 });
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.action.order.side, 'SHORT');
  });

  it('should handle COVER orders', () => {
    const script = 'ROUTE=ARCA;Price=Ask;Share=100;COVER=Send';
    const result = execute(script, { ASK: 150.00 });
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.action.order.side, 'COVER');
  });

  it('should use default context when no market data provided', () => {
    const script = 'Share=DEFSHARE;BUY=Send';
    const result = execute(script);
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.action.order.shares, 100); // default DEFSHARE
  });
});

describe('defaultContext', () => {
  it('should have all expected market variables', () => {
    const ctx = defaultContext();
    assert.ok('ASK' in ctx);
    assert.ok('BID' in ctx);
    assert.ok('LAST' in ctx);
    assert.ok('HIGH' in ctx);
    assert.ok('LOW' in ctx);
    assert.ok('BP' in ctx);
    assert.ok('POS' in ctx);
    assert.ok('AVGCOST' in ctx);
    assert.ok('DEFSHARE' in ctx);
  });

  it('should default DEFSHARE to 100', () => {
    assert.strictEqual(defaultContext().DEFSHARE, 100);
  });
});
