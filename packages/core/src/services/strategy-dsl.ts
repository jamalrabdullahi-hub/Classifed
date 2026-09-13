import type { Candle } from '../ports/history';
import { ValidationError } from '../domain/errors';

/**
 * The restricted strategy language for CUSTOM Algo offerings.
 *
 * A participant writes a single expression; it is evaluated on the last bar's
 * candles and its **sign** is the position: `> 0` long, `< 0` short, `0` flat.
 *
 *   sma(12) - sma(48)              // momentum
 *   sma(20) - close                // mean reversion
 *   (close > sma(200)) * (rsi(14) < 70)   // long only when a filter passes
 *
 * ## Why this is a parser, not `eval`
 *
 * These expressions run on the worker — a process holding a key that places
 * real orders. Feeding participant text to `eval`/`new Function` would be
 * remote code execution on a live trading box: `process.env`, `require`, an
 * infinite loop. So this is a hand-written tokenizer + recursive-descent parser
 * and a whitelist of numeric functions over closes. There is no syntax that can
 * reach the host, no I/O, and a hard budget on length, tokens and depth.
 *
 * Comparisons and boolean operators yield `1`/`0`; `and`/`or`/`not` treat a
 * non-zero value as true. The whole expression is arithmetic — nothing else.
 */

const MAX_LENGTH = 500;
const MAX_TOKENS = 300;
const MAX_DEPTH = 24;

type TokenType = 'number' | 'ident' | 'op' | 'lparen' | 'rparen' | 'comma';
interface Token {
  type: TokenType;
  value: string;
  pos: number;
}

const OPERATORS = [
  '>=',
  '<=',
  '==',
  '!=',
  '&&',
  '||',
  '>',
  '<',
  '+',
  '-',
  '*',
  '/',
  '%',
  '!',
];

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < input.length) {
    const ch = input[i]!;

    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }

    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(input[i + 1] ?? ''))) {
      let j = i;
      while (j < input.length && /[0-9.]/.test(input[j]!)) j += 1;
      tokens.push({ type: 'number', value: input.slice(i, j), pos: i });
      i = j;
      continue;
    }

    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < input.length && /[A-Za-z0-9_]/.test(input[j]!)) j += 1;
      tokens.push({ type: 'ident', value: input.slice(i, j), pos: i });
      i = j;
      continue;
    }

    if (ch === '(') {
      tokens.push({ type: 'lparen', value: ch, pos: i });
      i += 1;
      continue;
    }
    if (ch === ')') {
      tokens.push({ type: 'rparen', value: ch, pos: i });
      i += 1;
      continue;
    }
    if (ch === ',') {
      tokens.push({ type: 'comma', value: ch, pos: i });
      i += 1;
      continue;
    }

    const two = input.slice(i, i + 2);
    const op = OPERATORS.find((candidate) => candidate === two) ?? OPERATORS.find((c) => c === ch);
    if (op) {
      tokens.push({ type: 'op', value: op, pos: i });
      i += op.length;
      continue;
    }

    throw new ValidationError(`Unexpected character "${ch}" at position ${i} in the expression`);
  }

  if (tokens.length > MAX_TOKENS) {
    throw new ValidationError('The expression is too long');
  }
  return tokens;
}

type Node =
  | { kind: 'num'; value: number }
  | { kind: 'series'; name: string }
  | { kind: 'call'; name: string; args: Node[] }
  | { kind: 'unary'; op: string; operand: Node }
  | { kind: 'binary'; op: string; left: Node; right: Node };

/** The close series (and other simple series) an expression may read. */
const SERIES = new Set(['close', 'open', 'high', 'low', 'volume', 'prev']);

/** Functions, and how many arguments each takes (min, max). */
const FUNCTIONS: Record<string, [number, number]> = {
  sma: [1, 1],
  avg: [1, 1],
  ema: [1, 1],
  rsi: [1, 1],
  highest: [1, 1],
  lowest: [1, 1],
  change: [1, 1],
  pct: [1, 1],
  abs: [1, 1],
  min: [2, 2],
  max: [2, 2],
};

class Parser {
  private index = 0;
  constructor(private readonly tokens: Token[]) {}

  private peek(): Token | undefined {
    return this.tokens[this.index];
  }

  private next(): Token {
    const token = this.tokens[this.index];
    if (!token) throw new ValidationError('Unexpected end of expression');
    this.index += 1;
    return token;
  }

  private isOp(...ops: string[]): boolean {
    const token = this.peek();
    return token?.type === 'op' && ops.includes(token.value);
  }

  parse(depth = 0): Node {
    if (depth > MAX_DEPTH) throw new ValidationError('The expression is nested too deeply');
    const node = this.parseOr(depth);
    if (this.index !== this.tokens.length) {
      throw new ValidationError(`Unexpected "${this.peek()?.value}" in the expression`);
    }
    return node;
  }

  private parseOr(depth: number): Node {
    let left = this.parseAnd(depth);
    while (this.isOp('||') || (this.peek()?.type === 'ident' && this.peek()!.value === 'or')) {
      this.next();
      left = { kind: 'binary', op: '||', left, right: this.parseAnd(depth) };
    }
    return left;
  }

  private parseAnd(depth: number): Node {
    let left = this.parseComparison(depth);
    while (this.isOp('&&') || (this.peek()?.type === 'ident' && this.peek()!.value === 'and')) {
      this.next();
      left = { kind: 'binary', op: '&&', left, right: this.parseComparison(depth) };
    }
    return left;
  }

  private parseComparison(depth: number): Node {
    let left = this.parseAdditive(depth);
    while (this.isOp('>', '<', '>=', '<=', '==', '!=')) {
      const op = this.next().value;
      left = { kind: 'binary', op, left, right: this.parseAdditive(depth) };
    }
    return left;
  }

  private parseAdditive(depth: number): Node {
    let left = this.parseMultiplicative(depth);
    while (this.isOp('+', '-')) {
      const op = this.next().value;
      left = { kind: 'binary', op, left, right: this.parseMultiplicative(depth) };
    }
    return left;
  }

  private parseMultiplicative(depth: number): Node {
    let left = this.parseUnary(depth);
    while (this.isOp('*', '/', '%')) {
      const op = this.next().value;
      left = { kind: 'binary', op, left, right: this.parseUnary(depth) };
    }
    return left;
  }

  private parseUnary(depth: number): Node {
    if (this.isOp('!') || this.isOp('-', '+') || (this.peek()?.type === 'ident' && this.peek()!.value === 'not')) {
      const token = this.next();
      const op = token.value === 'not' ? '!' : token.value;
      return { kind: 'unary', op, operand: this.parseUnary(depth) };
    }
    return this.parsePrimary(depth);
  }

  private parsePrimary(depth: number): Node {
    const token = this.next();
    if (token.type === 'number') {
      const value = Number(token.value);
      if (!Number.isFinite(value)) throw new ValidationError(`"${token.value}" is not a number`);
      return { kind: 'num', value };
    }
    if (token.type === 'lparen') {
      const inner = this.parseOr(depth + 1);
      const close = this.next();
      if (close.type !== 'rparen') throw new ValidationError('Missing ")" in the expression');
      return inner;
    }
    if (token.type === 'ident') {
      const name = token.value.toLowerCase();
      if (this.peek()?.type === 'lparen') {
        this.next();
        const args: Node[] = [];
        if (this.peek()?.type !== 'rparen') {
          args.push(this.parseOr(depth + 1));
          while (this.peek()?.type === 'comma') {
            this.next();
            args.push(this.parseOr(depth + 1));
          }
        }
        const close = this.next();
        if (close.type !== 'rparen') throw new ValidationError('Missing ")" in the expression');
        const spec = FUNCTIONS[name];
        if (!spec) throw new ValidationError(`Unknown function "${name}"`);
        if (args.length < spec[0] || args.length > spec[1]) {
          throw new ValidationError(`"${name}" takes ${spec[0]} argument${spec[0] === 1 ? '' : 's'}`);
        }
        return { kind: 'call', name, args };
      }
      if (SERIES.has(name)) return { kind: 'series', name };
      if (name === 'true') return { kind: 'num', value: 1 };
      if (name === 'false') return { kind: 'num', value: 0 };
      throw new ValidationError(`Unknown name "${token.value}"`);
    }
    throw new ValidationError(`Unexpected "${token.value}" in the expression`);
  }
}

/** A parsed, reusable expression. */
export interface CompiledExpression {
  readonly source: string;
  evaluate(candles: Candle[]): number | null;
}

function closesOf(candles: Candle[], field: 'close' | 'open' | 'high' | 'low' | 'volume'): number[] {
  return candles.map((candle) => candle[field]);
}

function sma(values: number[], n: number): number {
  if (n < 1 || values.length < n) return NaN;
  let sum = 0;
  for (let i = values.length - n; i < values.length; i += 1) sum += values[i]!;
  return sum / n;
}

function ema(values: number[], n: number): number {
  if (n < 1 || values.length < n) return NaN;
  const k = 2 / (n + 1);
  let value = values[0]!;
  for (let i = 1; i < values.length; i += 1) value = values[i]! * k + value * (1 - k);
  return value;
}

function rsi(values: number[], n: number): number {
  if (n < 1 || values.length < n + 1) return NaN;
  let gains = 0;
  let losses = 0;
  for (let i = values.length - n; i < values.length; i += 1) {
    const delta = values[i]! - values[i - 1]!;
    if (delta >= 0) gains += delta;
    else losses -= delta;
  }
  if (losses === 0) return 100;
  const rs = gains / losses;
  return 100 - 100 / (1 + rs);
}

function highest(values: number[], n: number): number {
  if (n < 1 || values.length < n) return NaN;
  return Math.max(...values.slice(values.length - n));
}

function lowest(values: number[], n: number): number {
  if (n < 1 || values.length < n) return NaN;
  return Math.min(...values.slice(values.length - n));
}

function evaluateNode(node: Node, candles: Candle[]): number {
  switch (node.kind) {
    case 'num':
      return node.value;
    case 'series': {
      const field = node.name === 'prev' ? 'close' : (node.name as 'close' | 'open' | 'high' | 'low' | 'volume');
      const series = closesOf(candles, field);
      if (node.name === 'prev') return series[series.length - 2] ?? NaN;
      return series[series.length - 1] ?? NaN;
    }
    case 'unary': {
      const operand = evaluateNode(node.operand, candles);
      if (node.op === '-') return -operand;
      if (node.op === '+') return operand;
      return operand ? 0 : 1; // '!'
    }
    case 'call': {
      const args = node.args.map((arg) => evaluateNode(arg, candles));
      const closes = closesOf(candles, 'close');
      const n = Math.floor(args[0]!);
      switch (node.name) {
        case 'sma':
        case 'avg':
          return sma(closes, n);
        case 'ema':
          return ema(closes, n);
        case 'rsi':
          return rsi(closes, n);
        case 'highest':
          return highest(closes, n);
        case 'lowest':
          return lowest(closes, n);
        case 'change':
          return closes[closes.length - 1]! - (closes[closes.length - 1 - n] ?? NaN);
        case 'pct': {
          const past = closes[closes.length - 1 - n] ?? NaN;
          const last = closes[closes.length - 1]!;
          return past === 0 ? NaN : ((last - past) / past) * 100;
        }
        case 'abs':
          return Math.abs(args[0]!);
        case 'min':
          return Math.min(args[0]!, args[1]!);
        case 'max':
          return Math.max(args[0]!, args[1]!);
        default:
          return NaN;
      }
    }
    case 'binary': {
      const left = evaluateNode(node.left, candles);
      const right = evaluateNode(node.right, candles);
      switch (node.op) {
        case '+':
          return left + right;
        case '-':
          return left - right;
        case '*':
          return left * right;
        case '/':
          return right === 0 ? NaN : left / right;
        case '%':
          return right === 0 ? NaN : left % right;
        case '>':
          return left > right ? 1 : 0;
        case '<':
          return left < right ? 1 : 0;
        case '>=':
          return left >= right ? 1 : 0;
        case '<=':
          return left <= right ? 1 : 0;
        case '==':
          return left === right ? 1 : 0;
        case '!=':
          return left !== right ? 1 : 0;
        case '&&':
          return left && right ? 1 : 0;
        case '||':
          return left || right ? 1 : 0;
        default:
          return NaN;
      }
    }
    default:
      return NaN;
  }
}

/** Parses an expression once, throwing on any syntax error. */
export function compileExpression(source: string): CompiledExpression {
  const text = source.trim();
  if (text.length === 0) throw new ValidationError('The expression is empty');
  if (text.length > MAX_LENGTH) throw new ValidationError('The expression is too long');

  const ast = new Parser(tokenize(text)).parse();

  return {
    source: text,
    evaluate(candles: Candle[]): number | null {
      if (candles.length < 2) return null;
      const value = evaluateNode(ast, candles);
      return Number.isFinite(value) ? value : null;
    },
  };
}

/** Convenience: parse + evaluate in one call. */
export function evaluateExpression(source: string, candles: Candle[]): number | null {
  return compileExpression(source).evaluate(candles);
}
