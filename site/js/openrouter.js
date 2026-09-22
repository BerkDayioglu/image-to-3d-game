// OpenRouter client: public model catalogue + vision chat completions with the user's own key.
// The key never leaves the browser except in the Authorization header sent to openrouter.ai.

const API = 'https://openrouter.ai/api/v1';
const KEY_STORAGE = 'i2t.openrouterKey';
const MODEL_STORAGE = 'i2t.model';

export const RECOMMENDED = [
  'anthropic/claude-sonnet-5',
  'anthropic/claude-opus-5',
  'google/gemini-3-pro',
  'openai/gpt-5.6-sol',
  'anthropic/claude-fable-5.1',
  'google/gemini-3.8-flash',
];

function safeGet(storage, key) {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}
function safeSet(storage, key, value) {
  try {
    if (value == null) storage.removeItem(key);
    else storage.setItem(key, value);
  } catch {
    /* storage blocked: key stays in memory only */
  }
}

let memoryKey = safeGet(localStorage, KEY_STORAGE) || safeGet(sessionStorage, KEY_STORAGE) || '';

export const settings = {
  get key() {
    return memoryKey;
  },
  get remembered() {
    return Boolean(safeGet(localStorage, KEY_STORAGE));
  },
  setKey(key, remember) {
    memoryKey = (key || '').trim();
    safeSet(localStorage, KEY_STORAGE, remember && memoryKey ? memoryKey : null);
    safeSet(sessionStorage, KEY_STORAGE, memoryKey || null);
  },
  get model() {
    return safeGet(localStorage, MODEL_STORAGE) || '';
  },
  set model(id) {
    safeSet(localStorage, MODEL_STORAGE, id);
  },
};

export async function fetchVisionModels() {
  const res = await fetch(`${API}/models`);
  if (!res.ok) throw new Error(`Model listesi alınamadı (${res.status})`);
  const { data } = await res.json();
  const models = data
    .filter((m) => {
      const input = m.architecture?.input_modalities || [];
      const output = m.architecture?.output_modalities || ['text'];
      return input.includes('image') && output.includes('text') && !m.id.endsWith(':batch');
    })
    .map((m) => ({
      id: m.id,
      name: m.name || m.id,
      description: m.description || '',
      context: m.context_length || 0,
      maxOutput: m.top_provider?.max_completion_tokens || null,
      promptPrice: Number(m.pricing?.prompt || 0) * 1e6,
      completionPrice: Number(m.pricing?.completion || 0) * 1e6,
      created: m.created || 0,
      recommended: RECOMMENDED.includes(m.id),
      free: Number(m.pricing?.prompt || 0) === 0 && Number(m.pricing?.completion || 0) === 0,
    }));
  models.sort((a, b) => {
    const ra = RECOMMENDED.indexOf(a.id);
    const rb = RECOMMENDED.indexOf(b.id);
    if (ra !== -1 || rb !== -1) return (ra === -1 ? 99 : ra) - (rb === -1 ? 99 : rb);
    return b.created - a.created;
  });
  return models;
}

export async function checkKey(key) {
  const res = await fetch(`${API}/key`, { headers: { Authorization: `Bearer ${key}` } });
  if (!res.ok) throw new Error(res.status === 401 ? 'Anahtar geçersiz' : `Anahtar doğrulanamadı (${res.status})`);
  const { data } = await res.json();
  return data;
}

/**
 * Send a chat completion. `messages` use the OpenAI format; image parts are
 * { type: 'image_url', image_url: { url: dataUrl } }.
 */
export async function chat({ model, messages, maxTokens = 16000, temperature = 0.2, signal }) {
  if (!settings.key) throw new Error('OpenRouter API anahtarı gerekli (Ayarlar).');
  const res = await fetch(`${API}/chat/completions`, {
    method: 'POST',
    signal,
    headers: {
      Authorization: `Bearer ${settings.key}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': location.origin,
      'X-Title': 'img2threejs Studio',
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: maxTokens,
      temperature,
      usage: { include: true },
    }),
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`OpenRouter beklenmeyen yanıt (${res.status}): ${text.slice(0, 300)}`);
  }
  if (!res.ok || body.error) {
    const msg = body.error?.message || `HTTP ${res.status}`;
    throw new Error(`OpenRouter hatası: ${msg}`);
  }
  const choice = body.choices?.[0];
  const content = choice?.message?.content;
  const textOut = Array.isArray(content) ? content.map((p) => p.text || '').join('') : content || '';
  return {
    text: textOut,
    finishReason: choice?.finish_reason,
    usage: body.usage || null,
    model: body.model || model,
  };
}

/** Pull the first JSON object out of a model reply (tolerates ```json fences and prose). */
export function extractJson(text) {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [];
  if (fence) candidates.push(fence[1]);
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end > start) candidates.push(text.slice(start, end + 1));
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      try {
        // common LLM slip: trailing commas
        return JSON.parse(candidate.replace(/,\s*([}\]])/g, '$1'));
      } catch {
        /* try next */
      }
    }
  }
  throw new Error('Model yanıtında geçerli JSON bulunamadı.');
}
