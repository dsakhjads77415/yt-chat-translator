// YouTube 라이브 채팅 iframe 안에서 실행: 새 메시지를 감지해 번역하고 원문 자리에 표시
(function () {
  if (window.__ytctLoaded) return;
  window.__ytctLoaded = true;

  const D = globalThis.YTCT_DICT;
  const RENDERER_SEL = [
    'yt-live-chat-text-message-renderer',
    'yt-live-chat-paid-message-renderer',
    'yt-live-chat-membership-item-renderer',
  ].join(',');
  const DEFAULTS = { enabled: true, mode: 'replace', otherLangs: false, userDict: '', outEnabled: true };

  let settings = Object.assign({}, DEFAULTS);
  let userMap = {};
  let alive = true; // 확장 프로그램이 다시 로드되면 false

  const cache = new Map(); // 원문(보낸 문장) → 번역
  const CACHE_MAX = 3000;
  function cacheSet(k, v) {
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(k, v);
  }

  // ---------- 메시지 추출 ----------
  function extract(msgEl) {
    let text = '';
    const emojis = [];
    for (const n of msgEl.childNodes) {
      if (n.nodeType === 3) text += n.textContent;
      else if (n.nodeName === 'IMG') {
        const alt = n.getAttribute('alt') || '';
        // 유니코드 이모지는 글자로, 채널 전용 이모티콘은 이미지로 보존
        if (alt && !/[A-Za-z0-9_:]/.test(alt)) text += alt;
        else emojis.push(n);
      } else if (n.nodeType === 1) text += n.textContent;
    }
    return { text: text.replace(/\s+/g, ' ').trim(), emojis };
  }

  // ---------- 표시 ----------
  function clear(r) {
    const old = r.querySelectorAll(':scope .ytct-tr');
    old.forEach((e) => e.remove());
    const msg = r.querySelector('#message');
    if (msg) msg.classList.remove('ytct-hidden');
    r.__ytct = null;
  }

  function applyMode(r) {
    const st = r.__ytct;
    if (!st || !st.span) return;
    const both = settings.mode === 'both';
    st.span.classList.toggle('ytct-below', both);
    st.msg.classList.toggle('ytct-hidden', !both);
  }

  function render(r, sig, translated) {
    const st = r.__ytct;
    if (!st || st.sig !== sig || !r.isConnected) return; // 그 사이 메시지가 바뀜
    if (!translated) return;
    const span = document.createElement('span');
    span.className = 'ytct-tr';
    span.title = '원문: ' + st.text;
    span.appendChild(document.createTextNode(translated));
    for (const img of st.emojis) {
      const c = img.cloneNode(true);
      const src = img.currentSrc || img.src;
      if (src) c.src = src; // 지연 로딩 이미지가 빈 칸으로 복제되는 것 방지
      span.appendChild(document.createTextNode(' '));
      span.appendChild(c);
    }
    st.msg.after(span);
    st.span = span;
    applyMode(r);
  }

  function processRenderer(r) {
    const msg = r.querySelector('#message');
    if (!msg) return;
    const { text, emojis } = extract(msg);
    if (r.__ytct && r.__ytct.sig === text) return; // 이미 처리함
    clear(r);
    if (!settings.enabled || !D.needsTranslation(text, settings.otherLangs)) return;

    r.__ytct = { sig: text, text, emojis, msg, span: null };
    const plan = D.prepare(text, userMap);
    if (plan.local) return render(r, text, plan.local);
    if (!plan.send) return;
    plan.key = plan.send + '\u0001' + plan.raw;
    const hit = cache.get(plan.key);
    if (hit) return render(r, text, finish(hit, plan));
    enqueue({ r, sig: text, plan });
  }

  // 구글 번역 결과에는 떼어 둔 웃음(ㅋㅋ)을 다시 붙이고, AI 번역은 원문 그대로 보냈으므로 붙이지 않음
  function finish(res, plan) {
    let s = res.text;
    if (res.engine !== 'gemini' && plan.suffix) s += ' ' + plan.suffix;
    if (plan.codes) s += ' ' + plan.codes;
    return s;
  }

  // ---------- 묶음 번역 큐 ----------
  let queue = [];
  let timer = null;
  let inflight = false;
  const FLUSH_MS = 700;
  const BATCH_MAX = 40;

  function enqueue(item) {
    queue.push(item);
    schedule();
  }
  function schedule() {
    if (timer || inflight || !queue.length) return;
    timer = setTimeout(flush, FLUSH_MS);
  }

  async function flush() {
    timer = null;
    if (!alive || !queue.length) return;
    // 화면에서 사라졌거나 바뀐 메시지는 버림
    queue = queue.filter((it) => it.r.isConnected && it.r.__ytct && it.r.__ytct.sig === it.sig);
    const batch = queue.splice(0, BATCH_MAX);
    if (!batch.length) return;

    const uniq = [];
    const seen = new Map();
    for (const it of batch) {
      const k = it.plan.key;
      if (cache.has(k)) continue;
      if (!seen.has(k)) {
        seen.set(k, uniq.length);
        uniq.push({ t: it.plan.send, raw: it.plan.raw, sl: it.plan.sl, key: k });
      }
    }

    inflight = true;
    let results = [];
    if (uniq.length) {
      try {
        const res = await chrome.runtime.sendMessage({
          type: 'translate',
          items: uniq.map(({ t, raw, sl }) => ({ t, raw, sl })),
        });
        results = (res && res.results) || [];
      } catch (e) {
        if (String(e).includes('context invalidated')) alive = false;
        results = [];
      }
    }
    inflight = false;

    uniq.forEach((u, i) => {
      if (results[i] && results[i].text) cacheSet(u.key, results[i]);
    });
    for (const it of batch) {
      const tr = cache.get(it.plan.key);
      if (tr) render(it.r, it.sig, finish(tr, it.plan));
      else if (!it.retried) queue.push(Object.assign(it, { retried: true })); // 실패하면 한 번만 다시 시도
    }
    schedule();
  }

  // ---------- 전체 다시 적용 ----------
  function all() {
    return document.querySelectorAll(RENDERER_SEL);
  }
  function reprocessAll() {
    all().forEach((r) => {
      clear(r);
      processRenderer(r);
    });
  }

  // ---------- 감지 ----------
  function handleMutations(muts) {
    if (!alive) return;
    const todo = new Set();
    for (const m of muts) {
      for (const n of m.addedNodes) {
        if (n.nodeType !== 1) continue;
        if (n.matches && n.matches(RENDERER_SEL)) todo.add(n);
        else if (n.querySelectorAll) n.querySelectorAll(RENDERER_SEL).forEach((x) => todo.add(x));
      }
      // 기존 메시지 내용이 바뀐 경우 (삭제·재사용 등)
      const t = m.target;
      if (t && t.nodeType === 1 && !(t.classList && t.classList.contains('ytct-tr'))) {
        const msg = t.closest && t.closest('#message');
        const r = msg && msg.closest(RENDERER_SEL);
        if (r) todo.add(r);
      }
    }
    todo.forEach(processRenderer);
  }

  function start() {
    const obs = new MutationObserver(handleMutations);
    obs.observe(document.documentElement, { childList: true, subtree: true });
    all().forEach(processRenderer);
  }

  // ---------- 내 채팅: 한국어 → 일본어 ----------
  // 한글이 들어간 상태에서 Enter → 일본어로 바꿔 넣기만 함 (전송 X). 다시 Enter → 전송.
  // Alt+Enter → 번역 없이 그대로 전송
  const HANGUL_RE = /[ᄀ-ᇿ㄰-㆏가-힯]/;
  const INPUT_SEL = 'yt-live-chat-text-input-field-renderer #input, yt-live-chat-text-input-field-renderer [contenteditable]';
  let outBusy = false;
  let statusEl = null;
  let lastOut = ''; // 방금 번역해 넣은 문장 (그대로 Enter 하면 전송)

  function inputOf(t) {
    return t && t.closest ? t.closest(INPUT_SEL) : null;
  }
  function inputText(el) {
    let s = '';
    const emojis = [];
    for (const n of el.childNodes) {
      if (n.nodeType === 3) s += n.textContent;
      else if (n.nodeName === 'IMG') {
        const alt = n.getAttribute('alt') || '';
        if (alt && !/[A-Za-z0-9_:]/.test(alt)) s += alt;
        else emojis.push(n.cloneNode(true));
      } else s += n.textContent;
    }
    return { text: s.replace(/\s+/g, ' ').trim(), emojis };
  }
  function setInput(el, text, emojis) {
    el.focus();
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(range);
    // insertText 를 써야 YouTube 가 입력 변경을 인식함
    if (!document.execCommand('insertText', false, text)) {
      el.textContent = text;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    }
    if (emojis && emojis.length) {
      emojis.forEach((img) => el.appendChild(img));
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }
  function showStatus(el, msg, isErr) {
    if (!statusEl) {
      statusEl = document.createElement('div');
      statusEl.className = 'ytct-status';
      document.body.appendChild(statusEl);
    }
    const r = el.getBoundingClientRect();
    statusEl.style.left = Math.max(4, r.left) + 'px';
    statusEl.style.bottom = Math.max(4, window.innerHeight - r.top + 6) + 'px';
    statusEl.style.maxWidth = Math.max(160, r.width) + 'px';
    statusEl.classList.toggle('ytct-err', !!isErr);
    statusEl.textContent = msg;
    statusEl.hidden = !msg;
  }
  function clickSend() {
    // 안쪽 버튼부터 순서대로 찾음 (바깥 div 를 누르면 전송이 안 됨)
    for (const sel of ['#send-button button', '#send-button tp-yt-paper-icon-button', '#send-button yt-icon-button', '#send-button']) {
      const b = document.querySelector(sel);
      if (b) {
        b.click();
        return true;
      }
    }
    return false;
  }

  document.addEventListener(
    'keydown',
    async (e) => {
      if (e.key !== 'Enter' || e.shiftKey || !settings.outEnabled || !alive) return;
      const el = inputOf(e.target);
      if (!el) return;
      const cur = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!HANGUL_RE.test(cur) || (lastOut && cur === lastOut)) {
        lastOut = '';
        if (statusEl) statusEl.hidden = true;
        return; // 일본어 등 → YouTube 가 그대로 전송
      }
      // 여기부터는 YouTube 의 Enter(전송) 를 막음
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.isComposing || e.keyCode === 229) return; // 한글 조합 중 Enter: 조합 끝난 뒤 오는 Enter 에서 처리
      if (e.altKey) {
        if (!clickSend()) showStatus(el, '전송 버튼을 찾지 못했습니다', true);
        return;
      }
      if (outBusy) return;
      outBusy = true;
      const { text, emojis } = inputText(el);
      showStatus(el, '일본어로 번역 중…');
      try {
        const res = await chrome.runtime.sendMessage({ type: 'translate-out', text });
        if (res && res.text) {
          setInput(el, res.text, emojis);
          lastOut = (el.textContent || '').replace(/\s+/g, ' ').trim();
          showStatus(el, `원문: ${text}  ·  확인 후 Enter 로 전송`);
        } else {
          showStatus(el, '번역 실패 — Alt+Enter 로 원문 전송 가능', true);
        }
      } catch (err) {
        showStatus(el, '번역 실패 — 확장 프로그램을 다시 불러온 뒤 새로고침 해주세요', true);
      }
      outBusy = false;
    },
    true
  );

  // ---------- 설정 ----------
  function applySettings(s) {
    const prev = settings;
    settings = Object.assign({}, DEFAULTS, s);
    userMap = D.parseUserDict(settings.userDict);
    return prev;
  }

  chrome.storage.sync.get(DEFAULTS, (s) => {
    applySettings(s);
    start();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    const next = Object.assign({}, settings);
    for (const k of Object.keys(changes)) next[k] = changes[k].newValue;
    const prev = applySettings(next);
    const needRedo =
      prev.enabled !== settings.enabled ||
      prev.otherLangs !== settings.otherLangs ||
      prev.userDict !== settings.userDict;
    if (needRedo) {
      if (prev.userDict !== settings.userDict) cache.clear();
      reprocessAll();
    } else if (prev.mode !== settings.mode) all().forEach(applyMode);
  });
  // 번역 엔진을 바꾸면 이후 메시지부터 새 엔진으로
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes.engine || changes.geminiModel || changes.geminiKey)) cache.clear();
  });
})();
