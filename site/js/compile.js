// Turns the generated TypeScript factory into a runnable ES module in the browser.
// Type annotations are stripped with Sucrase; bare `three` imports resolve through the page's import map.

let sucrasePromise = null;
let lastUrl = null;

function loadSucrase() {
  sucrasePromise ??= import('https://cdn.jsdelivr.net/npm/sucrase@3.35.0/+esm');
  return sucrasePromise;
}

export async function transpile(tsCode) {
  const { transform } = await loadSucrase();
  const { code } = transform(tsCode, {
    transforms: ['typescript'],
    disableESTransforms: true,
    keepUnusedImports: true,
  });
  return code;
}

export async function importModule(jsCode) {
  if (lastUrl) URL.revokeObjectURL(lastUrl);
  lastUrl = URL.createObjectURL(new Blob([jsCode], { type: 'text/javascript' }));
  return import(/* @vite-ignore */ lastUrl);
}
