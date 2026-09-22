/* Runs the original img2threejs forge (Python, stdlib only) inside Pyodide, off the UI thread. */
/* global loadPyodide */
importScripts('https://cdn.jsdelivr.net/pyodide/v0.28.0/full/pyodide.js');

let pyodideReady = null;

async function boot() {
  const pyodide = await loadPyodide({ indexURL: 'https://cdn.jsdelivr.net/pyodide/v0.28.0/full/' });
  post({ type: 'progress', message: 'Pyodide yüklendi, img2threejs forge paketi açılıyor…' });
  const [zip, adapter] = await Promise.all([
    fetch('../forge.zip').then((r) => {
      if (!r.ok) throw new Error('forge.zip indirilemedi (' + r.status + ')');
      return r.arrayBuffer();
    }),
    fetch('../py/studio_pipeline.py').then((r) => r.text()),
  ]);
  pyodide.FS.mkdirTree('/img2threejs');
  pyodide.FS.mkdirTree('/work');
  pyodide.FS.mkdirTree('/studio');
  pyodide.unpackArchive(zip, 'zip', { extractDir: '/img2threejs' });
  pyodide.FS.writeFile('/studio/studio_pipeline.py', adapter);
  pyodide.runPython(`
import os, sys
os.environ["IMG2THREEJS_ROOT"] = "/img2threejs"
os.environ["IMG2THREEJS_WORK"] = "/work"
sys.path.insert(0, "/studio")
import studio_pipeline
`);
  return pyodide;
}

function post(message, transfer) {
  self.postMessage(message, transfer || []);
}

self.onmessage = async (event) => {
  const { id, op, action, payload, path, data } = event.data;
  try {
    if (!pyodideReady) pyodideReady = boot();
    const pyodide = await pyodideReady;
    if (op === 'init') {
      post({ id, ok: true, result: { version: pyodide.version } });
      return;
    }
    if (op === 'writeFile') {
      const dir = path.substring(0, path.lastIndexOf('/'));
      if (dir) pyodide.FS.mkdirTree(dir);
      pyodide.FS.writeFile(path, data);
      post({ id, ok: true, result: { path } });
      return;
    }
    if (op === 'readFile') {
      const bytes = pyodide.FS.readFile(path);
      post({ id, ok: true, result: bytes }, [bytes.buffer]);
      return;
    }
    const api = pyodide.globals.get('studio_pipeline').api;
    const started = performance.now();
    const raw = api(action, JSON.stringify(payload ?? {}));
    post({ id, ok: true, result: JSON.parse(raw), ms: Math.round(performance.now() - started) });
  } catch (error) {
    post({ id, ok: false, error: String(error && error.message ? error.message : error) });
  }
};
