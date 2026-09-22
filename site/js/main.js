import { forge } from './forge.js';
import { settings, fetchVisionModels, checkKey, chat, extractJson } from './openrouter.js';
import {
  authoringSystemPrompt, authoringUserPrompt, fixPrompt, reviewSystemPrompt, reviewUserPrompt,
} from './prompts.js';
import { transpile, importModule } from './compile.js';
import { Viewer } from './viewer.js';
import { GameMode } from './game.js';
import {
  exportGlb, threeUsage, r3fComponent, standaloneHtml, iframeSnippet, engineGuide, download, baseName, THREE_VERSION,
} from './exporters.js';
import { openCode } from './codeview.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ------------------------------------------------------------------------------------------
// State
// ------------------------------------------------------------------------------------------
const state = {
  image: null,          // { file, name, width, height, pngBytes, dataUrl, previewUrl }
  models: [],
  model: null,
  running: false,
  abort: null,
  steps: [],
  cost: 0,
  brief: null,
  starter: null,
  starterKey: '',
  spec: null,
  check: null,
  ts: '',
  js: '',
  exportsInfo: null,
  authorMessages: null, // conversation used for strict-quality fixes
  reviewRound: 0,
  passIndex: 0,
  lastReview: null,
  maxFix: 3,
};

const viewer = new Viewer($('[data-viewport]'));
let game = null;
window.__studio = { state, viewer }; // debugging handle (console)

// ------------------------------------------------------------------------------------------
// Small UI helpers
// ------------------------------------------------------------------------------------------
let toastTimer = 0;
function toast(message, isError = false) {
  const el = $('[data-toast]');
  el.textContent = message;
  el.classList.toggle('err', isError);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), isError ? 7000 : 3200);
}

function fmtPrice(v) {
  if (!v) return '0';
  return v < 1 ? v.toFixed(2) : v < 10 ? v.toFixed(1) : Math.round(v).toString();
}

function setBusy(text) {
  const el = $('[data-busy]');
  el.hidden = !text;
  if (text) $('[data-busy-text]').textContent = text;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function updateActionState() {
  const hasKey = Boolean(settings.key);
  const ready = hasKey && state.image && state.model && !state.running;
  $('[data-convert]').disabled = !ready;
  $('[data-refine]').disabled = !(hasKey && state.spec && viewer.hasModel && !state.running && state.model);
  $('[data-cancel]').hidden = !state.running;
  let hint = '';
  if (!hasKey) hint = 'OpenRouter API anahtarını gir (sağ üst).';
  else if (!state.image) hint = 'Bir referans görsel yükle.';
  else if (!state.model) hint = 'Bir vision modeli seç.';
  else if (state.running) hint = 'Pipeline çalışıyor…';
  else if (state.spec) hint = 'İyileştir: render referansla karşılaştırılır, spec düzeltilir ve model yeniden üretilir.';
  else hint = 'Hazır. İlk dönüşüm genellikle 30–90 sn sürer (modele göre).';
  $('[data-action-hint]').textContent = hint;
  const dot = $('[data-key-dot]');
  dot.classList.toggle('ok', hasKey);
  $('[data-key-label]').textContent = hasKey ? 'OpenRouter bağlı' : 'API anahtarı yok';
}

// ------------------------------------------------------------------------------------------
// Settings
// ------------------------------------------------------------------------------------------
const settingsModal = $('#settings-modal');
$$('[data-open-settings]').forEach((b) => b.addEventListener('click', openSettings));
settingsModal.addEventListener('click', (e) => {
  if (e.target === settingsModal) settingsModal.close();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && settingsModal.open) settingsModal.close();
});
function openSettings() {
  $('[data-key-input]').value = settings.key;
  $('[data-remember]').checked = settings.remembered;
  $('[data-max-fix]').value = String(state.maxFix);
  $('[data-key-status]').textContent = '';
  settingsModal.showModal();
}
$('[data-settings-form]').addEventListener('submit', (e) => {
  if (e.submitter?.value === 'save') {
    settings.setKey($('[data-key-input]').value, $('[data-remember]').checked);
    state.maxFix = Number($('[data-max-fix]').value) || 3;
    updateActionState();
    if (settings.key) toast('API anahtarı kaydedildi.');
  }
});
$('[data-key-clear]').addEventListener('click', () => {
  settings.setKey('', false);
  $('[data-key-input]').value = '';
  $('[data-key-status]').textContent = 'Anahtar silindi.';
  updateActionState();
});
$('[data-key-test]').addEventListener('click', async () => {
  const status = $('[data-key-status]');
  const key = $('[data-key-input]').value.trim();
  if (!key) {
    status.textContent = 'Önce bir anahtar gir.';
    status.className = 'key-status err';
    return;
  }
  status.textContent = 'Doğrulanıyor…';
  status.className = 'key-status';
  try {
    const info = await checkKey(key);
    const limit = info.limit == null ? 'limitsiz' : `$${Number(info.limit).toFixed(2)} limit`;
    status.textContent = `✓ Geçerli · kullanım $${Number(info.usage || 0).toFixed(3)} · ${limit}${info.is_free_tier ? ' · ücretsiz katman' : ''}`;
    status.className = 'key-status ok';
  } catch (err) {
    status.textContent = '✕ ' + err.message;
    status.className = 'key-status err';
  }
});

// ------------------------------------------------------------------------------------------
// Model picker
// ------------------------------------------------------------------------------------------
const picker = $('[data-model-picker]');
const menu = $('[data-model-menu]');
function renderModelList() {
  const q = $('[data-model-search]').value.trim().toLowerCase();
  const freeOnly = $('[data-model-free]').checked;
  const list = $('[data-model-list]');
  const items = state.models
    .filter((m) => (!freeOnly || m.free) && (!q || m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q)))
    .slice(0, 200);
  list.innerHTML = items.length
    ? items
        .map(
          (m) => `<li role="option" data-id="${escapeHtml(m.id)}" aria-selected="${state.model?.id === m.id}">
      <span class="n">${escapeHtml(m.name)}${m.recommended ? '<span class="tag rec">önerilen</span>' : ''}${m.free ? '<span class="tag free">ücretsiz</span>' : ''}</span>
      <span class="p">$${fmtPrice(m.promptPrice)} / $${fmtPrice(m.completionPrice)}</span>
      <span class="id">${escapeHtml(m.id)} · ${Math.round(m.context / 1000)}K ctx</span></li>`,
        )
        .join('')
    : '<li class="muted">Eşleşen model yok.</li>';
}
function selectModel(model) {
  state.model = model;
  settings.model = model.id;
  $('[data-model-name]').textContent = model.name;
  $('[data-model-price]').textContent = `$${fmtPrice(model.promptPrice)}/$${fmtPrice(model.completionPrice)}`;
  $('[data-model-price]').title = 'Girdi / çıktı fiyatı, 1M token başına (USD)';
  updateActionState();
}
function toggleMenu(open) {
  menu.hidden = !open;
  $('[data-model-toggle]').setAttribute('aria-expanded', String(open));
  if (open) {
    renderModelList();
    $('[data-model-search]').focus();
  }
}
$('[data-model-toggle]').addEventListener('click', () => toggleMenu(menu.hidden));
$('[data-model-search]').addEventListener('input', renderModelList);
$('[data-model-free]').addEventListener('change', renderModelList);
$('[data-model-list]').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-id]');
  if (!li) return;
  const model = state.models.find((m) => m.id === li.dataset.id);
  if (model) selectModel(model);
  toggleMenu(false);
});
document.addEventListener('click', (e) => {
  if (!menu.hidden && !picker.contains(e.target)) toggleMenu(false);
});

async function loadModels() {
  try {
    state.models = await fetchVisionModels();
    $('[data-model-count]').textContent = `${state.models.length} model`;
    const saved = state.models.find((m) => m.id === settings.model);
    selectModel(saved || state.models.find((m) => m.recommended) || state.models[0]);
  } catch (err) {
    $('[data-model-name]').textContent = 'Model listesi alınamadı';
    toast(err.message, true);
  }
}

// ------------------------------------------------------------------------------------------
// Image input
// ------------------------------------------------------------------------------------------
const dropzone = $('[data-dropzone]');
$('[data-file]').addEventListener('change', (e) => e.target.files[0] && setImage(e.target.files[0]));
['dragenter', 'dragover'].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    dropzone.classList.add('drag');
  }),
);
['dragleave', 'drop'].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    dropzone.classList.remove('drag');
  }),
);
dropzone.addEventListener('drop', (e) => {
  const file = [...(e.dataTransfer?.files || [])].find((f) => f.type.startsWith('image/'));
  if (file) setImage(file);
});
window.addEventListener('paste', (e) => {
  const file = [...(e.clipboardData?.files || [])].find((f) => f.type.startsWith('image/'));
  if (file) setImage(file);
});

async function setImage(file) {
  try {
    const bitmap = await createImageBitmap(file);
    const maxPng = 1600;
    const s1 = Math.min(1, maxPng / Math.max(bitmap.width, bitmap.height));
    const c1 = document.createElement('canvas');
    c1.width = Math.round(bitmap.width * s1);
    c1.height = Math.round(bitmap.height * s1);
    c1.getContext('2d').drawImage(bitmap, 0, 0, c1.width, c1.height);
    const pngBlob = await new Promise((r) => c1.toBlob(r, 'image/png'));
    const pngBytes = new Uint8Array(await pngBlob.arrayBuffer());

    const maxLlm = 1280;
    const s2 = Math.min(1, maxLlm / Math.max(bitmap.width, bitmap.height));
    const c2 = document.createElement('canvas');
    c2.width = Math.round(bitmap.width * s2);
    c2.height = Math.round(bitmap.height * s2);
    const g = c2.getContext('2d');
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, c2.width, c2.height);
    g.drawImage(bitmap, 0, 0, c2.width, c2.height);
    const dataUrl = c2.toDataURL('image/jpeg', 0.9);

    // Small PNG for make_comparison_sheet.py (pure-Python PNG decoding stays fast).
    const s3 = Math.min(1, 640 / Math.max(bitmap.width, bitmap.height));
    const c3 = document.createElement('canvas');
    c3.width = Math.round(bitmap.width * s3);
    c3.height = Math.round(bitmap.height * s3);
    const g3 = c3.getContext('2d');
    g3.fillStyle = '#ffffff';
    g3.fillRect(0, 0, c3.width, c3.height);
    g3.drawImage(bitmap, 0, 0, c3.width, c3.height);
    const reviewPng = new Uint8Array(await (await new Promise((r) => c3.toBlob(r, 'image/png'))).arrayBuffer());

    if (state.image?.previewUrl) URL.revokeObjectURL(state.image.previewUrl);
    const previewUrl = URL.createObjectURL(file);
    state.image = { file, name: file.name, width: bitmap.width, height: bitmap.height, pngBytes, reviewPng, dataUrl, previewUrl };
    const img = $('[data-preview]');
    img.src = previewUrl;
    img.hidden = false;
    $('[data-dz-empty]').hidden = true;
    $('[data-compare-img]').src = previewUrl;
    const meta = $('[data-image-meta]');
    meta.hidden = false;
    meta.textContent = `${file.name} · ${bitmap.width}×${bitmap.height}px · ${(file.size / 1024).toFixed(0)} KB`;
    updateActionState();
  } catch (err) {
    toast('Görsel okunamadı: ' + err.message, true);
  }
}

// ------------------------------------------------------------------------------------------
// Step tracking (left list + "Pipeline kodları" cards)
// ------------------------------------------------------------------------------------------
function resetSteps() {
  state.steps = [];
  renderSteps();
}

function addStep(step) {
  const s = { status: 'running', startedAt: performance.now(), ...step };
  state.steps.push(s);
  renderSteps();
  return {
    step: s,
    set(patch) {
      Object.assign(s, patch);
      renderSteps();
    },
    done(patch = {}) {
      Object.assign(s, { status: 'done', ms: Math.round(performance.now() - s.startedAt) }, patch);
      renderSteps();
    },
    warn(patch = {}) {
      Object.assign(s, { status: 'warn', ms: Math.round(performance.now() - s.startedAt) }, patch);
      renderSteps();
    },
    fail(patch = {}) {
      Object.assign(s, { status: 'failed', ms: Math.round(performance.now() - s.startedAt) }, patch);
      renderSteps();
    },
  };
}

const KIND_LABEL = { python: 'img2threejs · Python', llm: 'LLM · OpenRouter', js: 'Studio · JavaScript', system: 'Sistem' };

function renderSteps() {
  const list = $('[data-steps]');
  if (!state.steps.length) {
    list.innerHTML = '<li class="muted">Henüz çalıştırılmadı.</li>';
  } else {
    list.innerHTML = state.steps
      .map(
        (s, i) => `<li class="${s.status}${hasCode(s) ? ' clickable' : ''}" data-step="${i}" title="${hasCode(s) ? 'Kodu göster' : ''}">
        <span class="ico"></span>
        <span><span class="t">${escapeHtml(s.title)}</span>${s.detail ? `<span class="d">${escapeHtml(s.detail)}</span>` : ''}</span>
        <span class="ms">${s.ms >= 100 ? (s.ms / 1000).toFixed(1) + 's' : ''}</span></li>`,
      )
      .join('');
  }
  const cards = $('[data-code-steps]');
  const withCode = state.steps.map((s, i) => [s, i]).filter(([s]) => hasCode(s));
  cards.innerHTML = withCode.length
    ? withCode
        .map(
          ([s, i]) => `<button type="button" class="card" data-step="${i}">
        <div class="card-top"><span class="fmt">${KIND_LABEL[s.kind] || s.kind}</span>
        <span class="status ${s.status === 'done' ? 'ok' : s.status === 'failed' ? 'err' : 'warn'}">${{ done: 'tamam', failed: 'hata', warn: 'uyarı', running: 'çalışıyor' }[s.status] || ''}</span></div>
        <h3>${escapeHtml(s.title)}</h3>
        ${s.command ? `<div class="cmd">${escapeHtml(s.command.length > 180 ? s.command.slice(0, 180) + '…' : s.command)}</div>` : ''}
        ${s.about ? `<p>${escapeHtml(s.about)}</p>` : ''}
        <span class="open">Kodu göster →</span></button>`,
        )
        .join('')
    : '<p class="muted">Dönüşüm çalıştığında adımlar burada listelenecek.</p>';
}

function hasCode(s) {
  return Boolean(s.command || s.script || s.system || s.response || s.output || s.source);
}

async function openStep(index) {
  const s = state.steps[index];
  if (!s || !hasCode(s)) return;
  const tabs = [];
  if (s.kind === 'python') {
    if (s.command) {
      tabs.push({
        label: 'Komut & çıktı',
        filename: 'run.sh',
        lang: 'bash',
        content: `$ ${s.command}\n# exit code: ${s.exitCode ?? 0}\n\n${s.stdout ? '# --- stdout ---\n' + s.stdout : ''}${s.stderr ? '\n# --- stderr ---\n' + s.stderr : ''}`.trim(),
      });
    }
    if (s.script) {
      const res = await forge.api('source', { path: s.script }).catch((e) => ({ source: '# ' + e.message }));
      tabs.push({ label: `Kaynak: ${s.script.split('/').pop()}`, filename: s.script.split('/').pop(), content: res.source });
    }
  }
  if (s.kind === 'llm') {
    if (s.system) tabs.push({ label: 'Sistem prompt\'u', filename: 'system-prompt.md', lang: 'markdown', content: s.system });
    if (s.user) tabs.push({ label: 'Kullanıcı mesajı', filename: 'user-message.md', lang: 'markdown', content: s.user });
    if (s.response) tabs.push({ label: 'Model yanıtı', filename: 'response.md', lang: 'markdown', content: s.response });
  }
  if (s.source) {
    const text = await fetch(s.source).then((r) => r.text()).catch(() => '');
    tabs.push({ label: `Kaynak: ${s.source.split('/').pop()}`, filename: s.source.split('/').pop(), content: text });
  }
  if (s.output) tabs.push({ label: s.output.label || 'Çıktı', filename: s.output.filename, content: s.output.content });
  openCode({ title: s.title, description: s.about || KIND_LABEL[s.kind] || '', tabs });
}
$('[data-steps]').addEventListener('click', (e) => {
  const li = e.target.closest('[data-step]');
  if (li) openStep(Number(li.dataset.step));
});
$('[data-code-steps]').addEventListener('click', (e) => {
  const card = e.target.closest('[data-step]');
  if (card) openStep(Number(card.dataset.step));
});

function addCost(usage) {
  if (usage && typeof usage.cost === 'number') state.cost += usage.cost;
  $('[data-cost]').textContent = state.cost ? `≈ $${state.cost.toFixed(4)}` : '';
}

// ------------------------------------------------------------------------------------------
// Pipeline pieces
// ------------------------------------------------------------------------------------------
function checkCancelled() {
  if (state.abort?.signal.aborted) throw new DOMException('İptal edildi', 'AbortError');
}

function pyStep(title, about, result, extra = {}) {
  return {
    kind: 'python',
    title,
    about,
    command: result.command,
    script: result.script,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    ...extra,
  };
}

async function llm(title, about, messages, opts = {}) {
  const system = messages.find((m) => m.role === 'system')?.content || '';
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  const userText = Array.isArray(lastUser?.content)
    ? lastUser.content.map((p) => (p.type === 'text' ? p.text : `[görsel: ${p.image_url?.url?.slice(0, 30)}…]`)).join('\n\n')
    : lastUser?.content || '';
  const tracker = addStep({ kind: 'llm', title, about, system, user: userText, detail: `${state.model.id} düşünüyor…` });
  const tick = setInterval(() => {
    tracker.set({ detail: `${state.model.id} · ${Math.round((performance.now() - tracker.step.startedAt) / 1000)} sn` });
  }, 1000);
  try {
    const res = await chat({ model: state.model.id, messages, signal: state.abort?.signal, ...opts });
    addCost(res.usage);
    const usage = res.usage ? `${res.usage.prompt_tokens ?? '?'} → ${res.usage.completion_tokens ?? '?'} token${typeof res.usage.cost === 'number' ? ` · $${res.usage.cost.toFixed(4)}` : ''}` : '';
    let parsed;
    try {
      parsed = extractJson(res.text);
    } catch (err) {
      tracker.fail({ response: res.text, detail: err.message + (res.finishReason === 'length' ? ' (yanıt token limitinde kesildi)' : '') });
      throw err;
    }
    tracker.done({
      response: res.text,
      detail: usage,
      output: { label: 'Parse edilen JSON', filename: 'parsed.json', content: JSON.stringify(parsed, null, 2) },
    });
    return { parsed, text: res.text };
  } catch (err) {
    if (tracker.step.status === 'running') tracker.fail({ detail: err.message });
    throw err;
  } finally {
    clearInterval(tick);
  }
}

async function ensureForge() {
  const t = addStep({ kind: 'system', title: 'Pyodide + img2threejs forge', detail: 'Python çalışma zamanı yükleniyor (ilk seferde ~10 sn)…' });
  const off = forge.onProgress((m) => t.set({ detail: m }));
  try {
    const info = await forge.init();
    t.done({ detail: `Pyodide ${info.version} · forge.zip açıldı` });
  } finally {
    off();
  }
}

async function getStarter(brief) {
  const name = String(brief.targetName || state.image?.name?.replace(/\.[^.]+$/, '') || 'Object').slice(0, 80);
  const complexity = brief.complexity || 'moderate';
  const key = `${name}|${complexity}`;
  if (state.starter && state.starterKey === key) return state.starter;
  const res = await forge.api('starter', { name, image: '/work/reference.png', complexity });
  const [assess, sculpt] = res.steps;
  addStep(pyStep('Pre-spec assessment', 'Nesne sınıfı, karmaşıklık katmanı ve quality contract iskeleti.', assess)).done({
    detail: `complexity=${complexity}`,
    status: assess.exitCode ? 'failed' : 'done',
  });
  const st = addStep(pyStep('Starter ObjectSculptSpec', 'img2threejs\'in başlangıç spec şablonu (pass sırası, kapılar, look-dev hedefleri).', sculpt));
  if (!res.spec) {
    st.fail({ detail: 'spec üretilemedi' });
    throw new Error('new_sculpt_spec.py başarısız: ' + (sculpt.stderr || '').slice(-300));
  }
  st.done({ output: { label: 'Starter spec', filename: 'starter-spec.json', content: JSON.stringify(res.spec, null, 2) } });
  state.starter = res.spec;
  state.starterKey = key;
  return res.spec;
}

/** Expand brief → validate (strict) → LLM fix loop. Returns { spec, check }. */
async function buildSpec(brief, history) {
  let current = brief;
  for (let attempt = 0; ; attempt += 1) {
    checkCancelled();
    const starter = await getStarter(current);
    const ex = addStep({
      kind: 'js',
      title: attempt ? `Brief → spec genişletme (düzeltme ${attempt})` : 'Brief → ObjectSculptSpec genişletme',
      about: 'studio_pipeline.expand_brief(): LLM brief\'ini starter spec\'in alanlarına yerleştirir (bileşenler, malzemeler, detay envanteri, ışık).',
      source: 'py/studio_pipeline.py',
    });
    const { spec } = await forge.api('expand', { starter, brief: current });
    ex.done({
      detail: `${spec.componentTree.length} bileşen · ${spec.materials.length} malzeme`,
      output: { label: 'ObjectSculptSpec', filename: 'object-sculpt-spec.json', content: JSON.stringify(spec, null, 2) },
    });

    const check = await forge.api('check', { spec });
    const problems = check.errors.length + check.strictFailures.length + check.passGaps.length;
    const vs = addStep(
      pyStep('Strict-quality kapısı', 'validate_sculpt_spec.py --strict-quality: generator\'ın kod yazmadan önce uyguladığı kapı.', check.cli, {
        output: { label: 'Kapı raporu', filename: 'strict-quality.json', content: JSON.stringify({ errors: check.errors, strictFailures: check.strictFailures, passGaps: check.passGaps, warnings: check.warnings }, null, 2) },
      }),
    );
    if (!problems) {
      vs.done({ detail: `PASS · ${check.warnings.length} uyarı` });
      return { spec, check, brief: current };
    }
    if (attempt >= state.maxFix) {
      vs.warn({ detail: `${problems} sorun kaldı: önizleme non-strict üretilecek` });
      return { spec, check, brief: current };
    }
    vs.warn({ detail: `${problems} sorun: LLM'e düzeltme için gönderiliyor` });
    history.push({ role: 'user', content: fixPrompt(check) });
    const { parsed, text } = await llm(
      `Spec düzeltme ${attempt + 1}/${state.maxFix}`,
      'Kapının hata listesi modele geri verilir; model brief\'i düzeltir (img2threejs self-correction).',
      history,
    );
    history.push({ role: 'assistant', content: text });
    current = parsed.brief && parsed.components === undefined ? parsed.brief : parsed;
  }
}

async function buildAndRender(spec, check, label) {
  checkCancelled();
  const g = addStep({
    kind: 'python',
    title: 'Three.js factory üretimi',
    about: 'generate_threejs_factory.py: spec\'ten TypeScript THREE.Group factory\'si, look-dev ışıkları, ortam ve kamera yardımcıları.',
    script: 'forge/stage3_build/generate_threejs_factory.py',
  });
  const gen = await forge.api('generate', { spec });
  g.done({
    command: gen.command,
    detail: `${gen.code.split('\n').length} satır TypeScript · ${gen.exports.model}`,
    output: { label: 'Üretilen TypeScript', filename: `create${baseName(gen.exports)}Model.ts`, content: gen.code },
  });

  const c = addStep({ kind: 'js', title: 'TypeScript → JavaScript', about: 'Sucrase ile tip anotasyonları kaldırılır; modül import map üzerinden three.js\'e bağlanır.', source: 'js/compile.js' });
  const js = await transpile(gen.code);
  const mod = await importModule(js);
  c.done({ detail: `${(js.length / 1024).toFixed(0)} KB ES modülü`, output: { label: 'Derlenmiş JS', filename: `create${baseName(gen.exports)}Model.js`, content: js } });

  const r = addStep({ kind: 'js', title: 'Render', about: 'Factory çağrılır; look-dev ışıkları, prosedürel ortam ve kamera çerçeveleme uygulanır.', source: 'js/viewer.js' });
  if (game) setMode('inspect');
  const stats = viewer.mount(mod, gen.exports);
  r.done({ detail: `${stats.parts} parça · ${stats.meshes} mesh · ${stats.triangles.toLocaleString('tr-TR')} üçgen` });

  state.ts = gen.code;
  state.js = js;
  state.exportsInfo = gen.exports;
  state.spec = spec;
  state.check = check;

  $('[data-empty]').hidden = true;
  const strictOk = !(check.errors.length + check.strictFailures.length + check.passGaps.length);
  const badge = $('[data-badge]');
  badge.hidden = false;
  badge.className = 'badge' + (strictOk ? '' : ' err');
  badge.textContent = strictOk ? label : `strict-quality geçmedi (${check.strictFailures.length + check.errors.length}) · non-strict önizleme`;
  badge.title = strictOk
    ? 'Tüm build pass\'leri tek seferde üretildi. img2threejs\'in pass başına görsel onayı için "İyileştir" turlarını kullan.'
    : [...check.errors, ...check.strictFailures].join('\n');
  renderStats(stats);
  renderParts();
  renderOutputs();
  if (window.innerWidth < 1080) $('.stage').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderStats(stats) {
  const el = $('[data-stats]');
  el.hidden = false;
  el.innerHTML = `<span>${stats.parts} parça</span><span>${stats.meshes} mesh</span><span>${stats.triangles.toLocaleString('tr-TR')} üçgen</span><span>${stats.materials} malzeme</span>`;
}

function renderParts() {
  const parts = viewer.parts();
  $('[data-parts-wrap]').hidden = !parts.length;
  $('[data-parts-count]').textContent = `(${parts.length})`;
  $('[data-parts]').innerHTML = parts
    .map((p, i) => `<li><label><input type="checkbox" checked data-part="${i}" /> ${escapeHtml(p.name)}<span class="lvl">${escapeHtml(p.level)}</span></label></li>`)
    .join('');
}
$('[data-parts]').addEventListener('change', (e) => {
  const input = e.target.closest('[data-part]');
  if (!input) return;
  const part = viewer.parts()[Number(input.dataset.part)];
  if (part) part.object.visible = input.checked;
});

// ------------------------------------------------------------------------------------------
// Convert
// ------------------------------------------------------------------------------------------
async function runConvert() {
  if (state.running) return;
  state.running = true;
  state.abort = new AbortController();
  state.cost = 0;
  state.reviewRound = 0;
  state.passIndex = 0;
  state.starter = null;
  state.starterKey = '';
  $('[data-review]').hidden = true;
  $('[data-score]').hidden = true;
  addCost(null);
  resetSteps();
  updateActionState();
  setBusy('Pipeline çalışıyor…');
  try {
    await ensureForge();
    checkCancelled();

    const w = addStep({ kind: 'system', title: 'Referans görsel', detail: 'Pyodide dosya sistemine yazılıyor' });
    await forge.writeFile('/work/reference.png', state.image.pngBytes);
    await forge.writeFile('/work/reference-review.png', state.image.reviewPng);
    w.done({ detail: `/work/reference.png · ${state.image.width}×${state.image.height}` });

    const probe = await forge.api('probe', { image: '/work/reference.png' });
    addStep(pyStep('Görsel inceleme (intake)', 'probe_image.py: format, çözünürlük ve teknik uygunluk kontrolü.', probe)).done({
      detail: probe.result ? `${probe.result.technicalSuitability}${probe.result.warnings?.length ? ' · ' + probe.result.warnings.join('; ') : ''}` : 'çıktı okunamadı',
    });
    checkCancelled();

    setBusy('Vision modeli görseli analiz ediyor…');
    const history = [
      { role: 'system', content: authoringSystemPrompt() },
      {
        role: 'user',
        content: [
          { type: 'text', text: authoringUserPrompt({ hint: $('[data-hint]').value.trim(), probe: probe.result }) },
          { type: 'image_url', image_url: { url: state.image.dataUrl } },
        ],
      },
    ];
    const { parsed: brief, text } = await llm(
      'SculptBrief yazımı (vision)',
      'Model görseli img2threejs kurallarıyla inceler: uygunluk, karmaşıklık, detay envanteri, bileşen ayrıştırma, malzemeler.',
      history,
    );
    history.push({ role: 'assistant', content: text });
    state.authorMessages = history;

    setBusy('img2threejs spec ve kod üretiyor…');
    const built = await buildSpec(brief, history);
    state.brief = built.brief;
    await buildAndRender(built.spec, built.check, 'Önizleme · incelenmemiş');
    toast('Model hazır. Oyun testi sekmesinden deneyebilir, "İyileştir" ile referansa yaklaştırabilirsin.');
  } catch (err) {
    handleError(err);
  } finally {
    state.running = false;
    state.abort = null;
    setBusy('');
    updateActionState();
  }
}

function handleError(err) {
  if (err?.name === 'AbortError') {
    toast('İptal edildi.');
    state.steps.filter((s) => s.status === 'running').forEach((s) => (s.status = 'failed'));
  } else {
    console.error(err);
    toast(err.message || String(err), true);
    state.steps.filter((s) => s.status === 'running').forEach((s) => {
      s.status = 'failed';
      s.detail = err.message;
    });
  }
  renderSteps();
}

// ------------------------------------------------------------------------------------------
// Refine (Divine Eye review round)
// ------------------------------------------------------------------------------------------
function dataUrlToBytes(url) {
  const bin = atob(url.split(',')[1]);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToDataUrl(bytes, type) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(new Blob([bytes], { type }));
  });
}

const FORM_PASSES = new Set(['blockout', 'structural-pass', 'form-refinement']);

async function runRefine() {
  if (state.running || !state.spec) return;
  state.running = true;
  state.abort = new AbortController();
  updateActionState();
  setBusy('Render alınıyor ve referansla karşılaştırılıyor…');
  const round = ++state.reviewRound;
  try {
    if (game) setMode('inspect');
    const passOrder = state.spec.sculptPipeline?.passOrder || ['blockout'];
    const passId = passOrder[Math.min(state.passIndex, passOrder.length - 1)];
    const ctx = await forge.api('reviewContext', { spec: state.spec, passId });

    // 1. Renders: reference-angle PNG (for the sheet), map-stripped PNG, two orbit views (JPEG).
    const cam = state.brief?.referenceCamera || {};
    const yaw = Number(cam.yaw) || 25;
    const pitch = Number(cam.pitch) || 15;
    const [mainPng] = viewer.captureViews([{ azimuth: yaw, elevation: pitch }], { size: 560, format: 'image/png' });
    const [mapPng] = viewer.captureViews([{ azimuth: yaw, elevation: pitch }], { size: 560, format: 'image/png', mapStripped: true });
    const orbit = viewer.captureViews(
      [{ azimuth: yaw + 90, elevation: 10 }, { azimuth: yaw + 180, elevation: 28 }],
      { size: 512, format: 'image/jpeg' },
    );
    const dir = `/work/renders/round-${round}`;
    const paths = { main: `${dir}/render-${passId}.png`, map: `${dir}/map-stripped-${passId}.png`, sheet: `${dir}/comparison-${passId}.png` };
    await forge.writeFile(paths.main, dataUrlToBytes(mainPng));
    await forge.writeFile(paths.map, dataUrlToBytes(mapPng));
    addStep({ kind: 'system', title: `İnceleme turu ${round}: render yakalama`, detail: 'referans açısı · map-stripped · yan · arka-üst' }).done();

    // 2. Side-by-side sheet with the original img2threejs script.
    const sheet = await forge.api('sheet', { reference: '/work/reference-review.png', render: paths.main, out: paths.sheet });
    const sheetStep = addStep(pyStep('Karşılaştırma sayfası', 'make_comparison_sheet.py: referans (sol) ve render (sağ) tek bir inceleme görselinde.', sheet));
    let sheetUrl = null;
    if (sheet.ok) {
      sheetUrl = await bytesToDataUrl(await forge.readFile(paths.sheet), 'image/png');
      sheetStep.done({ detail: paths.sheet });
    } else {
      sheetStep.warn({ detail: 'sayfa üretilemedi, referans ve render ayrı gönderilecek' });
    }

    // 3. Divine Eye review by the selected vision model.
    const images = [];
    const labels = [];
    if (sheetUrl) {
      images.push(sheetUrl);
      labels.push('comparison sheet (left = reference photo, right = current render, same camera)');
    } else {
      images.push(state.image.dataUrl, mainPng);
      labels.push('reference photo', 'current render at the reference camera');
    }
    if (FORM_PASSES.has(passId)) {
      images.push(mapPng);
      labels.push('map-stripped render (unlit, untextured: judge form and silhouette only)');
    }
    images.push(...orbit);
    labels.push('orbit view: side', 'orbit view: back-top');
    const messages = [
      { role: 'system', content: reviewSystemPrompt() },
      {
        role: 'user',
        content: [
          { type: 'text', text: reviewUserPrompt({ brief: state.brief, passId, threshold: ctx.threshold, layers: ctx.layers, targets: ctx.targets, images: labels }) },
          ...images.map((url) => ({ type: 'image_url', image_url: { url } })),
        ],
      },
    ];
    const { parsed: review } = await llm(
      `Divine Eye incelemesi (${passId})`,
      "Karşılaştırma sayfası ve orbit render'ları modele verilir; global, katman ve feature skorları ile düzeltilmiş brief döner.",
      messages,
    );

    // 4. Record it with append_review.py. Its gates decide whether the pass is really credited.
    const evidence = { passId, renderScreenshot: paths.main, referenceScreenshot: '/work/reference.png', comparisonImage: sheet.ok ? paths.sheet : '', mapStrippedRender: paths.map };
    let rec = await forge.api('review', { spec: state.spec, review: { ...review, ...evidence } });
    const credited = review.action === 'continue' && rec.step.exitCode === 0;
    const recStep = addStep(pyStep('İnceleme kaydı (append_review.py)', "Skor, katman/feature skorları ve kanıt yolları reviewHistory'ye yazılır; kapılar pass'in gerçekten onaylanıp onaylanmadığına karar verir.", rec.step));
    if (rec.step.exitCode !== 0) {
      const reason = (rec.step.stderr.trim().split('\n').pop() || '').replace(/^ValueError:\s*/, '');
      recStep.warn({ detail: `kapı reddetti: ${reason}` });
      rec = await forge.api('review', { spec: state.spec, review: { ...review, ...evidence, action: 'refine-spec' } });
      addStep(pyStep('İnceleme kaydı (refine-spec)', 'Kapı onaylamadığı için tur refine-spec olarak kaydedildi.', rec.step)).done({ detail: `${passId} · skor ${Number(review.score).toFixed(2)}` });
    } else {
      recStep.done({ detail: `${passId} · skor ${Number(review.score).toFixed(2)} · ${review.action}` });
    }
    state.lastReview = review;
    renderReview(review, passId, credited);

    if (credited) {
      state.passIndex += 1;
      state.spec = rec.spec;
      const next = passOrder[Math.min(state.passIndex, passOrder.length - 1)];
      toast(`${passId} onaylandı (${Number(review.score).toFixed(2)}). Sıradaki kapı: ${next}`);
    } else if (review.brief) {
      setBusy('Düzeltilmiş spec ile model yeniden üretiliyor…');
      const history = [
        { role: 'system', content: authoringSystemPrompt() },
        { role: 'user', content: 'Author the corrected SculptBrief.' },
        { role: 'assistant', content: '```json\n' + JSON.stringify(review.brief) + '\n```' },
      ];
      const built = await buildSpec(review.brief, history);
      built.spec.reviewHistory = rec.spec.reviewHistory || [];
      state.brief = built.brief;
      await buildAndRender(built.spec, built.check, `İnceleme turu ${round} sonrası · ${passId} tekrar incelenecek`);
    } else {
      state.spec = rec.spec;
      toast('Model düzeltilmiş brief döndürmedi; tekrar "İyileştir" deneyebilirsin.');
    }
    const scoreEl = $('[data-score]');
    scoreEl.hidden = false;
    scoreEl.textContent = `Divine Eye ${Number(review.score).toFixed(2)} · ${passId}${credited ? ' ✓' : ''}`;
    scoreEl.title = `Onaylanan pass'ler: ${passOrder.slice(0, state.passIndex).join(', ') || 'yok'}`;
  } catch (err) {
    handleError(err);
  } finally {
    state.running = false;
    state.abort = null;
    setBusy('');
    updateActionState();
  }
}

function renderReview(review, passId, credited) {
  const el = $('[data-review]');
  el.hidden = false;
  const layers = review.layerScores || {};
  const features = Array.isArray(review.featureReviews) ? review.featureReviews : [];
  el.innerHTML = `<h4>Son inceleme · ${escapeHtml(passId)} · skor ${Number(review.score || 0).toFixed(2)} · ${credited ? 'onaylandı ✓' : 'düzeltme gerekli'}</h4>
    <div class="layers">${Object.entries(layers).map(([k, v]) => `<span>${escapeHtml(k)}: ${Number(v).toFixed(2)}</span>`).join('')}</div>
    ${features.length ? `<div class="layers">${features.map((f) => `<span>${escapeHtml(f.id)}: ${Number(f.score).toFixed(2)}</span>`).join('')}</div>` : ''}
    ${review.summary ? `<p>${escapeHtml(review.summary)}</p>` : ''}
    ${review.mismatches?.length ? `<b>Uyuşmazlıklar</b><ul>${review.mismatches.map((m) => `<li>${escapeHtml(m)}</li>`).join('')}</ul>` : ''}
    ${review.specFixes?.length ? `<b>Yapılan düzeltmeler</b><ul>${review.specFixes.map((m) => `<li>${escapeHtml(m)}</li>`).join('')}</ul>` : ''}`;
}

// ------------------------------------------------------------------------------------------
// Outputs
// ------------------------------------------------------------------------------------------
function outputDefs() {
  const n = baseName(state.exportsInfo);
  const e = state.exportsInfo;
  const tsName = `create${n}Model.ts`;
  const jsName = `create${n}Model.js`;
  const htmlName = `${n}.html`;
  const title = state.spec?.targetName || n;
  return [
    {
      id: 'glb',
      fmt: '.glb',
      title: 'GLB 3D dosyası',
      desc: 'Tüm parçalar, PBR malzemeler ve prosedürel dokular tek bir binary glTF 2.0 dosyasında.',
      use: 'Unity, Unreal, Godot, Blender, Babylon.js, PlayCanvas ya da GLTFLoader olan her ortamda kullanılabilir.',
      download: async () => download(`${n}.glb`, await exportGlb(viewer.model)),
      tabs: () => [{ label: 'Motor içe aktarma rehberi', filename: 'GLB-IMPORT.txt', content: engineGuide(`${n}.glb`) }],
    },
    {
      id: 'ts',
      fmt: '.ts',
      title: 'Three.js TypeScript modülü',
      desc: 'img2threejs\'in ürettiği orijinal factory: kod-tabanlı geometri, prosedürel PBR malzemeler, pivot/socket/collider hiyerarşisi.',
      use: 'Vite/Next/webpack ile kurulan bir Three.js oyununa import et; parçaları kodla animasyonlandır.',
      download: () => download(tsName, state.ts),
      tabs: () => [
        { label: tsName, filename: tsName, content: state.ts },
        { label: 'Kullanım', filename: 'usage.ts', content: threeUsage(e, 'ts') },
      ],
    },
    {
      id: 'js',
      fmt: '.js',
      title: 'Three.js JavaScript ES modülü',
      desc: 'Aynı factory, derleme adımı gerektirmeyen düz JavaScript olarak. Import map ile doğrudan tarayıcıda çalışır.',
      use: 'Build aracı olmayan projeler, CodePen/Glitch denemeleri ve script tag ile yüklenen oyunlar.',
      download: () => download(jsName, state.js, 'text/javascript'),
      tabs: () => [
        { label: jsName, filename: jsName, content: state.js },
        { label: 'Kullanım', filename: 'usage.js', content: threeUsage(e, 'js') },
      ],
    },
    {
      id: 'html',
      fmt: '.html',
      title: 'Tek dosya HTML embed',
      desc: 'Model, görüntüleyici, ışıklar ve orbit kontrolleriyle birlikte bağımsız çalışan tek bir HTML sayfası.',
      use: 'Bir siteye iframe ile gömmek, portfolyoda paylaşmak ya da müşteriye tek dosya göndermek için.',
      download: () => download(htmlName, standaloneHtml(state.js, e, title), 'text/html'),
      tabs: () => [
        { label: htmlName, filename: htmlName, content: standaloneHtml(state.js, e, title) },
        { label: 'iframe kodu', filename: 'embed.html', content: iframeSnippet(htmlName) },
      ],
    },
    {
      id: 'r3f',
      fmt: '.tsx',
      title: 'React Three Fiber bileşeni',
      desc: 'Factory\'yi saran, tick animasyonunu ve ortamı yöneten hazır <Model /> bileşeni.',
      use: 'React / Next.js projelerinde @react-three/fiber sahnesine tek satırla ekle.',
      download: () => download(`${n}.tsx`, r3fComponent(e)),
      tabs: () => [
        { label: `${n}.tsx`, filename: `${n}.tsx`, content: r3fComponent(e) },
        { label: tsName, filename: tsName, content: state.ts },
      ],
    },
    {
      id: 'spec',
      fmt: '.json',
      title: 'ObjectSculptSpec + SculptBrief',
      desc: 'Modelin kaynak tarifi: bileşen ağacı, malzemeler, detay envanteri, kalite sözleşmesi ve inceleme geçmişi.',
      use: 'img2threejs CLI\'da (Claude Code/Codex) pass-pass çalışmaya devam etmek ya da modeli yeniden üretmek için.',
      download: () => download('object-sculpt-spec.json', JSON.stringify(state.spec, null, 2), 'application/json'),
      tabs: () => [
        { label: 'object-sculpt-spec.json', filename: 'object-sculpt-spec.json', content: JSON.stringify(state.spec, null, 2) },
        { label: 'sculpt-brief.json', filename: 'sculpt-brief.json', content: JSON.stringify(state.brief, null, 2) },
        {
          label: 'CLI ile devam',
          filename: 'continue.sh',
          lang: 'bash',
          content: `# img2threejs'i yerelde kur ve bu spec ile pass-pass devam et
git clone https://github.com/img2threejs/img2threejs.git ~/.claude/skills/img2threejs
cd ~/.claude/skills/img2threejs
python3 forge/stage2_spec/validate_sculpt_spec.py object-sculpt-spec.json --strict-quality
python3 forge/stage3_build/generate_threejs_factory.py object-sculpt-spec.json --out src/createModel.ts
# Claude Code içinde: /img2threejs Continue the reconstruction from object-sculpt-spec.json`,
        },
      ],
    },
  ];
}

function renderOutputs() {
  const defs = outputDefs();
  $('[data-zip]').disabled = false;
  $('[data-outputs]').innerHTML = defs
    .map(
      (d) => `<article class="card" data-output="${d.id}" tabindex="0" role="button" aria-label="${escapeHtml(d.title)}: kodu göster">
      <div class="card-top"><span class="fmt">${d.fmt}</span><h3>${escapeHtml(d.title)}</h3></div>
      <p>${escapeHtml(d.desc)}</p>
      <p class="use"><b>Nerede:</b> ${escapeHtml(d.use)}</p>
      <div class="card-actions"><span class="open">${d.id === 'glb' ? 'Rehberi göster →' : 'Kodu göster →'}</span>
      <button type="button" class="btn secondary sm" data-output-dl="${d.id}" style="margin-left:auto">İndir</button></div>
    </article>`,
    )
    .join('');
}
async function onOutputActivate(e) {
  const dl = e.target.closest('[data-output-dl]');
  const defs = outputDefs();
  if (dl) {
    e.stopPropagation();
    const def = defs.find((d) => d.id === dl.dataset.outputDl);
    try {
      dl.disabled = true;
      await def.download();
    } catch (err) {
      toast('İndirme başarısız: ' + err.message, true);
    } finally {
      dl.disabled = false;
    }
    return;
  }
  const card = e.target.closest('[data-output]');
  if (!card) return;
  const def = defs.find((d) => d.id === card.dataset.output);
  openCode({ title: def.title, description: def.desc, tabs: def.tabs() });
}
$('[data-outputs]').addEventListener('click', onOutputActivate);
$('[data-outputs]').addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[data-output]')) {
    e.preventDefault();
    onOutputActivate(e);
  }
});

$('[data-zip]').addEventListener('click', async () => {
  const btn = $('[data-zip]');
  btn.disabled = true;
  try {
    const { default: JSZip } = await import('https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm');
    const zip = new JSZip();
    const n = baseName(state.exportsInfo);
    const e = state.exportsInfo;
    zip.file(`${n}.glb`, await exportGlb(viewer.model));
    zip.file(`src/create${n}Model.ts`, state.ts);
    zip.file(`src/create${n}Model.js`, state.js);
    zip.file(`src/${n}.tsx`, r3fComponent(e));
    zip.file(`${n}.html`, standaloneHtml(state.js, e, state.spec?.targetName || n));
    zip.file('object-sculpt-spec.json', JSON.stringify(state.spec, null, 2));
    zip.file('sculpt-brief.json', JSON.stringify(state.brief, null, 2));
    zip.file('reference.png', state.image.pngBytes);
    zip.file('GLB-IMPORT.txt', engineGuide(`${n}.glb`));
    zip.file(
      'README.md',
      `# ${state.spec?.targetName || n}\n\nGenerated with img2threejs Studio (img2threejs pipeline, three@${THREE_VERSION}).\n\n- \`${n}.glb\` — game engines / DCC tools\n- \`src/create${n}Model.ts|js\` — procedural Three.js factory\n- \`src/${n}.tsx\` — React Three Fiber component\n- \`${n}.html\` — standalone viewer\n- \`object-sculpt-spec.json\` — ObjectSculptSpec (continue with the img2threejs CLI)\n\n## Usage\n\n\`\`\`js\n${threeUsage(e, 'js')}\n\`\`\`\n`,
    );
    download(`${n}-img2threejs.zip`, await zip.generateAsync({ type: 'blob' }));
  } catch (err) {
    toast('ZIP oluşturulamadı: ' + err.message, true);
  } finally {
    btn.disabled = false;
  }
});

// ------------------------------------------------------------------------------------------
// Viewer controls + game mode
// ------------------------------------------------------------------------------------------
function setMode(mode) {
  if (mode === 'game') {
    if (!viewer.hasModel) {
      toast('Önce bir model oluştur.');
      return;
    }
    game = new GameMode(viewer, ({ score }) => ($('[data-coins]').textContent = score));
    game.start();
    $('[data-game-hud]').hidden = false;
    $('[data-inspect-tools]').hidden = true;
    $('[data-compare]').hidden = true;
    $('[data-stats]').hidden = true;
    viewer.renderer.domElement.focus?.();
  } else {
    if (game) game.stop();
    game = null;
    $('[data-game-hud]').hidden = true;
    $('[data-inspect-tools]').hidden = false;
    $('[data-stats]').hidden = !viewer.hasModel;
    $('[data-compare]').hidden = $('[data-toggle="compare"]').getAttribute('aria-pressed') !== 'true';
  }
  $$('[data-mode]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.mode === mode)));
}
$$('[data-mode]').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
$$('[data-touch] [data-key]').forEach((b) => {
  const code = b.dataset.key;
  const down = (e) => {
    e.preventDefault();
    game?.pressVirtual(code, true);
  };
  const up = (e) => {
    e.preventDefault();
    game?.pressVirtual(code, false);
  };
  b.addEventListener('pointerdown', down);
  b.addEventListener('pointerup', up);
  b.addEventListener('pointerleave', up);
});

$('[data-light]').addEventListener('change', (e) => viewer.setLightMode(e.target.value));
$$('[data-toggle]').forEach((b) =>
  b.addEventListener('click', () => {
    const on = b.getAttribute('aria-pressed') !== 'true';
    b.setAttribute('aria-pressed', String(on));
    const what = b.dataset.toggle;
    if (what === 'rotate') viewer.setAutoRotate(on);
    if (what === 'wire') viewer.setWireframe(on);
    if (what === 'grid') viewer.setGrid(on);
    if (what === 'compare') $('[data-compare]').hidden = !on || !state.image;
  }),
);
$('[data-explode]').addEventListener('input', (e) => viewer.setExplode(Number(e.target.value)));
$('[data-screenshot]').addEventListener('click', () => {
  if (!viewer.hasModel) return;
  download(`${baseName(state.exportsInfo)}-screenshot.png`, dataUrlToBlob(viewer.screenshot()));
});
function dataUrlToBlob(url) {
  return new Blob([dataUrlToBytes(url)], { type: 'image/png' });
}

$('[data-convert]').addEventListener('click', runConvert);
$('[data-refine]').addEventListener('click', runRefine);
$('[data-cancel]').addEventListener('click', () => state.abort?.abort());

// ------------------------------------------------------------------------------------------
// Studio's own source files (for "base kodlar")
// ------------------------------------------------------------------------------------------
const STATIC_SOURCES = [
  ['py/studio_pipeline.py', 'Pyodide adaptörü (brief → spec, forge çağrıları)'],
  ['js/prompts.js', 'LLM prompt\'ları ve SculptBrief şeması'],
  ['js/main.js', 'Pipeline orkestrasyonu'],
  ['js/viewer.js', '3D görüntüleyici'],
  ['js/game.js', 'Oyun testi modu'],
  ['js/exporters.js', 'GLB / HTML / R3F çıktıları'],
  ['js/openrouter.js', 'OpenRouter istemcisi'],
  ['js/pyodide-worker.js', 'Pyodide web worker'],
  ['js/compile.js', 'TS → JS derleme'],
];
$('[data-static-code]').innerHTML = STATIC_SOURCES.map(
  ([path, label]) => `<button type="button" class="chip" data-src="${path}" title="${escapeHtml(label)}">${path}</button>`,
).join('');
$('[data-static-code]').addEventListener('click', async (e) => {
  const chip = e.target.closest('[data-src]');
  if (!chip) return;
  const path = chip.dataset.src;
  const text = await fetch(path).then((r) => r.text());
  const label = STATIC_SOURCES.find(([p]) => p === path)?.[1] || '';
  openCode({ title: path, description: label, tabs: [{ label: path.split('/').pop(), filename: path.split('/').pop(), content: text }] });
});

fetch('forge-manifest.json')
  .then((r) => r.json())
  .then((m) => {
    const el = $('[data-forge-commit]');
    el.textContent = m.commit.slice(0, 10);
  })
  .catch(() => {});

// ------------------------------------------------------------------------------------------
// Boot
// ------------------------------------------------------------------------------------------
updateActionState();
loadModels();
if (!settings.key) setTimeout(() => toast('Başlamak için sağ üstten OpenRouter API anahtarını gir.'), 800);
// Warm the Python runtime in the background so the first conversion starts faster.
if ('requestIdleCallback' in window) requestIdleCallback(() => forge.init().catch(() => {}));
else setTimeout(() => forge.init().catch(() => {}), 1500);

// Dev hook: ?demo=brief.json renders a stored SculptBrief without calling an LLM.
const demo = new URLSearchParams(location.search).get('demo');
if (demo && /^demo\/[\w-]+\.json$/.test(demo)) runDemo(demo);
async function runDemo(url) {
  state.running = true;
  setBusy('Demo brief çalıştırılıyor…');
  try {
    await ensureForge();
    const brief = await fetch(url).then((r) => r.json());
    if (!state.image) {
      const res = await fetch('favicon.svg');
      const blob = await res.blob();
      const c = document.createElement('canvas');
      c.width = c.height = 64;
      const png = await new Promise((r) => c.toBlob(r, 'image/png'));
      const bytes = new Uint8Array(await png.arrayBuffer());
      state.image = { name: 'demo.png', width: 64, height: 64, pngBytes: bytes, reviewPng: bytes, dataUrl: c.toDataURL(), previewUrl: URL.createObjectURL(blob) };
    }
    await forge.writeFile('/work/reference.png', state.image.pngBytes);
    await forge.writeFile('/work/reference-review.png', state.image.reviewPng);
    const built = await buildSpec(brief, []);
    state.brief = built.brief;
    await buildAndRender(built.spec, built.check, 'Demo brief · LLM yok');
  } catch (err) {
    handleError(err);
  } finally {
    state.running = false;
    setBusy('');
    updateActionState();
  }
}

Object.assign(window.__studio, { runConvert, runRefine, forge });
