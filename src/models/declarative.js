// The declarative model format: turns a plain JSON object (src/models/objects/*.json) into exactly the same
// `{ name, color, groups() }` definition the hand-written models in this folder export, so a new object can be
// added without writing any geometry code. See docs/models.md for the authoring reference.
//
//   compileObject(json, source) -> catalog definition (validated now, geometry built lazily)
//
// Every number in a model file may instead be a string expression ("190 * cos(f * TAU)"), evaluated by
// src/lib/expr.js — no eval, no property access. Field names and types are validated up front and unknown
// keys are rejected with a did-you-mean, because a silent typo in a 200-line JSON file is painful to find.
import {
  line, polyline, tri, quad, box, boxSurface, boxEdges, revolve, cylinder, ring, disc, tube, pipe, torus,
  ellipsoid, helix, gear, paramSurface, transform, orient, TAU,
} from '../lib/sampling.js';
import { vessel, blob, capsule, bone, sphere, dots } from '../lib/shapes.js';
import { rotX, rotY, rotZ, matMul, deg, I3 } from '../lib/vec.js';
import { compileExpr } from '../lib/expr.js';
import { COL } from './engines.js';

/** Named colours a model file can use instead of an [r, g, b] triple. */
export const PALETTE = {
  ...COL,
  blue: COL.steel, grey: COL.silver, gray: COL.silver, yellow: COL.gold, bone: [0.95, 0.93, 0.85],
  copper: [1.0, 0.55, 0.25], glass: [0.65, 0.9, 1.0], carbon: [0.55, 0.6, 0.75], flame: [1.0, 0.35, 0.1],
};

// ------------------------------------------------------------------ value resolution
const exprCache = new Map();
function expr(src, names) {
  const key = `${names.join(',')}\u0000${src}`;
  let fn = exprCache.get(key);
  if (!fn) { fn = compileExpr(src, names); exprCache.set(key, fn); }
  return fn;
}

class Ctx {
  constructor(names, scope = {}) { this.names = names; this.scope = scope; }
  /** A child context with extra variables (a repeat index, local `vars`). */
  with(extra) {
    const names = [...new Set([...this.names, ...Object.keys(extra)])];
    return new Ctx(names, { ...this.scope, ...extra });
  }
  fail(path, msg) { throw new ModelError(`${path}: ${msg}`); }
  num(v, path) {
    if (typeof v === 'number') { if (!Number.isFinite(v)) this.fail(path, `must be a finite number, got ${v}`); return v; }
    if (typeof v === 'string') {
      let f;
      try { f = expr(v, this.names); } catch (e) { this.fail(path, e.message); }
      const r = f(this.scope);
      if (!Number.isFinite(r)) this.fail(path, `expression ${JSON.stringify(v)} evaluated to ${r}`);
      return r;
    }
    return this.fail(path, `must be a number or an expression string, got ${kindOf(v)}`);
  }
  vec(v, path) {
    if (!Array.isArray(v) || v.length !== 3) this.fail(path, `must be [x, y, z], got ${kindOf(v)}`);
    return [this.num(v[0], `${path}[0]`), this.num(v[1], `${path}[1]`), this.num(v[2], `${path}[2]`)];
  }
  nums(v, path, min = 2) {
    if (!Array.isArray(v) || v.length < min) this.fail(path, `must be a list of at least ${min} numbers, got ${kindOf(v)}`);
    return v.map((x, i) => this.num(x, `${path}[${i}]`));
  }
  points(v, path, min = 2) {
    if (!Array.isArray(v) || v.length < min) this.fail(path, `must be a list of at least ${min} [x, y, z] points, got ${kindOf(v)}`);
    return v.map((p, i) => this.vec(p, `${path}[${i}]`));
  }
  bool(v, path) {
    if (typeof v === 'boolean') return v;
    return this.fail(path, `must be true or false, got ${kindOf(v)}`);
  }
  int(v, path, min = 1) {
    const n = Math.round(this.num(v, path));
    if (n < min) this.fail(path, `must be ${min} or more, got ${n}`);
    return n;
  }
  axis(v, path) {
    const named = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1], '-x': [-1, 0, 0], '-y': [0, -1, 0], '-z': [0, 0, -1] };
    if (typeof v === 'string') {
      const a = named[v.toLowerCase()];
      if (!a) this.fail(path, `must be "x", "y", "z" (optionally "-x" ...) or [x, y, z], got ${JSON.stringify(v)}`);
      return a;
    }
    return this.vec(v, path);
  }
  color(v, path) {
    if (typeof v === 'string') {
      const c = PALETTE[v];
      if (!c) this.fail(path, `unknown colour ${JSON.stringify(v)}${suggest(v, Object.keys(PALETTE))}. Known colours: ${Object.keys(PALETTE).sort().join(', ')}`);
      return [...c];
    }
    const c = this.vec(v, path);
    if (c.some((x) => x < 0 || x > 1)) this.fail(path, `colour channels must be between 0 and 1, got [${c.join(', ')}]`);
    return c;
  }
  /** keep/bump style expression: a function of the point (x, y, z) or surface (u, v) plus everything in scope. */
  fn(v, path, extra) {
    if (typeof v === 'number') { const n = v; return () => n; }
    if (typeof v !== 'string') this.fail(path, `must be an expression string using ${extra.join(', ')}, got ${kindOf(v)}`);
    let f;
    try { f = expr(v, [...this.names, ...extra]); } catch (e) { this.fail(path, e.message); }
    const scope = { ...this.scope };
    return (...args) => {
      extra.forEach((k, i) => { scope[k] = args[i]; });
      return f(scope);
    };
  }
}

export class ModelError extends Error {
  constructor(msg) { super(msg); this.name = 'ModelError'; }
}

const kindOf = (v) => (Array.isArray(v) ? `a list of ${v.length}` : v === null ? 'null' : typeof v);

/** " Did you mean "revolve"?" when a key/type/colour is a near miss. */
function suggest(word, options) {
  const d = (a, b) => {                                            // Levenshtein
    const m = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 0; j <= b.length; j++) m[0][j] = j;
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
      m[i][j] = Math.min(m[i - 1][j] + 1, m[i][j - 1] + 1, m[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    return m[a.length][b.length];
  };
  const w = word.toLowerCase();
  const best = options.map((o) => [d(w, o.toLowerCase()), o]).sort((a, b) => a[0] - b[0])[0];
  return best && best[0] <= Math.max(2, Math.ceil(w.length / 3)) ? ` Did you mean ${JSON.stringify(best[1])}?` : '';
}

// ------------------------------------------------------------------ shapes
// args: field -> [type, required?, default]. Types are the Ctx methods above; "keep" and "surf" are expressions.
const N = 'num', V = 'vec', B = 'bool', A = 'axis', NL = 'nums', PL = 'points', K = 'keep';
const req = true;

const SHAPES = {
  line: { args: { from: [V, req], to: [V, req], r: [N, 0, 0], density: [N, 0, 1] },
    build: (a) => line(a.from, a.to, a.r, a.density) },
  polyline: { args: { points: [PL, req], r: [N, 0, 0], density: [N, 0, 1], closed: [B, 0, false] },
    build: (a) => polyline(a.points, a.r, a.density, a.closed) },
  tri: { args: { a: [V, req], b: [V, req], c: [V, req], density: [N, 0, 1], keep: [K, 0, null] },
    build: (a) => tri(a.a, a.b, a.c, a.density, a.keep) },
  quad: { args: { a: [V, req], b: [V, req], c: [V, req], d: [V, req], density: [N, 0, 1], keep: [K, 0, null] },
    build: (a) => quad(a.a, a.b, a.c, a.d, a.density, a.keep) },
  box: { args: { center: [V, req], size: [V, req], density: [N, 0, 1], edge: [N, 0, 3] },
    build: (a) => box(a.center, a.size, a.density, a.edge) },
  boxSurface: { args: { center: [V, req], size: [V, req], density: [N, 0, 1], keep: [K, 0, null], top: [B, 0, true], bottom: [B, 0, false] },
    build: (a) => boxSurface(a.center, a.size, a.density, a.keep, a.bottom, a.top) },
  boxEdges: { args: { center: [V, req], size: [V, req], r: [N, 0, 0], density: [N, 0, 1] },
    build: (a) => boxEdges(a.center, a.size, a.r, a.density) },
  revolve: { args: { ys: [NL, req], rs: [NL, req], center: [V, 0, [0, 0, 0]], density: [N, 0, 1], sx: [N, 0, 1], sz: [N, 0, 1], arcFrom: [N, 0, 0], arcTo: [N, 0, 360], keep: [K, 0, null] },
    build: (a, path, ctx) => {
      if (a.ys.length !== a.rs.length) ctx.fail(path, `ys and rs must be the same length (got ${a.ys.length} and ${a.rs.length})`);
      return revolve(a.ys, a.rs, { center: a.center, density: a.density, sx: a.sx, sz: a.sz, keep: a.keep, a0: deg(a.arcFrom), a1: deg(a.arcTo) });
    } },
  cylinder: { args: { center: [V, req], r: [N, req], h: [N, req], density: [N, 0, 1], cap: [B, 0, false], capBottom: [B, 0, false], keep: [K, 0, null] },
    build: (a) => cylinder(a.center, a.r, a.h, { density: a.density, cap: a.cap, capBottom: a.capBottom, keep: a.keep }) },
  ring: { args: { center: [V, req], r: [N, req], density: [N, 0, 1], sx: [N, 0, 1], sz: [N, 0, 1], jitter: [N, 0, 0] },
    build: (a) => ring(a.center, a.r, { density: a.density, sx: a.sx, sz: a.sz, jitter: a.jitter }) },
  disc: { args: { center: [V, req], r0: [N, 0, 0], r1: [N, req], axis: [A, 0, [0, 1, 0]], density: [N, 0, 1], keep: [K, 0, null] },
    build: (a) => disc(a.center, a.r0, a.r1, a.axis, a.density, a.keep) },
  tube: { args: { from: [V, req], to: [V, req], r: [N, req], r1: [N, 0, null], density: [N, 0, 1] },
    build: (a) => tube(a.from, a.to, a.r, a.r1, a.density) },
  pipe: { args: { points: [PL, req], r: [N, req], density: [N, 0, 1] },
    build: (a) => pipe(a.points, a.r, a.density) },
  vessel: { args: { points: [PL, req], r: [N, req], r1: [N, 0, null], density: [N, 0, 1], smooth: [N, 0, 8] },
    build: (a) => vessel(a.points, a.r, a.r1 ?? a.r, a.density, Math.max(2, Math.round(a.smooth))) },
  torus: { args: { center: [V, req], r: [N, req], tubeRadius: [N, req], axis: [A, 0, [0, 1, 0]], density: [N, 0, 1] },
    build: (a) => torus(a.center, a.r, a.tubeRadius, a.axis, a.density) },
  ellipsoid: { args: { center: [V, req], radii: [V, req], density: [N, 0, 1], keep: [K, 0, null] },
    build: (a) => ellipsoid(a.center, a.radii, a.density, a.keep) },
  sphere: { args: { center: [V, req], r: [N, req], density: [N, 0, 1] },
    build: (a) => sphere(a.center, a.r, a.density) },
  capsule: { args: { from: [V, req], to: [V, req], r: [N, req], density: [N, 0, 1] },
    build: (a) => capsule(a.from, a.to, a.r, a.density) },
  helix: { args: { center: [V, req], r: [N, req], h: [N, req], turns: [N, req], axis: [A, 0, [0, 1, 0]], density: [N, 0, 1] },
    build: (a) => helix(a.center, a.r, a.h, a.turns, a.axis, a.density) },
  gear: { args: { center: [V, req], r: [N, req], teeth: [N, req], depth: [N, 0, null], width: [N, 0, null], hub: [N, 0, null], axis: [A, 0, [0, 1, 0]], density: [N, 0, 1] },
    build: (a) => gear(a.center, a.r, Math.max(3, Math.round(a.teeth)), { depth: a.depth, width: a.width, hub: a.hub, axis: a.axis, density: a.density }) },
  bone: { args: { from: [V, req], to: [V, req], r: [N, req], density: [N, 0, 1] },
    build: (a) => bone(a.from, a.to, a.r, a.density) },
  dots: { args: { points: [PL, req, null, 1], r: [N, req], density: [N, 0, 1] },
    build: (a) => dots(a.points, a.r, a.density) },
  surface: {
    args: { x: ['surf', req], y: ['surf', req], z: ['surf', req], u: [NL, 0, [0, 1]], v: [NL, 0, [0, 1]],
      density: [N, 0, 1], grid: [NL, 0, [40, 24]], keep: [K, 0, null] },
    build: (a) => paramSurface((u, v) => [a.x(u, v), a.y(u, v), a.z(u, v)], a.u[0], a.u[1], a.v[0], a.v[1],
      { density: a.density, keep: a.keep, gu: Math.max(2, Math.round(a.grid[0])), gv: Math.max(2, Math.round(a.grid[1])) }) },
  blob: {
    args: { center: [V, req], radii: [V, req], bump: ['surf', 0, null], density: [N, 0, 1], keep: [K, 0, null],
      vFrom: [N, 0, -90], vTo: [N, 0, 90], grid: [NL, 0, [36, 24]] },
    build: (a) => blob(a.center, a.radii, { bump: a.bump, density: a.density, keep: a.keep, v0: deg(a.vFrom), v1: deg(a.vTo),
      gu: Math.max(2, Math.round(a.grid[0])), gv: Math.max(2, Math.round(a.grid[1])) }) },
};

export const SHAPE_TYPES = Object.keys(SHAPES).sort();

/** Keys any shape may carry on top of its own arguments. */
const WRAPPERS = ['type', 'repeat', 'vars', 'rotate', 'translate', 'mirror', 'note'];

function buildShape(s, path, ctx) {
  if (!s || typeof s !== 'object' || Array.isArray(s)) throw new ModelError(`${path}: must be a shape object like { "type": "box", ... }, got ${kindOf(s)}`);
  const def = SHAPES[s.type];
  if (!def) throw new ModelError(`${path}: unknown shape type ${JSON.stringify(s.type ?? null)}.${s.type ? suggest(String(s.type), SHAPE_TYPES) : ''} Available: ${SHAPE_TYPES.join(', ')}`);
  for (const k of Object.keys(s)) {
    if (!(k in def.args) && !WRAPPERS.includes(k)) {
      throw new ModelError(`${path}: ${JSON.stringify(k)} is not an argument of shape "${s.type}".${suggest(k, [...Object.keys(def.args), ...WRAPPERS])} `
        + `"${s.type}" takes: ${Object.keys(def.args).join(', ')}`);
    }
  }
  const counts = s.repeat === undefined ? null : repeatCounts(s.repeat, `${path}.repeat`, ctx);
  const out = [];
  for (const vars of repeatScopes(counts)) {
    let c = Object.keys(vars).length ? ctx.with(vars) : ctx;
    c = withLocalVars(c, s.vars, `${path}.vars`);
    const a = {};
    for (const [k, [type, required, dflt, min]] of Object.entries(def.args)) {
      const raw = s[k];
      if (raw === undefined || raw === null) {
        if (required) c.fail(`${path} (${s.type})`, `${JSON.stringify(k)} is required`);
        a[k] = dflt;
        continue;
      }
      const at = `${path} (${s.type}).${k}`;
      a[k] = type === N ? c.num(raw, at)
        : type === V ? c.vec(raw, at)
          : type === B ? c.bool(raw, at)
            : type === A ? c.axis(raw, at)
              : type === NL ? c.nums(raw, at, 2)
                : type === PL ? c.points(raw, at, min ?? 2)
                  : type === K ? c.fn(raw, at, ['x', 'y', 'z'])
                    : type === 'surf' ? c.fn(raw, at, ['u', 'v'])
                      : c.fail(at, `internal: unknown arg type ${type}`);
    }
    let parts = def.build(a, `${path} (${s.type})`, c);
    parts = place(parts, s, `${path} (${s.type})`, c);
    out.push(parts);
  }
  return out;
}

/** rotate (degrees, X then Y then Z) -> translate -> optional mirrored copy. */
function place(parts, s, path, ctx) {
  let R = I3, t = [0, 0, 0], moved = false;
  if (s.rotate !== undefined) {
    const r = Array.isArray(s.rotate) ? ctx.vec(s.rotate, `${path}.rotate`)
      : [ctx.num(s.rotate.x ?? 0, `${path}.rotate.x`), ctx.num(s.rotate.y ?? 0, `${path}.rotate.y`), ctx.num(s.rotate.z ?? 0, `${path}.rotate.z`)];
    if (!Array.isArray(s.rotate)) for (const k of Object.keys(s.rotate)) if (!'xyz'.includes(k)) ctx.fail(`${path}.rotate`, `only x, y and z (degrees) are allowed, got ${JSON.stringify(k)}`);
    R = matMul(rotZ(deg(r[2])), matMul(rotY(deg(r[1])), rotX(deg(r[0]))));
    moved = true;
  }
  if (s.translate !== undefined) { t = ctx.vec(s.translate, `${path}.translate`); moved = true; }
  if (moved) parts = transform(parts, R, t);
  if (s.mirror !== undefined) {
    const ax = mirrorAxis(s.mirror, `${path}.mirror`, ctx);
    parts = [parts, transform(parts, ax, [0, 0, 0])];
  }
  return parts;
}

const MIRROR = { x: [[-1, 0, 0], [0, 1, 0], [0, 0, 1]], y: [[1, 0, 0], [0, -1, 0], [0, 0, 1]], z: [[1, 0, 0], [0, 1, 0], [0, 0, -1]] };
function mirrorAxis(v, path, ctx) {
  const a = MIRROR[String(v).toLowerCase()];
  if (!a) ctx.fail(path, `must be "x", "y" or "z", got ${JSON.stringify(v)}`);
  return a;
}

function repeatCounts(r, path, ctx) {
  if (Array.isArray(r)) {
    if (r.length !== 2) ctx.fail(path, `must be a count, or [countI, countJ] for a grid, got a list of ${r.length}`);
    return [ctx.int(r[0], `${path}[0]`), ctx.int(r[1], `${path}[1]`)];
  }
  return [ctx.int(r, path)];
}

/** Variables a repeated shape gets: i/n/t/f on the first axis, j/m/s/g on the second. */
function* repeatScopes(counts) {
  if (!counts) { yield {}; return; }
  const [n, m] = counts;
  for (let i = 0; i < n; i++) {
    const base = { i, n, t: n > 1 ? i / (n - 1) : 0, f: i / n };
    if (m === undefined) { yield base; continue; }
    for (let j = 0; j < m; j++) yield { ...base, j, m, s: m > 1 ? j / (m - 1) : 0, g: j / m };
  }
}

function withLocalVars(ctx, vars, path) {
  if (vars === undefined) return ctx;
  if (!vars || typeof vars !== 'object' || Array.isArray(vars)) throw new ModelError(`${path}: must be an object of name -> number or expression, got ${kindOf(vars)}`);
  let c = ctx;
  for (const [k, v] of Object.entries(vars)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new ModelError(`${path}: ${JSON.stringify(k)} is not a usable variable name (letters, digits and _ only)`);
    c = c.with({ [k]: c.num(v, `${path}.${k}`) });
  }
  return c;
}

// ------------------------------------------------------------------ parts (= groups) and the model itself
const PART_KEYS = ['label', 'info', 'color', 'offset', 'stage', 'shapes', 'showLabel', 'mirror', 'vars', 'note'];
const MODEL_KEYS = ['name', 'category', 'color', 'fact', 'tilt', 'viewYaw', 'pulse', 'breath', 'parts', 'shapes', 'vars', 'units', 'note', 'source'];

function buildPart(p, path, ctx, out) {
  for (const k of Object.keys(p)) if (!PART_KEYS.includes(k)) throw new ModelError(`${path}: ${JSON.stringify(k)} is not a part field.${suggest(k, PART_KEYS)} A part takes: ${PART_KEYS.join(', ')}`);
  if (typeof p.label !== 'string' || !p.label.trim()) throw new ModelError(`${path}: "label" is required and must be a non-empty string`);
  const where = `${path} "${p.label}"`;
  if (!Array.isArray(p.shapes) || !p.shapes.length) throw new ModelError(`${where}: "shapes" is required and must be a non-empty list`);
  if (p.info !== undefined && typeof p.info !== 'string') throw new ModelError(`${where}.info: must be a string (what the part does)`);
  const c = withLocalVars(ctx, p.vars, `${where}.vars`);
  if (p.offset === undefined) c.fail(where, '"offset" is required: [x, y, z] saying where the part travels in the exploded view');
  if (p.stage === undefined) c.fail(where, '"stage" is required: 0..0.6, when the part starts to move as the hand opens');
  const color = c.color(p.color === undefined ? c.fail(where, '"color" is required') : p.color, `${where}.color`);
  const offset = c.vec(p.offset, `${where}.offset`);
  const stage = c.num(p.stage, `${where}.stage`);
  if (stage < 0 || stage >= 0.6) c.fail(`${where}.stage`, `must be between 0 and 0.6 (outer parts come off first), got ${stage}`);
  const parts = p.shapes.map((s, i) => buildShape(s, `${where}.shapes[${i}]`, c));
  out.push({ label: p.label, info: p.info || '', color, offset, stage, parts, ...(p.showLabel === false ? { showLabel: false } : {}) });

  if (p.mirror !== undefined) {                        // a mirrored twin, picked and highlighted with the original
    const m = typeof p.mirror === 'string' ? { axis: p.mirror } : p.mirror;
    if (!m || typeof m !== 'object') throw new ModelError(`${where}.mirror: must be "x" | "y" | "z" or { axis, suffix, offset }`);
    for (const k of Object.keys(m)) if (!['axis', 'suffix', 'offset'].includes(k)) throw new ModelError(`${where}.mirror: ${JSON.stringify(k)} is not allowed (axis, suffix, offset)`);
    const R = mirrorAxis(m.axis, `${where}.mirror.axis`, c);
    const k = ['x', 'y', 'z'].indexOf(String(m.axis).toLowerCase());
    const twinOffset = m.offset !== undefined ? c.vec(m.offset, `${where}.mirror.offset`) : offset.map((v, a) => (a === k ? -v : v));
    const suffix = m.suffix === undefined ? ' (L)' : m.suffix;
    if (typeof suffix !== 'string') throw new ModelError(`${where}.mirror.suffix: must be a string like " (L)"`);
    out.push({ label: `${p.label}${suffix}`, info: p.info || '', color, offset: twinOffset, stage, showLabel: false,
      parts: transform(parts, R, [0, 0, 0]) });
  }
}

/**
 * Validate a declarative model and return a catalog definition. `source` is only used in error messages.
 * Geometry is built on demand by `groups()` / `build()`, like the hand-written models.
 */
export function compileObject(json, source = 'model') {
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new ModelError(`${source}: a model file must contain one JSON object, got ${kindOf(json)}`);
  const at = (k) => `${source} (${json.name || 'unnamed'}).${k}`;
  for (const k of Object.keys(json)) if (!MODEL_KEYS.includes(k)) throw new ModelError(`${source}: ${JSON.stringify(k)} is not a model field.${suggest(k, MODEL_KEYS)} A model takes: ${MODEL_KEYS.join(', ')}`);
  for (const k of ['name', 'category']) if (typeof json[k] !== 'string' || !json[k].trim()) throw new ModelError(`${source}: ${JSON.stringify(k)} is required and must be a non-empty string`);
  if (json.parts === undefined && json.shapes === undefined) throw new ModelError(`${source} (${json.name}): needs either "parts" (an explodable object with named parts) or "shapes" (a single-colour landmark)`);
  if (json.parts !== undefined && json.shapes !== undefined) throw new ModelError(`${source} (${json.name}): has both "parts" and "shapes" — use "parts" for an explodable object, "shapes" for a single-colour landmark`);

  const root = withLocalVars(new Ctx([]), json.vars, at('vars'));
  const color = root.color(json.color ?? [0.6, 0.85, 1.0], at('color'));
  const def = {
    name: json.name.trim(),
    category: json.category.trim(),
    color,
    fact: json.fact === undefined ? '' : String(json.fact),
    tilt: json.tilt === undefined ? 0 : root.num(json.tilt, at('tilt')),
    declarative: true,
  };
  if (json.viewYaw !== undefined) def.viewYaw = root.num(json.viewYaw, at('viewYaw'));
  for (const [k, fields] of [['pulse', ['bpm', 'amp']], ['breath', ['period', 'amp']]]) {
    if (json[k] === undefined) continue;
    const o = json[k];
    if (!o || typeof o !== 'object' || Array.isArray(o)) throw new ModelError(`${at(k)}: must be { ${fields.join(', ')} }`);
    for (const f of Object.keys(o)) if (!fields.includes(f)) throw new ModelError(`${at(k)}: ${JSON.stringify(f)} is not allowed (${fields.join(', ')})`);
    def[k] = Object.fromEntries(fields.map((f) => [f, root.num(o[f] ?? (f === 'amp' ? 0.05 : f === 'bpm' ? 72 : 4.5), `${at(k)}.${f}`)]));
  }

  if (json.shapes !== undefined) {                     // landmark: one colour, no parts, nothing to pull apart
    if (!Array.isArray(json.shapes) || !json.shapes.length) throw new ModelError(`${at('shapes')}: must be a non-empty list of shapes`);
    def.kind = 'landmark';
    def.build = () => json.shapes.map((s, i) => buildShape(s, `${source} (${def.name}).shapes[${i}]`, root));
    validate(() => def.build(), source, def.name);
    return def;
  }

  if (!Array.isArray(json.parts) || json.parts.length < 2) throw new ModelError(`${at('parts')}: must be a list of at least 2 named parts`);
  def.kind = 'machine';
  def.groups = () => {
    const out = [];
    json.parts.forEach((p, i) => {
      if (!p || typeof p !== 'object' || Array.isArray(p)) throw new ModelError(`${source} (${def.name}).parts[${i}]: must be an object, got ${kindOf(p)}`);
      buildPart(p, `${source} (${def.name}).parts[${i}]`, root, out);
    });
    return out;
  };
  validate(() => {
    const g = def.groups();
    const seen = new Set();
    for (const x of g) {
      if (seen.has(x.label)) throw new ModelError(`${source} (${def.name}): two parts are both called ${JSON.stringify(x.label)} — labels must be unique`);
      seen.add(x.label);
    }
    const labelled = g.filter((x) => x.showLabel !== false).length;
    if (labelled < 2) throw new ModelError(`${source} (${def.name}): needs at least 2 labelled parts, found ${labelled}`);
  }, source, def.name);
  return def;
}

/** Run the build once at load time so a broken model file fails loudly here instead of mid-gesture. */
function validate(run, source, name) {
  try { run(); } catch (e) {
    if (e instanceof ModelError) throw e;
    throw new ModelError(`${source} (${name}): ${e.message}`);
  }
}
