
const resamplePcm16 = function resamplePcm16(input, inputRate, targetRate) {
	if (inputRate <= targetRate || input.length === 0) {
		const out = new Int16Array(input.length);
		for (let i = 0; i < input.length; i++) {
			const s = Math.max(-1, Math.min(1, input[i]));
			out[i] = s < 0 ? s * 32768 : s * 32767;
		};
		return out;
	};
	const ratio = inputRate / targetRate;
	const outLength = Math.floor(input.length / ratio);
	const out = new Int16Array(outLength);
	for (let i = 0; i < outLength; i++) {
		const start = Math.floor(i * ratio);
		const end = Math.min(input.length, Math.floor((i + 1) * ratio));
		let sum = 0;
		let n = 0;
		for (let j = start; j < end; j++) {
			sum += input[j];
			n++;
		};
		const avg = n > 0 ? sum / n : input[start] ?? 0;
		const s = Math.max(-1, Math.min(1, avg));
		out[i] = s < 0 ? s * 32768 : s * 32767;
	};
	return out;
};
const int16ToBase64 = function int16ToBase64(pcm) {
	const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
	const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
	const len = bytes.length;
	let out = "";
	let i = 0;
	for (; i + 2 < len; i += 3) {
		const n = bytes[i] << 16 | bytes[i + 1] << 8 | bytes[i + 2];
		out += chars[n >> 18 & 63] + chars[n >> 12 & 63] + chars[n >> 6 & 63] + chars[n & 63];
	};
	const rem = len - i;
	if (rem === 1) {
		const n = bytes[i] << 16;
		out += chars[n >> 18 & 63] + chars[n >> 12 & 63] + "==";
	} else if (rem === 2) {
		const n = bytes[i] << 16 | bytes[i + 1] << 8;
		out += chars[n >> 18 & 63] + chars[n >> 12 & 63] + chars[n >> 6 & 63] + "=";
	};
	return out;
};

class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this._targetRate = o.targetRate || 16000;
    // Default ~40ms of audio per posted chunk (equal-or-better latency than the old 4096-sample path).
    this._chunkFrames = o.chunkFrames || Math.max(1, Math.round(sampleRate * ((o.chunkMs || 40) / 1000)));
    this._buf = new Float32Array(0);
  }

  process(inputs) {
    const input = inputs[0];
    const ch = input && input[0];
    if (ch && ch.length) {
      const merged = new Float32Array(this._buf.length + ch.length);
      merged.set(this._buf, 0);
      merged.set(ch, this._buf.length);
      this._buf = merged;
    }
    while (this._buf.length >= this._chunkFrames) {
      const chunk = this._buf.subarray(0, this._chunkFrames);
      const pcm = resamplePcm16(chunk, sampleRate, this._targetRate);
      if (pcm.length) this.port.postMessage(int16ToBase64(pcm));
      this._buf = this._buf.slice(this._chunkFrames);
    }
    return true;
  }
}

registerProcessor("pcm-capture", PcmCaptureProcessor);
