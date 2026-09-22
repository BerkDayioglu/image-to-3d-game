// Main-thread client for the Pyodide worker that runs the img2threejs forge.

let worker = null;
let seq = 0;
const pending = new Map();
const progressListeners = new Set();

function ensureWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./pyodide-worker.js', import.meta.url));
  worker.onmessage = (event) => {
    const msg = event.data;
    if (msg.type === 'progress') {
      progressListeners.forEach((fn) => fn(msg.message));
      return;
    }
    const entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    if (msg.ok) entry.resolve(msg.result);
    else entry.reject(new Error(msg.error));
  };
  worker.onerror = (event) => {
    pending.forEach((entry) => entry.reject(new Error(event.message || 'Pyodide worker hatası')));
    pending.clear();
  };
  return worker;
}

function call(message, transfer) {
  const id = ++seq;
  ensureWorker();
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, ...message }, transfer || []);
  });
}

export const forge = {
  onProgress(fn) {
    progressListeners.add(fn);
    return () => progressListeners.delete(fn);
  },
  init: () => call({ op: 'init' }),
  writeFile: (path, bytes) => call({ op: 'writeFile', path, data: bytes }),
  readFile: (path) => call({ op: 'readFile', path }),
  api: (action, payload) => call({ op: 'api', action, payload }),
};
