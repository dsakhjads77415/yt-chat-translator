// 방송 화면 위에 음성 자막(한국어 + 일본어 원문) 표시
(() => {
  if (window.top !== window) return;
  const SET = { sttShowJa: true, sttSize: 22, sttKeep: 7 };
  chrome.storage.sync.get(SET, (s) => Object.assign(SET, s));
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== 'sync') return;
    for (const k of Object.keys(SET)) if (ch[k]) SET[k] = ch[k].newValue;
    if (box) box.style.setProperty('--ytct-size', SET.sttSize + 'px');
  });

  let box = null;
  let badge = null;

  function host() {
    return document.querySelector('#movie_player') || document.querySelector('.html5-video-player');
  }
  function ensure() {
    const h = host();
    if (!h) return null;
    if (!box || !h.contains(box)) {
      box = document.createElement('div');
      box.className = 'ytct-subs';
      box.style.setProperty('--ytct-size', SET.sttSize + 'px');
      h.appendChild(box);
      badge = document.createElement('div');
      badge.className = 'ytct-subs-badge';
      badge.hidden = true;
      h.appendChild(badge);
    }
    return box;
  }

  function addLine(ko, ja) {
    const b = ensure();
    if (!b) return;
    const line = document.createElement('div');
    line.className = 'ytct-line';
    const k = document.createElement('div');
    k.className = 'ytct-ko';
    k.textContent = ko || ja;
    line.appendChild(k);
    if (SET.sttShowJa && ko) {
      const j = document.createElement('div');
      j.className = 'ytct-ja';
      j.textContent = ja;
      line.appendChild(j);
    }
    b.appendChild(line);
    while (b.children.length > 2) b.firstChild.remove(); // 최근 두 줄만
    setTimeout(() => {
      line.classList.add('ytct-fade');
      setTimeout(() => line.remove(), 600);
    }, (SET.sttKeep || 7) * 1000);
  }

  function setBadge(state, text) {
    ensure();
    if (!badge) return;
    if (state === 'off' || !text) {
      badge.hidden = true;
      return;
    }
    badge.hidden = false;
    badge.textContent = '자막: ' + text;
    badge.dataset.state = state;
    if (state === 'on' || state === 'ready') setTimeout(() => { if (badge.dataset.state === state) badge.hidden = true; }, 4000);
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg) return;
    if (msg.type === 'stt-sub') addLine(msg.ko, msg.ja);
    else if (msg.type === 'stt-status' && msg.state !== 'diag') {
      setBadge(msg.state, msg.text);
      if (msg.state === 'off' && box) box.textContent = '';
    }
  });
})();
