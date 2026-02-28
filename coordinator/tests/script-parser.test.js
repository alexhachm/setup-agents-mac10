'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const {
  parse,
  validate,
  parseValue,
  parseStatement,
  tokenizeExpression,
  parseExpressionAST,
  ParseError,
} = require('../src/script-parser');

describe('tokenizeExpression', () => {
  it('should tokenize numbers', () => {
    const tokens = tokenizeExpression('42');
    assert.strictEqual(tokens.length, 1);
    assert.strictEqual(tokens[0].type, 'NUMBER');
    assert.strictEqual(tokens[0].value, 42);
  });

  it('should tokenize decimal numbers', () => {
    const tokens = tokenizeExpression('0.05');
    assert.strictEqual(tokens.length, 1);
    assert.strictEqual(tokens[0].value, 0.05);
  });

  it('should tokenize variables', () => {
    const tokens = tokenizeExpression('ASK');
    assert.strictEqual(tokens.length, 1);
    assert.strictEqual(tokens[0].type, 'VARIABLE');
    assert.strictEqual(tokens[0].value, 'ASK');
  });

  it('should tokenize expressions with operators', () => {
    const tokens = tokenizeExpression('Ask+0.05');
    assert.strictEqual(tokens.length, 3);
    assert.strictEqual(tokens[0].value, 'ASK');
    assert.strictEqual(tokens[1].value, '+');
    assert.strictEqual(tokens[2].value, 0.05);
  });

  it('should tokenize complex expressions', () => {
    const tokens = tokenizeExpression('BP*0.25');
    assert.strictEqual(tokens.length, 3);
    assert.strictEqual(tokens[0].value, 'BP');
    assert.strictEqual(tokens[1].value, '*');
    assert.strictEqual(tokens[2].value, 0.25);
  });

  it('should handle parentheses', () => {
    const tokens = tokenizeExpression('(Ask+Bid)/2');
    assert.strictEqual(tokens.length, 7);
    assert.strictEqual(tokens[0].type, 'LPAREN');
    assert.strictEqual(tokens[4].type, 'RPAREN');
  });

  it('should throw on invalid characters', () => {
    assert.throws(() => tokenizeExpression('ASK@BID'), /Unexpected character/);
  });
});

describe('parseExpressionAST', () => {
  it('should parse a single number', () => {
    const tokens = tokenizeExpression('42');
    const ast = parseExpressionAST(tokens);
    assert.deepStrictEqual(ast, { type: 'number', value: 42 });
  });

  it('should parse a single variable', () => {
    const tokens = tokenizeExpression('ASK');
    const ast = parseExpressionAST(tokens);
    assert.deepStrictEqual(ast, { type: 'variable', name: 'ASK' });
  });

  it('should parse addition', () => {
    const tokens = tokenizeExpression('ASK+0.05');
    const ast = parseExpressionAST(tokens);
    assert.strictEqual(ast.type, 'binary');
    assert.strictEqual(ast.op, '+');
    assert.deepStrictEqual(ast.left, { type: 'variable', name: 'ASK' });
    assert.deepStrictEqual(ast.right, { type: 'number', value: 0.05 });
  });

  it('should respect operator precedence (multiply before add)', () => {
    const tokens = tokenizeExpression('BP*0.25+100');
    const ast = parseExpressionAST(tokens);
    assert.strictEqual(ast.type, 'binary');
    assert.strictEqual(ast.op, '+');
    assert.strictEqual(ast.left.type, 'binary');
    assert.strictEqual(ast.left.op, '*');
  });

  it('should parse parenthesized expressions', () => {
    const tokens = tokenizeExpression('(ASK+BID)/2');
    const ast = parseExpressionAST(tokens);
    assert.strictEqual(ast.type, 'binary');
    assert.strictEqual(ast.op, '/');
    assert.strictEqual(ast.left.type, 'binary');
    assert.strictEqual(ast.left.op, '+');
  });

  it('should parse unary minus', () => {
    const tokens = tokenizeExpression('-0.10');
    const ast = parseExpressionAST(tokens);
    assert.strictEqual(ast.type, 'unary');
    assert.strictEqual(ast.op, '-');
    assert.deepStrictEqual(ast.operand, { type: 'number', value: 0.10 });
  });
});

describe('parseValue', () => {
  it('should parse string values', () => {
    const result = parseValue('ARCA');
    assert.strictEqual(result.type, 'string');
    assert.strictEqual(result.value, 'ARCA');
  });

  it('should parse numeric values', () => {
    const result = parseValue('100');
    assert.strictEqual(result.type, 'number');
    assert.strictEqual(result.value, 100);
  });

  it('should parse expression values', () => {
    const result = parseValue('Ask+0.05');
    assert.strictEqual(result.type, 'expression');
    assert.ok(result.ast);
  });

  it('should return string for unknown identifiers', () => {
    const result = parseValue('MYROUTE');
    assert.strictEqual(result.type, 'string');
    assert.strictEqual(result.value, 'MYROUTE');
  });

  it('should parse SEND as string', () => {
    const result = parseValue('Send');
    assert.strictEqual(result.type, 'string');
    assert.strictEqual(result.value, 'SEND');
  });
});

describe('parseStatement', () => {
  it('should parse key=value statements', () => {
    const result = parseStatement('ROUTE=ARCA', 1);
    assert.strictEqual(result.command, 'ROUTE');
    assert.strictEqual(result.value.type, 'string');
    assert.strictEqual(result.value.value, 'ARCA');
    assert.strictEqual(result.line, 1);
  });

  it('should parse standalone commands', () => {
    const result = parseStatement('CXL', 1);
    assert.strictEqual(result.command, 'CXL');
    assert.strictEqual(result.value, null);
  });

  it('should parse PANIC', () => {
    const result = parseStatement('PANIC', 1);
    assert.strictEqual(result.command, 'PANIC');
  });

  it('should return null for comments', () => {
    assert.strictEqual(parseStatement('// this is a comment', 1), null);
  });

  it('should return null for empty strings', () => {
    assert.strictEqual(parseStatement('', 1), null);
    assert.strictEqual(parseStatement('  ', 1), null);
  });

  it('should throw on unknown commands', () => {
    assert.throws(() => parseStatement('FOOBAR=123', 1), /Unknown command/);
  });

  it('should normalize SHARES to SHARE', () => {
    const result = parseStatement('SHARES=100', 1);
    assert.strictEqual(result.command, 'SHARE');
  });
});

describe('parse', () => {
  it('should parse a full single-line script', () => {
    const { commands, errors } = parse('ROUTE=ARCA;Price=Ask+0.05;Share=100;TIF=DAY;BUY=Send');
    assert.strictEqual(errors.length, 0);
    assert.strictEqual(commands.length, 5);
    assert.strictEqual(commands[0].command, 'ROUTE');
    assert.strictEqual(commands[1].command, 'PRICE');
    assert.strictEqual(commands[2].command, 'SHARE');
    assert.strictEqual(commands[3].command, 'TIF');
    assert.strictEqual(commands[4].command, 'BUY');
  });

  it('should parse multi-line scripts', () => {
    const script = `
ROUTE=ARCA
Price=Ask+0.05
Share=BP*0.25
TIF=DAY
BUY=Send
    `;
    const { commands, errors } = parse(script);
    assert.strictEqual(errors.length, 0);
    assert.strictEqual(commands.length, 5);
  });

  it('should handle comments', () => {
    const script = `
// Buy script
ROUTE=ARCA  // use ARCA
Price=Ask+0.05
BUY=Send
    `;
    const { commands, errors } = parse(script);
    assert.strictEqual(errors.length, 0);
    assert.strictEqual(commands.length, 3);
  });

  it('should collect parse errors', () => {
    const { commands, errors } = parse('FOOBAR=123');
    assert.strictEqual(errors.length, 1);
    assert.ok(errors[0].message.includes('Unknown command'));
  });

  it('should handle standalone commands', () => {
    const { commands, errors } = parse('CXL');
    assert.strictEqual(errors.length, 0);
    assert.strictEqual(commands.length, 1);
    assert.strictEqual(commands[0].command, 'CXL');
  });

  it('should handle empty input', () => {
    const { commands, errors } = parse('');
    assert.strictEqual(errors.length, 1);
    assert.ok(errors[0].message.includes('Empty'));
  });

  it('should handle null input', () => {
    const { commands, errors } = parse(null);
    assert.strictEqual(errors.length, 1);
  });

  it('should parse a DAS-style sell script', () => {
    const script = 'ROUTE=ARCA;Price=Bid-0.02;Share=Pos*0.50;TIF=DAY;SELL=Send';
    const { commands, errors } = parse(script);
    assert.strictEqual(errors.length, 0);
    assert.strictEqual(commands.length, 5);
    assert.strictEqual(commands[4].command, 'SELL');
  });
});

describe('validate', () => {
  it('should warn about missing route', () => {
    const { commands } = parse('Price=Ask;Share=100;BUY=Send');
    const warnings = validate(commands);
    assert.ok(warnings.some(w => w.message.includes('ROUTE')));
  });

  it('should warn about missing price', () => {
    const { commands } = parse('ROUTE=ARCA;Share=100;BUY=Send');
    const warnings = validate(commands);
    assert.ok(warnings.some(w => w.message.includes('PRICE')));
  });

  it('should warn about missing shares', () => {
    const { commands } = parse('ROUTE=ARCA;Price=Ask;BUY=Send');
    const warnings = validate(commands);
    assert.ok(warnings.some(w => w.message.includes('SHARE')));
  });

  it('should not warn for standalone commands', () => {
    const { commands } = parse('CXL');
    const warnings = validate(commands);
    assert.strictEqual(warnings.length, 0);
  });

  it('should not warn for PANIC', () => {
    const { commands } = parse('PANIC');
    const warnings = validate(commands);
    assert.strictEqual(warnings.length, 0);
  });

  it('should not warn for complete order', () => {
    const { commands } = parse('ROUTE=ARCA;Price=Ask+0.05;Share=100;BUY=Send');
    const warnings = validate(commands);
    assert.strictEqual(warnings.length, 0);
  });
});
