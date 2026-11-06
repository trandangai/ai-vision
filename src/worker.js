// Builds model point clouds off the main thread (a 200k-point engine takes a few hundred ms),
// so switching models never stutters the render loop. Buffers are transferred, not copied.
//
// The catalog is imported dynamically and `onmessage` is installed before that import can settle: declarative
// models (src/models/objects/*.json) are fetched while the module graph loads, so the catalog module finishes
// asynchronously, and a request that arrives first must be queued rather than dropped.
let buildModel = null, addObject = null, removeObject = null, failure = null;
const queue = [];

function run(msg) {
  const { id, index, n, type, gen } = msg;
  if (failure) { self.postMessage({ id, index, gen, error: failure }); return; }
  // The worker holds its own copy of the catalog, so user-added objects have to be registered here too,
  // in the same order, or an index would mean two different models on the two threads.
  if (type === 'addObject') {
    // The main thread only sends this after its own add succeeded, and the compiler is deterministic, so a
    // failure here means the two catalogs have diverged: fail loudly rather than build the wrong model.
    try { addObject(msg.json, msg.source); } catch (e) { failure = `worker could not register ${msg.source}: ${e.message}`; }
    return;
  }
  if (type === 'removeObject') { removeObject(index); return; }
  try {
    const m = buildModel(index, n);
    const out = { id, index, n, gen, target: m.target, offset: m.offset, tint: m.tint, pick: m.pick, labels: m.labels, groups: m.groups, fitScale: m.fitScale, exCenter: m.exCenter, ms: m.ms };
    self.postMessage(out, [m.target.buffer, m.offset.buffer, m.tint.buffer, m.pick.buffer]);
  } catch (err) {
    self.postMessage({ id, index, gen, error: String((err && err.stack) || err) });
  }
}

self.onmessage = (e) => { if (buildModel || failure) run(e.data); else queue.push(e.data); };

import('./models/catalog.js').then((m) => {
  buildModel = m.buildModel; addObject = m.addObject; removeObject = m.removeObject;
}).catch((err) => {
  failure = `model catalog failed to load in the worker: ${String((err && err.stack) || err)}`;
}).then(() => {
  while (queue.length) run(queue.shift());
});
