// 음성 자막 — 탭 소리 → (말소리 구간 자르기) → Whisper(일본어) → background 로 보냄
// 이 페이지는 확장이 띄우는 보이지 않는 문서(offscreen)라 chrome.runtime 메시지만 쓸 수 있다.
import { pipeline, env, AutoModel, Tensor } from './lib/transformers.min.js';

// 확장 안에 넣어 둔 엔진 파일을 쓴다(외부 CDN 코드 금지 · blob 주소 import 는 확장 보안 정책에 막힘)
env.allowLocalModels = false;
env.useWasmCache = false;
const ORT = env.backends.onnx && env.backends.onnx.wasm;
if (ORT) {
  ORT.wasmPaths = {
    mjs: chrome.runtime.getURL('lib/ort-wasm-simd-threaded.asyncify.mjs'),
    wasm: chrome.runtime.getURL('lib/ort-wasm-simd-threaded.asyncify.wasm'),
  };
  ORT.numThreads = 1; // 여러 스레드는 확장 페이지에서 따로 설정이 필요 — 그래픽카드가 계산하므로 1개로 충분
}

// 모델 — 처음 한 번 huggingface.co 에서 내려받아 브라우저에 저장(다음부터는 저장된 것 사용)
const MODELS = {
  turbo: { id: 'onnx-community/whisper-large-v3-turbo', device: 'webgpu', dtype: { encoder_model: 'fp16', decoder_model_merged: 'q4' }, label: '정확 (large-v3-turbo)' },
  small: { id: 'onnx-community/whisper-small', device: 'webgpu', dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' }, label: '보통 (small)' },
  base: { id: 'onnx-community/whisper-base', device: 'wasm', dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' }, label: '가벼움 (base · 그래픽카드 없이)' },
};

const SR = 16000; // Whisper 입력 표본율
const FRAME = 480; // 30ms
const MIN_SEG = 0.6 * SR; // 이보다 짧은 소리는 버림
const MAX_SEG = 8 * SR; // 말이 안 끊겨도 8초마다 자름
const END_SIL = 17; // 30ms × 17 = 0.5초 조용하면 한 마디 끝
const PRE_ROLL = 7; // 말 시작 앞 0.2초도 같이
const MAX_QUEUE = 2; // 밀린 구간이 이보다 많으면 오래된 것부터 버림(자막이 계속 늦어지지 않게)

let asr = null; // Whisper 파이프라인
let asrKey = '';
let loading = null;
let session = null; // 지금 듣는 탭
const DIAG = { frames: 0, vadMax: 0, vadLast: 0, segs: 0, asrDone: 0, asrEmpty: 0, asrMs: 0, mode: '' };
function diagText() {
  const d = DIAG;
  return `받은 소리 ${(d.frames * 512 / 16000).toFixed(0)}초 · 판별 ${d.mode} (최근 ${d.vadLast.toFixed(2)} · 최고 ${d.vadMax.toFixed(2)}) · 말 구간 ${d.segs} · 인식 ${d.asrDone}(빈 것 ${d.asrEmpty}) · 인식 시간 ${(d.asrMs / 1000).toFixed(1)}초 · 대기 ${queue.length}`;
}
setInterval(() => {
  if (session && session.ready) chrome.runtime.sendMessage({ type: 'stt-status', tabId: session.tabId, state: 'diag', text: diagText() }).catch(() => {});
}, 2000);

function status(state, text, extra) {
  chrome.runtime.sendMessage(Object.assign({ type: 'stt-status', tabId: session && session.tabId, state, text }, extra || {})).catch(() => {});
}

async function gpuInfo() {
  if (!navigator.gpu) return { webgpu: false, f16: false };
  try {
    const ad = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!ad) return { webgpu: false, f16: false };
    return { webgpu: true, f16: ad.features.has('shader-f16') };
  } catch (e) {
    return { webgpu: false, f16: false };
  }
}

async function pickModel(want) {
  const g = await gpuInfo();
  let key = want && MODELS[want] ? want : 'auto';
  if (key === 'auto') key = g.webgpu ? (g.f16 ? 'turbo' : 'small') : 'base';
  if (key === 'turbo' && !g.f16) key = g.webgpu ? 'small' : 'base'; // fp16 을 못 쓰는 그래픽카드
  if (MODELS[key].device === 'webgpu' && !g.webgpu) key = 'base';
  return { key, gpu: g };
}

async function loadModel(want) {
  const { key, gpu } = await pickModel(want);
  if (asr && asrKey === key) return asr;
  if (loading && loading.key === key) return loading.p;
  const m = MODELS[key];
  status('loading', `모델 준비 중 — ${m.label}${gpu.webgpu ? ' · 그래픽카드 사용' : ' · CPU'}`, { model: key });
  const files = {};
  const p = (async () => {
    if (asr) {
      try { await asr.dispose(); } catch (e) {}
      asr = null;
    }
    const t0 = performance.now();
    const pipe = await pipeline('automatic-speech-recognition', m.id, {
      device: m.device,
      dtype: m.dtype,
      progress_callback: (d) => {
        if (d && d.status === 'progress' && d.file) {
          files[d.file] = { loaded: d.loaded || 0, total: d.total || 0 };
          let L = 0, T = 0;
          for (const f of Object.values(files)) { L += f.loaded; T += f.total; }
          if (T > 0) status('loading', `모델 내려받는 중 ${Math.floor((L / T) * 100)}% (${(L / 1048576).toFixed(0)} / ${(T / 1048576).toFixed(0)} MB) — 처음 한 번만`, { model: key });
        }
      },
    });
    // 첫 실행은 그래픽카드 셰이더 준비로 느림 → 조용한 1초로 미리 한 번 돌림
    status('loading', '모델 예열 중…', { model: key });
    await pipe(new Float32Array(SR), { language: 'japanese', task: 'transcribe' });
    asr = pipe;
    asrKey = key;
    status('ready', `준비됨 — ${m.label} (${((performance.now() - t0) / 1000).toFixed(0)}초)`, { model: key });
    return pipe;
  })();
  loading = { key, p };
  try {
    return await p;
  } finally {
    loading = null;
  }
}

// ---------------------------------------------------------------- 사람 목소리 판별(Silero VAD)
// 10-09 소닉 '말을 안 하는데 ありがとうございました(고마워요)가 자꾸 나옴': 소리 크기만으로 자르니 배경음악·게임 효과음도
// Whisper 로 넘어가 지어낸 말이 나옴 → 사람 목소리인지 판별하는 작은 모델(약 2MB)로 목소리 구간만 넘김
let vad = null;
let vadLoading = null;
async function loadVad() {
  if (vad) return vad;
  if (!vadLoading) {
    vadLoading = AutoModel.from_pretrained('onnx-community/silero-vad', { config: { model_type: 'custom' }, dtype: 'fp32', device: 'wasm' })
      .then((m) => (vad = m))
      .catch((e) => { vadLoading = null; throw e; });
  }
  return vadLoading;
}
function makeVadRunner(model) {
  // 10-09: Silero v5 는 매번 직전 조각의 끝 64표본을 앞에 붙여(512 + 64 = 576) 넣어야 제대로 판단함
  // (안 붙였더니 52초 동안 VJ 말소리에서 구간 1개 · 확률 대부분 0). 576 을 못 받는 모델이면 512 로 되돌림
  let state = new Tensor('float32', new Float32Array(2 * 128), [2, 1, 128]);
  const sr = new Tensor('int64', [16000n], []);
  const CTX = 64;
  let ctx = new Float32Array(CTX);
  let useCtx = true;
  return async (frame) => {
    let x = frame;
    if (useCtx) {
      x = new Float32Array(CTX + frame.length);
      x.set(ctx, 0);
      x.set(frame, CTX);
    }
    let out;
    try {
      out = await model({ input: new Tensor('float32', x, [1, x.length]), sr, state });
    } catch (e) {
      if (!useCtx) throw e;
      useCtx = false; // 앞 64표본을 못 받는 모델
      out = await model({ input: new Tensor('float32', frame, [1, frame.length]), sr, state });
    }
    ctx = frame.slice(frame.length - CTX);
    state = out.stateN;
    return out.output.data[0];
  };
}

// ---------------------------------------------------------------- 말소리 구간 자르기
function makeSegmenter(onSeg, vadRun) {
  // vadRun 이 있으면 512표본(32ms)마다 사람 목소리 확률로, 없으면 소리 크기로 판단
  const N = vadRun ? 512 : FRAME;
  const endSil = vadRun ? 16 : END_SIL; // 약 0.5초 조용하면 한 마디 끝
  const preRoll = vadRun ? 6 : PRE_ROLL;
  let floor = 0.003;
  let speaking = false;
  let silent = 0;
  let cur = [];
  let curLen = 0;
  let voicedN = 0;
  let framesN = 0;
  const pre = [];
  let frame = new Float32Array(N);
  let fpos = 0;
  const fq = [];
  let running = false;
  let vadErr = 0;
  let vadMax = 0; // 지금까지 본 가장 높은 목소리 확률(진단용)
  let vadFrames = 0;

  function flush() {
    // 목소리로 본 조각이 30% 안 되면 버림(음악·효과음이 대부분인 구간)
    if (curLen >= MIN_SEG && (!vadRun || voicedN >= framesN * 0.2)) {
      DIAG.segs++;
      const a = new Float32Array(curLen);
      let o = 0;
      for (const c of cur) { a.set(c, o); o += c.length; }
      onSeg(a);
    }
    cur = [];
    curLen = 0;
    voicedN = 0;
    framesN = 0;
  }
  function step(f, voiced, keep) {
    if (!speaking) {
      pre.push(f);
      if (pre.length > preRoll) pre.shift();
      if (voiced) {
        speaking = true;
        silent = 0;
        for (const p of pre) { cur.push(p); curLen += p.length; framesN++; }
        voicedN++;
        pre.length = 0;
      }
      return;
    }
    cur.push(f);
    curLen += f.length;
    framesN++;
    if (voiced) voicedN++;
    silent = keep ? 0 : silent + 1;
    if (silent >= endSil) {
      speaking = false;
      flush();
    } else if (curLen >= MAX_SEG) {
      flush(); // 말이 계속되면 8초마다 끊어서 보냄(계속 말하는 중으로 둠)
    }
  }
  async function drain() {
    if (running) return;
    running = true;
    try {
      while (fq.length) {
        if (fq.length > 400) fq.splice(0, fq.length - 400); // 판별이 13초 넘게 밀리면 오래된 조각 버림
        const f = fq.shift();
        let p = 0;
        try {
          // 판별이 응답 없이 멈추면(그래픽카드 Whisper 와 동시에 돌 때 등) 1.5초 뒤 오류로 봄
          p = Number(await Promise.race([vadRun(f), new Promise((_, rej) => setTimeout(() => rej(new Error('판별 응답 없음(1.5초)')), 1500))]));
          if (!Number.isFinite(p)) throw new Error('확률 값이 이상함');
          vadErr = 0;
        } catch (e) {
          // 10-09 소닉 '자막이 아예 안 나옴': 판별 모델이 계속 오류면 확률 0 → 아무 구간도 안 넘어감 → 소리 크기로 바꿈
          if (++vadErr >= (String(e.message || e).includes('응답 없음') ? 2 : 10)) {
            vadRun = null;
            fq.length = 0;
            DIAG.mode = '소리 크기';
            status('on', '목소리 판별 모델 오류라 소리 크기로 자름: ' + (e.message || e));
            return;
          }
          continue;
        }
        vadFrames++;
        if (p > vadMax) vadMax = p;
        DIAG.vadLast = p;
        DIAG.vadMax = vadMax;
        if (vadFrames === 940 && vadMax < 0.5) {
          // 30초 동안 목소리를 한 번도 못 찾음 — 판별이 제대로 안 되는 것으로 보고 소리 크기로 바꿈
          vadRun = null;
          fq.length = 0;
          DIAG.mode = '소리 크기';
          status('on', '30초 동안 목소리를 못 찾아 소리 크기로 자름 (최고 확률 ' + vadMax.toFixed(2) + ')');
          return;
        }
        step(f, p > 0.4, p > 0.25);
      }
    } finally {
      running = false;
    }
  }
  function onFrame(f) {
    DIAG.frames += f.length / 512;
    if (vadRun) {
      fq.push(f);
      drain();
      return;
    }
    let s = 0;
    for (let i = 0; i < f.length; i++) s += f[i] * f[i];
    const rms = Math.sqrt(s / f.length);
    const thr = Math.max(0.006, floor * 2.5);
    if (!speaking) floor = floor * 0.98 + rms * 0.02;
    step(f, rms > thr, rms > thr);
  }
  return {
    push(x) {
      for (let i = 0; i < x.length; i++) {
        frame[fpos++] = x[i];
        if (fpos === N) {
          onFrame(frame);
          frame = new Float32Array(N);
          fpos = 0;
        }
      }
    },
    end() { if (speaking) flush(); },
  };
}

// 표본율 바꾸기(탭 소리 48000 → 16000) — 구간 평균
function makeResampler(inRate) {
  const step = inRate / SR;
  let acc = 0, accN = 0, pos = 0;
  return (x) => {
    const out = [];
    for (let i = 0; i < x.length; i++) {
      acc += x[i];
      accN++;
      pos += 1;
      if (pos >= step) {
        out.push(acc / accN);
        acc = 0;
        accN = 0;
        pos -= step;
      }
    }
    return Float32Array.from(out);
  };
}

// Whisper 가 조용한 구간·음악에서 지어내는 말
const HALLU = [/ご視聴ありがとうございま/, /チャンネル登録/, /^字幕/, /^\s*(ん|はい|うん)?[。、!！]?\s*$/];
function cleanText(t) {
  t = String(t || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  if (HALLU.some((r) => r.test(t))) return '';
  t = t.replace(/(.{1,6}?)\1{4,}/g, '$1$1$1'); // 같은 말 여러 번 되풀이 → 3번까지만
  return t;
}

// ---------------------------------------------------------------- 시작·끝
const queue = [];
let busy = false;

async function work() {
  if (busy || !session) return;
  busy = true;
  try {
    while (queue.length && session) {
      while (queue.length > MAX_QUEUE) queue.shift(); // 너무 밀리면 오래된 것 버림
      const seg = queue.shift();
      const s = session;
      const t0 = performance.now();
      let out;
      try {
        out = await asr(seg.audio, { language: 'japanese', task: 'transcribe', max_new_tokens: 128 });
      } catch (e) {
        status('error', '음성 인식 오류: ' + (e.message || e));
        continue;
      }
      const ms = performance.now() - t0;
      const ja = cleanText(out && out.text);
      DIAG.asrDone++;
      DIAG.asrMs = ms;
      if (!ja) DIAG.asrEmpty++;
      if (!ja || s !== session) continue;
      if (ja === s.lastJa && Date.now() - s.lastAt < 6000) continue; // 바로 앞과 같은 문장(음악에서 되풀이되는 헛말) 버림
      s.lastJa = ja;
      s.lastAt = Date.now();
      chrome.runtime.sendMessage({
        type: 'stt-text', tabId: s.tabId, ja,
        dur: seg.audio.length / SR, asrMs: Math.round(ms),
        lagMs: Math.round(Date.now() - seg.endAt),
      }).catch(() => {});
    }
  } finally {
    busy = false;
  }
}

async function start({ tabId, streamId, model }) {
  await stop(false);
  session = { tabId, stream: null, ctx: null, ready: false };
  const s = session;
  // 탭 소리 받기를 먼저(받기 표는 오래 두면 못 씀) — 모델을 내려받는 동안에도 소리는 그대로 들림
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
      video: false,
    });
  } catch (e) {
    status('error', '탭 소리를 못 받음: ' + (e.message || e) + ' — 자막 시작을 다시 눌러 주세요');
    session = null;
    return;
  }
  const ctx = new AudioContext();
  const src = ctx.createMediaStreamSource(stream);
  src.connect(ctx.destination); // 탭 소리를 잡으면 탭이 무음이 됨 → 여기서 다시 틀어 줌
  await ctx.audioWorklet.addModule(chrome.runtime.getURL('stt-worklet.js'));
  const tap = new AudioWorkletNode(ctx, 'pcm-tap');
  src.connect(tap);
  stream.getAudioTracks().forEach((tr) => tr.addEventListener('ended', () => { if (s === session) stop(true, '탭을 닫았거나 이동해서 자막을 멈춤'); }));
  Object.assign(s, { stream, ctx });
  let vadModel = null;
  try {
    vadModel = await loadVad();
  } catch (e) {
    status('loading', '목소리 판별 모델을 못 불러옴 — 소리 크기로 대신 자름: ' + (e.message || e));
  }
  try {
    await loadModel(model);
  } catch (e) {
    status('error', '모델을 못 불러옴: ' + (e.message || e) + ' — 설정에서 다른 모델을 골라 보세요');
    if (s === session) await stop(false);
    return;
  }
  if (s !== session) return;
  const resample = makeResampler(ctx.sampleRate);
  const seg = makeSegmenter((audio) => {
    if (s !== session) return;
    queue.push({ audio, endAt: Date.now() });
    work();
  }, vadModel ? makeVadRunner(vadModel) : null);
  tap.port.onmessage = (ev) => seg.push(resample(ev.data));
  s.seg = seg;
  Object.assign(DIAG, { frames: 0, vadMax: 0, vadLast: 0, segs: 0, asrDone: 0, asrEmpty: 0, asrMs: 0, mode: vadModel ? '목소리 모델' : '소리 크기' });
  s.ready = true;
  status('on', '자막 켜짐 — 일본어 말소리를 듣는 중', { model: asrKey });
}

async function stop(report = true, why) {
  const s = session;
  session = null;
  queue.length = 0;
  if (s) {
    try { s.seg && s.seg.end(); } catch (e) {}
    try { s.stream && s.stream.getTracks().forEach((t) => t.stop()); } catch (e) {}
    try { s.ctx && (await s.ctx.close()); } catch (e) {}
  }
  if (report) chrome.runtime.sendMessage({ type: 'stt-status', tabId: s && s.tabId, state: 'off', text: why || '자막 꺼짐' }).catch(() => {});
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen') return;
  if (msg.type === 'start') start(msg);
  else if (msg.type === 'stop') stop(true);
  else if (msg.type === 'ping') sendResponse({ on: !!session, tabId: session && session.tabId, model: asrKey });
});

chrome.runtime.sendMessage({ type: 'offscreen-up' }).catch(() => {});
