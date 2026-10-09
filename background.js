// 번역 호출 담당
// - Gemini 키가 있으면 Gemini(AI)로 번역, 한도 초과·오류 시 자동으로 구글 번역으로 대체
// - 구글 번역: 키가 필요 없는 비공식 주소
try { importScripts('dict.js'); } catch (e) {}
const D = self.YTCT_DICT || { TERMS: {}, parseUserDict: () => ({}) };

const GOOGLE = 'https://translate.googleapis.com/translate_a/single';
const GEMINI = 'https://generativelanguage.googleapis.com/v1beta';
const MAX_Q = 4000; // 구글: URL 에 들어가는 q 길이 상한 (인코딩 후)
const GOOGLE_GAP_MS = 250; // 구글 요청 사이 최소 간격
const GEMINI_GAP_MS = 4000; // Gemini 요청 사이 최소 간격 (무료 한도 보호)
const GEMINI_MAX_ITEMS = 40;

const cache = new Map();
const CACHE_MAX = 5000;
function cacheSet(k, v) {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(k, v);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 설정 ----------
async function getCfg() {
  const local = await chrome.storage.local.get({ engine: 'google', geminiKey: '', geminiModel: '' });
  const sync = await chrome.storage.sync.get({ userDict: '' });
  return Object.assign(local, sync);
}

// ---------- 사용량 기록 ----------
let stats = null;
function today() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
async function loadStats() {
  if (!stats) {
    const { stats: s } = await chrome.storage.local.get('stats');
    stats = s || {};
  }
  if (stats.date !== today()) {
    stats = {
      date: today(), messages: 0,
      requests: 0, chars: 0, errors: 0, lastError: '', lastErrorAt: 0,
      gRequests: 0, gErrors: 0, gFallback: 0, gLastError: '', gLastErrorAt: 0,
    };
  }
  return stats;
}
let saveTimer = null;
function saveStats() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    chrome.storage.local.set({ stats });
  }, 1000);
}

// =====================================================================
// 구글 번역 (비공식)
// =====================================================================
let backoffMs = 0;
let backoffUntil = 0;
let lastReqAt = 0;
let chain = Promise.resolve(); // 요청을 한 줄로 세움

function parse(data) {
  if (!Array.isArray(data) || !Array.isArray(data[0])) return null;
  let s = '';
  for (const seg of data[0]) if (Array.isArray(seg) && typeof seg[0] === 'string') s += seg[0];
  return s;
}

function gtx(q, sl, tl = 'ko') {
  const run = async () => {
    const st = await loadStats();
    const wait = Math.max(backoffUntil - Date.now(), lastReqAt + GOOGLE_GAP_MS - Date.now());
    if (wait > 0) await sleep(wait);
    lastReqAt = Date.now();
    const url = `${GOOGLE}?client=gtx&sl=${sl || 'auto'}&tl=${tl}&dt=t&q=${encodeURIComponent(q)}`;
    st.requests++;
    st.chars += q.length;
    try {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const out = parse(await resp.json());
      if (out == null) throw new Error('응답 형식이 바뀜');
      backoffMs = 0;
      saveStats();
      return out;
    } catch (e) {
      // 차단·오류 시 잠시 쉬었다가 다시 (2초 → 최대 60초)
      backoffMs = Math.min(backoffMs ? backoffMs * 2 : 2000, 60000);
      backoffUntil = Date.now() + backoffMs;
      st.errors++;
      st.lastError = String(e.message || e);
      st.lastErrorAt = Date.now();
      saveStats();
      return null;
    }
  };
  const p = chain.then(run, run);
  chain = p.catch(() => {});
  return p;
}

// 여러 문장을 줄바꿈으로 묶어 한 번에 번역. 줄 수가 안 맞으면 반씩 나눠 재시도
async function translateBatch(list, sl) {
  if (list.length === 1) return [await gtx(list[0], sl)];
  const r = await gtx(list.join('\n'), sl);
  if (r != null) {
    const parts = r.split('\n').map((s) => s.trim());
    while (parts.length > list.length && parts[parts.length - 1] === '') parts.pop();
    if (parts.length === list.length && parts.every((p) => p)) return parts;
  } else if (backoffMs >= 8000) {
    return list.map(() => null); // 계속 막히는 중이면 이번 묶음은 포기 (원문 그대로 표시)
  }
  const mid = Math.ceil(list.length / 2);
  return [...(await translateBatch(list.slice(0, mid), sl)), ...(await translateBatch(list.slice(mid), sl))];
}

async function googleItems(items, idxs, out) {
  const groups = {}; // 언어 힌트(sl)별로 묶음
  for (const i of idxs) {
    const key = 'g\u0000' + (items[i].sl || 'auto') + '\u0000' + items[i].t;
    if (cache.has(key)) out[i] = { text: cache.get(key), engine: 'google' };
    else (groups[items[i].sl || 'auto'] = groups[items[i].sl || 'auto'] || []).push(i);
  }
  for (const [sl, gi] of Object.entries(groups)) {
    let chunk = [];
    let len = 0;
    const chunks = [];
    for (const i of gi) {
      const l = encodeURIComponent(items[i].t).length + 3;
      if (chunk.length && (len + l > MAX_Q || chunk.length >= 50)) {
        chunks.push(chunk);
        chunk = [];
        len = 0;
      }
      chunk.push(i);
      len += l;
    }
    if (chunk.length) chunks.push(chunk);
    for (const c of chunks) {
      const res = await translateBatch(c.map((i) => items[i].t), sl);
      c.forEach((i, k) => {
        if (res[k]) {
          out[i] = { text: res[k], engine: 'google' };
          cacheSet('g\u0000' + sl + '\u0000' + items[i].t, res[k]);
        }
      });
    }
  }
}

// =====================================================================
// Gemini (AI 번역)
// =====================================================================
const SYSTEM_PROMPT = `You translate Japanese YouTube live-stream chat messages into natural Korean, the way Korean viewers would type in a live chat.
Rules:
- Input: a JSON array of chat messages. Output: a JSON array of strings with exactly the same length and order, one Korean translation per message.
- Keep each message's tone (casual vs polite) and keep it short. No explanations, notes or quotes.
- Translate internet slang naturally, e.g. 草/ｗｗ/笑 → ㅋㅋ, 888 → 짝짝짝, てぇてぇ → 존귀, おつ → 수고하셨어요, 初見 → 처음 왔어요, 鯖 → 서버, 配信 → 방송.
- Keep @mentions, user names, emoji and numbers unchanged.
- The stream may be about the game Mabinogi Mobile; use the glossary below for its terms when they appear.
- If a message is already Korean or cannot be translated, return it unchanged.`;

let gLastAt = 0;
let gCooldownUntil = 0;
let gCooldownMs = 0;
let gChain = Promise.resolve();

function glossaryFor(texts, userDict, reverse) {
  const all = Object.assign({}, D.TERMS, D.parseUserDict(userDict));
  const joined = texts.join('\n');
  const lines = [];
  for (const [k, v] of Object.entries(all)) {
    if (!reverse && k && joined.includes(k)) lines.push(`${k} → ${v}`);
    if (reverse && v && joined.includes(v)) lines.push(`${v} → ${k}`);
  }
  if (!lines.length) return '';
  return (reverse ? '\n\nGlossary (Korean → Japanese):\n' : '\n\nGlossary (Japanese → Korean):\n') + lines.join('\n');
}

const OUT_PROMPT = `You translate a Korean viewer's YouTube live-chat message into natural Japanese for a Japanese live stream chat.
Rules:
- Input: a JSON array of messages. Output: a JSON array of strings with the same length and order.
- Sound like a friendly Japanese viewer: short, casual-polite (です/ます is fine toward the streamer), natural chat style.
- Convert Korean chat slang naturally, e.g. ㅋㅋ → ｗｗ, ㅠㅠ → 泣, 짝짝짝 → 888.
- Keep @mentions, names, emoji and numbers unchanged. No explanations.
- The stream may be about Mabinogi Mobile; use the glossary for its terms.`;

function retryDelaySec(errText) {
  const m = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(errText || '');
  return m ? Math.ceil(parseFloat(m[1])) : 0;
}

function setGeminiError(st, msg, cooldownMs) {
  st.gErrors++;
  st.gLastError = msg;
  st.gLastErrorAt = Date.now();
  gCooldownUntil = Date.now() + cooldownMs;
  saveStats();
}

// 성공 시 번역 배열, 실패 시 null
async function geminiCall(texts, cfg, { paced = true, out = false } = {}) {
  const run = async () => {
    const st = await loadStats();
    if (paced) {
      const wait = gLastAt + GEMINI_GAP_MS - Date.now();
      if (wait > 0) await sleep(wait);
    }
    gLastAt = Date.now();
    st.gRequests++;
    const body = {
      systemInstruction: { parts: [{ text: (out ? OUT_PROMPT : SYSTEM_PROMPT) + glossaryFor(texts, cfg.userDict, out) }] },
      contents: [{ role: 'user', parts: [{ text: JSON.stringify(texts) }] }],
      generationConfig: {
        temperature: 0.2,
        responseMimeType: 'application/json',
        responseSchema: { type: 'ARRAY', items: { type: 'STRING' } },
      },
    };
    let resp;
    try {
      resp = await fetch(`${GEMINI}/${cfg.geminiModel}:generateContent?key=${encodeURIComponent(cfg.geminiKey)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (e) {
      setGeminiError(st, '네트워크 오류: ' + (e.message || e), 30000);
      return null;
    }
    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      if (resp.status === 429) {
        // 한도 초과: 안내된 대기시간이 있으면 그만큼, 없으면 30초부터 두 배씩 (최대 10분)
        const hinted = retryDelaySec(errText) * 1000;
        gCooldownMs = hinted ? Math.min(Math.max(hinted, 5000), 600000) : Math.min(gCooldownMs ? gCooldownMs * 2 : 30000, 600000);
        setGeminiError(st, '무료 한도 초과 (HTTP 429)', gCooldownMs);
      } else if (resp.status === 400 || resp.status === 401 || resp.status === 403) {
        let m = '';
        try { m = JSON.parse(errText).error.message; } catch (e) {}
        setGeminiError(st, `키 또는 모델 문제 (HTTP ${resp.status}) ${m}`.trim(), 300000);
      } else {
        setGeminiError(st, 'HTTP ' + resp.status, 30000);
      }
      return null;
    }
    try {
      const data = await resp.json();
      const parts = (((data.candidates || [])[0] || {}).content || {}).parts || [];
      const txt = parts.map((p) => p.text || '').join('');
      const arr = JSON.parse(txt);
      if (!Array.isArray(arr) || arr.length !== texts.length || !arr.every((s) => typeof s === 'string')) {
        throw new Error('응답 개수가 맞지 않음');
      }
      gCooldownMs = 0;
      saveStats();
      return arr.map((s) => s.trim());
    } catch (e) {
      setGeminiError(st, '응답 해석 실패: ' + (e.message || e), 5000);
      return null;
    }
  };
  const p = gChain.then(run, run);
  gChain = p.catch(() => {});
  return p;
}

async function geminiItems(items, idxs, out, cfg) {
  const todo = [];
  for (const i of idxs) {
    const key = 'm\u0000' + cfg.geminiModel + '\u0000' + items[i].raw;
    if (cache.has(key)) out[i] = { text: cache.get(key), engine: 'gemini' };
    else todo.push(i);
  }
  for (let s = 0; s < todo.length; s += GEMINI_MAX_ITEMS) {
    if (Date.now() < gCooldownUntil) break; // 쉬는 중이면 남은 건 구글로
    const c = todo.slice(s, s + GEMINI_MAX_ITEMS);
    const res = await geminiCall(c.map((i) => items[i].raw), cfg);
    if (!res) break;
    c.forEach((i, k) => {
      if (res[k]) {
        out[i] = { text: res[k], engine: 'gemini' };
        cacheSet('m\u0000' + cfg.geminiModel + '\u0000' + items[i].raw, res[k]);
      }
    });
  }
}

// 키로 쓸 수 있는 Flash 계열 모델 목록 (가벼운 Flash-Lite 우선)
async function listModels(key) {
  const resp = await fetch(`${GEMINI}/models?pageSize=1000&key=${encodeURIComponent(key)}`);
  const text = await resp.text();
  if (!resp.ok) {
    let m = '';
    try { m = JSON.parse(text).error.message; } catch (e) {}
    throw new Error(`HTTP ${resp.status} ${m}`.trim());
  }
  const data = JSON.parse(text);
  const ver = (n) => parseFloat((/gemini-(\d+(?:\.\d+)?)/.exec(n) || [0, 0])[1]);
  return (data.models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
    .filter((m) => /gemini/.test(m.name) && /flash/.test(m.name) && !/image|tts|audio|live|embed|vision|thinking/.test(m.name))
    .map((m) => ({ name: m.name, label: m.displayName || m.name.replace('models/', '') }))
    .sort((a, b) => {
      const la = /lite/.test(a.name) ? 0 : 1;
      const lb = /lite/.test(b.name) ? 0 : 1;
      const pa = /preview|exp/.test(a.name) ? 1 : 0;
      const pb = /preview|exp/.test(b.name) ? 1 : 0;
      return la - lb || pa - pb || ver(b.name) - ver(a.name) || a.name.localeCompare(b.name);
    });
}

// =====================================================================
async function translateItems(items) {
  const st = await loadStats();
  st.messages += items.length;
  const cfg = await getCfg();
  const out = new Array(items.length).fill(null);
  const all = items.map((_, i) => i);

  const useGemini = cfg.engine === 'gemini' && cfg.geminiKey && cfg.geminiModel;
  if (useGemini && Date.now() >= gCooldownUntil) {
    await geminiItems(items, all.filter((i) => items[i].raw), out, cfg);
  }
  const rest = all.filter((i) => !out[i]);
  if (useGemini && rest.length) st.gFallback += rest.length;
  if (rest.length) await googleItems(items, rest, out);
  saveStats();
  return out;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg) return;
  if (msg.type === 'translate') {
    translateItems(msg.items || []).then(
      (results) => sendResponse({ results }),
      (e) => sendResponse({ results: [], error: String(e) })
    );
    return true;
  }
  if (msg.type === 'stats') {
    loadStats().then((s) =>
      sendResponse(Object.assign({ backoffUntil, gCooldownUntil }, s))
    );
    return true;
  }
  if (msg.type === 'gemini-models') {
    listModels(msg.key).then(
      (models) => sendResponse({ models }),
      (e) => sendResponse({ error: String(e.message || e) })
    );
    return true;
  }
  if (msg.type === 'translate-out') {
    // 내 채팅(한국어) → 일본어
    getCfg().then(async (cfg) => {
      const text = String(msg.text || '').slice(0, 500);
      if (cfg.engine === 'gemini' && cfg.geminiKey && cfg.geminiModel && Date.now() >= gCooldownUntil) {
        const r = await geminiCall([text], cfg, { paced: false, out: true });
        if (r && r[0]) return sendResponse({ text: r[0], engine: 'gemini' });
      }
      const g = await gtx(text, 'ko', 'ja');
      sendResponse(g ? { text: g, engine: 'google' } : { error: '번역 실패' });
    });
    return true;
  }
  if (msg.type === 'gemini-test') {
    // 설정창의 "연결 테스트": 한도 대기 없이 한 번 번역해 봄
    gCooldownUntil = 0;
    gCooldownMs = 0;
    getCfg().then(async (cfg) => {
      const c = Object.assign({}, cfg, { geminiKey: msg.key, geminiModel: msg.model });
      const r = await geminiCall(['こんばんは！初見です', 'それは草ｗｗｗ'], c, { paced: false });
      const st = await loadStats();
      sendResponse(r ? { ok: true, sample: r } : { ok: false, error: st.gLastError });
    });
    return true;
  }
});

// 테스트용 export (확장 프로그램에서는 무시됨)
if (typeof module !== 'undefined') module.exports = { parse, translateItems, translateBatch, listModels, _cache: cache };
