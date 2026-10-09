// 탭 소리를 그대로 메인 스레드로 넘겨 주는 오디오 워클릿 (채널 평균 = 모노)
class PcmTap extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0];
    if (ch && ch.length) {
      const n = ch[0].length;
      const mono = new Float32Array(n);
      for (let c = 0; c < ch.length; c++) {
        const d = ch[c];
        for (let i = 0; i < n; i++) mono[i] += d[i] / ch.length;
      }
      this.port.postMessage(mono, [mono.buffer]);
    }
    return true;
  }
}
registerProcessor('pcm-tap', PcmTap);
