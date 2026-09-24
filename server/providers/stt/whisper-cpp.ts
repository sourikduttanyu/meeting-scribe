import type { SttProvider } from "./types.ts";

// whisper.cpp's `whisper-server` over HTTP (Metal on Apple Silicon).
//   whisper-server -m models/ggml-small.en.bin --port 8178
// Keep it running: the model load is the slow part, inference is ~0.4 s per utterance warm.
export function whisperCpp(url = "http://localhost:8178"): SttProvider {
  return {
    name: "whisper-cpp",
    async transcribe(samples, sampleRate) {
      const form = new FormData();
      form.append("file", new Blob([wav(samples, sampleRate)], { type: "audio/wav" }), "utterance.wav");
      form.append("response_format", "json");
      form.append("temperature", "0");
      const res = await fetch(`${url}/inference`, { method: "POST", body: form });
      if (!res.ok) throw new Error(`whisper-server ${res.status}: ${await res.text()}`);
      const { text } = (await res.json()) as { text: string };
      return { text: clean(text) };
    },
  };
}

// Whisper emits non-speech markers ("[BLANK_AUDIO]", "(wind blowing)") on
// silence/noise. They are not words anyone said.
function clean(text: string): string {
  return text.replace(/\[[^\]]*\]|\([^)]*\)/g, "").replace(/\s+/g, " ").trim();
}

function wav(samples: Int16Array, rate: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(44 + samples.byteLength));
  const v = new DataView(out.buffer);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  v.setUint32(4, 36 + samples.byteLength, true);
  str(8, "WAVEfmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, samples.byteLength, true);
  out.set(new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength), 44);
  return out;
}
