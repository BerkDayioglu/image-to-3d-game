// Modal code viewer: tabs, syntax highlighting (highlight.js), copy and download.
import { download } from './exporters.js';

let hljsPromise = null;
function loadHljs() {
  hljsPromise ??= import('https://cdn.jsdelivr.net/npm/highlight.js@11.10.0/+esm').then((m) => m.default);
  return hljsPromise;
}

const LANG_BY_EXT = { ts: 'typescript', tsx: 'typescript', js: 'javascript', json: 'json', py: 'python', html: 'xml', md: 'markdown', sh: 'bash', txt: 'plaintext' };
const HIGHLIGHT_LIMIT = 160_000;

const modal = document.getElementById('code-modal');
const titleEl = modal.querySelector('[data-code-title]');
const descEl = modal.querySelector('[data-code-desc]');
const tabsEl = modal.querySelector('[data-code-tabs]');
const pre = modal.querySelector('pre code');
const metaEl = modal.querySelector('[data-code-meta]');
const copyBtn = modal.querySelector('[data-code-copy]');
const dlBtn = modal.querySelector('[data-code-download]');

let current = null;

modal.addEventListener('click', (e) => {
  if (e.target === modal || e.target.closest('[data-code-close]')) closeCode();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && modal.open) closeCode();
});
copyBtn.addEventListener('click', async () => {
  if (!current) return;
  try {
    await navigator.clipboard.writeText(current.content);
    copyBtn.textContent = 'Kopyalandı ✓';
  } catch {
    copyBtn.textContent = 'Kopyalanamadı';
  }
  setTimeout(() => (copyBtn.textContent = 'Kopyala'), 1400);
});
dlBtn.addEventListener('click', () => {
  if (current) download(current.filename, current.content);
});

function closeCode() {
  modal.close();
  document.body.classList.remove('modal-open');
}

async function showTab(tab) {
  current = tab;
  tabsEl.querySelectorAll('button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.key === tab.key)));
  const ext = (tab.filename.split('.').pop() || 'txt').toLowerCase();
  const lang = tab.lang || LANG_BY_EXT[ext] || 'plaintext';
  const lines = tab.content.split('\n').length;
  metaEl.textContent = `${tab.filename} · ${lines.toLocaleString('tr-TR')} satır · ${(new Blob([tab.content]).size / 1024).toFixed(1)} KB`;
  pre.className = `hljs language-${lang}`;
  pre.textContent = tab.content;
  if (tab.content.length <= HIGHLIGHT_LIMIT && lang !== 'plaintext') {
    try {
      const hljs = await loadHljs();
      if (current !== tab) return;
      pre.innerHTML = hljs.highlight(tab.content, { language: lang, ignoreIllegals: true }).value;
    } catch {
      /* plain text fallback */
    }
  }
}

/**
 * openCode({ title, description, tabs: [{ key, label, filename, content, lang? }] })
 * Code is only rendered when the user opens it.
 */
export function openCode({ title, description = '', tabs }) {
  const list = tabs.filter((t) => t && typeof t.content === 'string');
  if (!list.length) return;
  titleEl.textContent = title;
  descEl.textContent = description;
  descEl.hidden = !description;
  tabsEl.innerHTML = '';
  list.forEach((tab, i) => {
    tab.key ??= `t${i}`;
    const b = document.createElement('button');
    b.type = 'button';
    b.role = 'tab';
    b.dataset.key = tab.key;
    b.textContent = tab.label;
    b.addEventListener('click', () => showTab(tab));
    tabsEl.appendChild(b);
  });
  tabsEl.hidden = list.length < 2;
  modal.showModal();
  document.body.classList.add('modal-open');
  showTab(list[0]);
}
