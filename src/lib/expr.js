// A tiny, safe arithmetic/boolean expression language for the declarative model format
// (src/models/objects/*.json). Numbers in a model file may be written as strings so that a shape can be
// placed with maths instead of code: "190 * cos(f * TAU)" inside a `repeat`, or "hypot(x, z) > 60" as a
// cut-out mask. Expressions are parsed once into a closure tree, so a mask costs about one call per point.
//
// There is no `eval` and no property access anywhere: the only things an expression can reach are the
// constants and functions below plus the variables the caller declares, so a model file can never run code.

const CONSTS = {
  PI: Math.PI, TAU: Math.PI * 2, E: Math.E, DEG: Math.PI / 180,
  SQRT2: Math.SQRT2, GOLDEN: (1 + Math.sqrt(5)) / 2, Infinity,
};

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const FNS = {
  sin: [1, Math.sin], cos: [1, Math.cos], tan: [1, Math.tan],
  asin: [1, Math.asin], acos: [1, Math.acos], atan: [1, Math.atan], atan2: [2, Math.atan2],
  sqrt: [1, Math.sqrt], cbrt: [1, Math.cbrt], abs: [1, Math.abs], sign: [1, Math.sign],
  floor: [1, Math.floor], ceil: [1, Math.ceil], round: [1, Math.round], trunc: [1, Math.trunc],
  exp: [1, Math.exp], log: [1, Math.log], pow: [2, Math.pow],
  min: [-1, Math.min], max: [-1, Math.max], hypot: [-1, Math.hypot],
  mod: [2, (a, b) => ((a % b) + b) % b],
  clamp: [3, clamp],
  lerp: [3, (a, b, t) => a + (b - a) * t],
  step: [2, (edge, x) => (x < edge ? 0 : 1)],
  smoothstep: [3, (a, b, x) => { const t = clamp((x - a) / (b - a || 1e-12), 0, 1); return t * t * (3 - 2 * t); }],
  deg: [1, (d) => (d * Math.PI) / 180],
  if: [3, (c, a, b) => (c ? a : b)],
};

export const EXPR_FUNCTIONS = Object.keys(FNS).sort();
export const EXPR_CONSTANTS = Object.keys(CONSTS).sort();

// ------------------------------------------------------------------ tokenizer
const PUNCT = ['<=', '>=', '==', '!=', '&&', '||', '+', '-', '*', '/', '%', '^', '(', ')', ',', '<', '>', '!', '?', ':'];

function tokenize(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
    if (c >= '0' && c <= '9' || (c === '.' && src[i + 1] >= '0' && src[i + 1] <= '9')) {
      const m = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(src.slice(i));
      out.push({ t: 'num', v: parseFloat(m[0]), at: i });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
      out.push({ t: 'name', v: m[0], at: i });
      i += m[0].length;
      continue;
    }
    const p = PUNCT.find((q) => src.startsWith(q, i));
    if (!p) throw new ExprError(`unexpected character ${JSON.stringify(c)}`, src, i);
    out.push({ t: p, at: i });
    i += p.length;
  }
  out.push({ t: 'end', at: src.length });
  return out;
}

export class ExprError extends Error {
  constructor(msg, src, at) {
    super(`${msg} in expression ${JSON.stringify(src)}${at == null ? '' : ` (at character ${at + 1})`}`);
    this.name = 'ExprError';
    this.src = src;
    this.at = at;
  }
}

// ------------------------------------------------------------------ parser (precedence climbing)
// Binary operators: [precedence, fn, rightAssociative]
const BIN = {
  '||': [1, (a, b) => (a || b ? 1 : 0)],
  '&&': [2, (a, b) => (a && b ? 1 : 0)],
  '==': [3, (a, b) => (a === b ? 1 : 0)], '!=': [3, (a, b) => (a !== b ? 1 : 0)],
  '<': [4, (a, b) => (a < b ? 1 : 0)], '<=': [4, (a, b) => (a <= b ? 1 : 0)],
  '>': [4, (a, b) => (a > b ? 1 : 0)], '>=': [4, (a, b) => (a >= b ? 1 : 0)],
  '+': [5, (a, b) => a + b], '-': [5, (a, b) => a - b],
  '*': [6, (a, b) => a * b], '/': [6, (a, b) => a / b], '%': [6, (a, b) => a % b],
  '^': [8, (a, b) => a ** b, true],
};
const UNARY_PREC = 7;

/**
 * Parse `src` into a function (scope) -> number. `vars` lists the variable names the expression may use;
 * anything else is reported as an error at parse time rather than silently becoming NaN at build time.
 */
export function compileExpr(src, vars = []) {
  if (typeof src === 'number') return () => src;
  if (typeof src !== 'string') throw new TypeError(`expression must be a number or a string, got ${typeof src}`);
  const allowed = new Set(vars);
  const tok = tokenize(src);
  let p = 0;
  const peek = () => tok[p];
  const next = () => tok[p++];
  const expect = (t) => { if (tok[p].t !== t) throw new ExprError(`expected ${JSON.stringify(t)}`, src, tok[p].at); return tok[p++]; };

  function primary() {
    const k = next();
    if (k.t === 'num') { const v = k.v; return () => v; }
    if (k.t === '-') { const a = parseExpr(UNARY_PREC); return (s) => -a(s); }
    if (k.t === '+') return parseExpr(UNARY_PREC);
    if (k.t === '!') { const a = parseExpr(UNARY_PREC); return (s) => (a(s) ? 0 : 1); }
    if (k.t === '(') { const a = parseExpr(0); expect(')'); return a; }
    if (k.t === 'name') {
      if (peek().t === '(') {                                      // function call
        next();
        const args = [];
        if (peek().t !== ')') { args.push(parseExpr(0)); while (peek().t === ',') { next(); args.push(parseExpr(0)); } }
        expect(')');
        const f = FNS[k.v];
        if (!f) throw new ExprError(`unknown function ${JSON.stringify(k.v)} (available: ${EXPR_FUNCTIONS.join(', ')})`, src, k.at);
        const [arity, fn] = f;
        if (arity >= 0 && args.length !== arity) throw new ExprError(`${k.v}() takes ${arity} argument${arity === 1 ? '' : 's'}, got ${args.length}`, src, k.at);
        if (arity < 0 && args.length === 0) throw new ExprError(`${k.v}() needs at least one argument`, src, k.at);
        if (args.length === 1) { const [a] = args; return (s) => fn(a(s)); }
        if (args.length === 2) { const [a, b] = args; return (s) => fn(a(s), b(s)); }
        if (args.length === 3) { const [a, b, c] = args; return (s) => fn(a(s), b(s), c(s)); }
        return (s) => fn(...args.map((a) => a(s)));
      }
      if (k.v in CONSTS) { const v = CONSTS[k.v]; return () => v; }
      if (!allowed.has(k.v)) {
        throw new ExprError(`unknown name ${JSON.stringify(k.v)} (variables here: ${[...allowed].join(', ') || 'none'}; `
          + `constants: ${EXPR_CONSTANTS.join(', ')})`, src, k.at);
      }
      const name = k.v;
      return (s) => s[name];
    }
    throw new ExprError('expected a number, name or "("', src, k.at);
  }

  function parseExpr(minPrec) {
    let lhs = primary();
    for (;;) {
      const t = peek().t;
      if (t === '?' && minPrec <= 0) {                             // ternary, lowest precedence
        next();
        const a = parseExpr(0);
        expect(':');
        const b = parseExpr(0);
        const c = lhs;
        lhs = (s) => (c(s) ? a(s) : b(s));
        continue;
      }
      const op = BIN[t];
      if (!op || op[0] < minPrec) break;
      next();
      const rhs = parseExpr(op[2] ? op[0] : op[0] + 1);
      const [, fn] = op, l = lhs;
      lhs = (s) => fn(l(s), rhs(s));
    }
    return lhs;
  }

  const fn = parseExpr(0);
  if (peek().t !== 'end') throw new ExprError('unexpected trailing input', src, peek().at);
  return fn;
}

/** Compile and evaluate in one go (handy in tests and for one-shot constants). */
export function evalExpr(src, scope = {}) {
  return compileExpr(src, Object.keys(scope))(scope);
}
