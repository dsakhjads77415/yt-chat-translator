// 표시·사전 설정은 sync, 엔진·키는 이 PC에만 (local)
const SYNC_DEFAULTS = { enabled: true, mode: 'replace', otherLangs: false, userDict: '', outEnabled: true };
const LOCAL_DEFAULTS = { engine: 'google', geminiKey: '', geminiModel: '', geminiModels: [] };
const $ = (id) => document.getElementById(id);
const send = (msg) => new Promise((res) => chrome.runtime.sendMessage(msg, (r) => res(chrome.runtime.lastError ? null : r)));

function setMsg(el, text, cls) {
  el.textContent = text;
  el.className = 'msg' + (cls ? ' ' + cls : '');
}

function fillModels(models, selected) {
  const sel = $('geminiModel');
  sel.innerHTML = '';
  if (!models.length) {
    sel.innerHTML = '<option value="">연결 테스트를 누르면 목록이 채워집니다</option>';
    return;
  }
  for (const m of models) {
    const o = document.createElement('option');
    o.value = m.name;
    o.textContent = m.label + (m.name.includes('lite') ? ' (가벼움·추천)' : '');
    sel.appendChild(o);
  }
  sel.value = models.some((m) => m.name === selected) ? selected : models[0].name;
}

function showEngine(engine) {
  $('geminiBox').hidden = engine !== 'gemini';
}

chrome.storage.sync.get(SYNC_DEFAULTS, (s) => {
  $('enabled').checked = s.enabled;
  $('otherLangs').checked = s.otherLangs;
  $('outEnabled').checked = s.outEnabled;
  $('userDict').value = s.userDict;
  const radio = document.querySelector(`input[name="mode"][value="${s.mode}"]`);
  if (radio) radio.checked = true;
});
chrome.storage.local.get(LOCAL_DEFAULTS, (s) => {
  const r = document.querySelector(`input[name="engine"][value="${s.engine}"]`);
  if (r) r.checked = true;
  showEngine(s.engine);
  $('geminiKey').value = s.geminiKey;
  fillModels(s.geminiModels || [], s.geminiModel);
});

$('enabled').addEventListener('change', (e) => chrome.storage.sync.set({ enabled: e.target.checked }));
$('otherLangs').addEventListener('change', (e) => chrome.storage.sync.set({ otherLangs: e.target.checked }));
$('outEnabled').addEventListener('change', (e) => chrome.storage.sync.set({ outEnabled: e.target.checked }));
document.querySelectorAll('input[name="mode"]').forEach((r) =>
  r.addEventListener('change', (e) => chrome.storage.sync.set({ mode: e.target.value }))
);
document.querySelectorAll('input[name="engine"]').forEach((r) =>
  r.addEventListener('change', (e) => {
    chrome.storage.local.set({ engine: e.target.value });
    showEngine(e.target.value);
  })
);
$('geminiModel').addEventListener('change', (e) => chrome.storage.local.set({ geminiModel: e.target.value }));
$('toggleKey').addEventListener('click', () => {
  const k = $('geminiKey');
  k.type = k.type === 'password' ? 'text' : 'password';
  $('toggleKey').textContent = k.type === 'password' ? '보기' : '숨김';
});

$('testGemini').addEventListener('click', async () => {
  const key = $('geminiKey').value.trim();
  const msg = $('geminiMsg');
  if (!key) return setMsg(msg, '키를 먼저 붙여넣어 주세요', 'bad');
  $('testGemini').disabled = true;
  setMsg(msg, '모델 목록 확인 중…');
  await chrome.storage.local.set({ geminiKey: key });

  const list = await send({ type: 'gemini-models', key });
  if (!list || list.error || !list.models || !list.models.length) {
    setMsg(msg, '키 확인 실패: ' + ((list && list.error) || '사용 가능한 Flash 모델 없음'), 'bad');
    $('testGemini').disabled = false;
    return;
  }
  const prev = $('geminiModel').value;
  fillModels(list.models, prev);
  const model = $('geminiModel').value;
  await chrome.storage.local.set({ geminiModels: list.models, geminiModel: model });

  setMsg(msg, '번역 테스트 중…');
  const t = await send({ type: 'gemini-test', key, model });
  if (t && t.ok) {
    setMsg(msg, '연결됨 ✓  예) ' + t.sample.join(' / '), 'ok');
    document.querySelector('input[name="engine"][value="gemini"]').checked = true;
    await chrome.storage.local.set({ engine: 'gemini' });
  } else {
    setMsg(msg, '번역 테스트 실패: ' + ((t && t.error) || '알 수 없음'), 'bad');
  }
  $('testGemini').disabled = false;
});

$('save').addEventListener('click', () => {
  chrome.storage.sync.set({ userDict: $('userDict').value }, () => {
    if (chrome.runtime.lastError) return setMsg($('savedMsg'), '저장 실패: ' + chrome.runtime.lastError.message, 'bad');
    setMsg($('savedMsg'), '저장됨', 'ok');
    setTimeout(() => setMsg($('savedMsg'), ''), 1500);
  });
});

async function showStats() {
  const s = await send({ type: 'stats' });
  if (!s) return;
  const n = (v) => (v || 0).toLocaleString();
  $('sMsg').textContent = n(s.messages);
  $('sG').textContent = `${n(s.gRequests)} / ${n(s.gErrors)}`;
  $('sFb').textContent = n(s.gFallback);
  $('sReq').textContent = `${n(s.requests)} / ${n(s.errors)}`;
  const lines = [];
  const gWait = Math.ceil(((s.gCooldownUntil || 0) - Date.now()) / 1000);
  if (s.gLastError) lines.push('Gemini: ' + s.gLastError + ' (' + new Date(s.gLastErrorAt).toLocaleTimeString() + ')');
  if (gWait > 0) lines.push(`Gemini ${gWait}초 쉬는 중 → 그동안 구글 번역 사용`);
  const wait = Math.ceil(((s.backoffUntil || 0) - Date.now()) / 1000);
  if (s.lastError) lines.push('구글: ' + s.lastError + ' (' + new Date(s.lastErrorAt).toLocaleTimeString() + ')');
  if (wait > 0) lines.push(`구글 ${wait}초 후 재시도`);
  $('sLastErr').textContent = lines.join('\n');
  $('sLastErr').style.whiteSpace = 'pre-line';
}
showStats();
setInterval(showStats, 2000);
