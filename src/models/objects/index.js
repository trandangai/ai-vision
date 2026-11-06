// Loads every declarative model listed in manifest.json and compiles it into a catalog definition.
// Adding an object to TakeApart is: drop a .json file in this folder, add its name to manifest.json, reload.
//
// A file that fails to parse or validate is skipped (so one typo cannot take the whole app down) and its
// error is reported in OBJECT_ERRORS and on the console, naming the exact field.
import { compileObject, ModelError } from '../declarative.js';

const dir = new URL('./', import.meta.url);

async function loadJson(file) {
  const res = await fetch(new URL(file, dir));
  if (!res.ok) throw new Error(`cannot read ${file} (HTTP ${res.status})`);
  try {
    return await res.json();
  } catch (e) {
    throw new Error(`${file} is not valid JSON: ${e.message}`);
  }
}

async function loadAll() {
  const objects = [], errors = [];
  let manifest;
  try {
    manifest = await loadJson('manifest.json');
  } catch (e) {
    return { objects, errors: [e.message] };
  }
  const files = Array.isArray(manifest?.objects) ? manifest.objects : null;
  if (!files) return { objects, errors: ['manifest.json must look like { "objects": ["my-object.json"] }'] };
  const loaded = await Promise.all(files.map(async (f) => {
    try {
      return { file: f, json: await loadJson(f) };
    } catch (e) {
      return { file: f, error: e.message };
    }
  }));
  for (const r of loaded) {
    if (r.error) { errors.push(r.error); continue; }
    try {
      objects.push(compileObject(r.json, r.file));
    } catch (e) {
      errors.push(e instanceof ModelError ? e.message : `${r.file}: ${e.message}`);
    }
  }
  return { objects, errors };
}

const { objects, errors } = await loadAll();
for (const e of errors) console.error('[declarative model]', e);

/** Compiled definitions, in manifest order. */
export const OBJECTS = objects;
/** Human-readable problems found while loading; empty when every file is good. */
export const OBJECT_ERRORS = errors;
