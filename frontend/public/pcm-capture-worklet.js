/**
 * AudioWorklet processor that captures float32 mic samples, resamples them to
 * 16 kHz, converts to 16-bit signed PCM (little-endian), batches into ~100 ms
 * chunks, and posts each chunk back to the main thread as an Int16Array.
 *
 * Main thread sends each chunk as a binary WS frame to the backend, which
 * forwards it to AWS Transcribe Streaming.
 *
 * Why a worklet instead of ScriptProcessorNode: ScriptProcessorNode is
 * deprecated, runs on the main thread, and routinely glitches. AudioWorklet
 * runs in a dedicated audio thread with consistent sample-block timing.
 */

const TARGET_RATE = 16000;
const CHUNK_MS = 100;
const CHUNK_SAMPLES = (TARGET_RATE * CHUNK_MS) / 1000; // 1600 samples per chunk

class PCMCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    // AudioContext sample rate is exposed as the global `sampleRate`.
    this._inputRate = sampleRate;
    this._ratio = this._inputRate / TARGET_RATE;
    // Float32 accumulator holding downsampled samples we haven't yet shipped.
    this._buffer = new Float32Array(CHUNK_SAMPLES);
    this._bufferIdx = 0;
    // Sub-sample position for linear-interpolation downsampling.
    this._subPos = 0;
  }

  /**
   * Linear-interpolation downsample from `inputRate` → 16 kHz. Cheap and
   * good enough for STT — pristine quality not required. Streaming-safe:
   * carries `_subPos` between callbacks so we don't drop samples at frame
   * boundaries.
   */
  _downsampleAndEmit(input) {
    while (this._subPos < input.length) {
      const i0 = Math.floor(this._subPos);
      const frac = this._subPos - i0;
      const s0 = input[i0];
      const s1 = i0 + 1 < input.length ? input[i0 + 1] : s0;
      const v = s0 + (s1 - s0) * frac;
      this._buffer[this._bufferIdx++] = v;
      if (this._bufferIdx >= CHUNK_SAMPLES) {
        // Convert float32 [-1,1] → int16 [-32768, 32767].
        const out = new Int16Array(CHUNK_SAMPLES);
        for (let k = 0; k < CHUNK_SAMPLES; k++) {
          let s = this._buffer[k];
          if (s > 1) s = 1;
          else if (s < -1) s = -1;
          out[k] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
        }
        // Transfer the underlying buffer to avoid a copy.
        this.port.postMessage(out, [out.buffer]);
        this._bufferIdx = 0;
      }
      this._subPos += this._ratio;
    }
    // Carry the leftover sub-position into the next input frame so we don't
    // drop samples at the boundary.
    this._subPos -= input.length;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const channel = input[0];
    if (!channel) return true;
    this._downsampleAndEmit(channel);
    return true;
  }
}

registerProcessor('pcm-capture-worklet', PCMCaptureProcessor);
