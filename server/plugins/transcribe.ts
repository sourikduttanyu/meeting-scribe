import { PCM_RATE } from "../ingest/scribe.ts";
import type { SttProvider } from "../providers/stt/types.ts";
import type { TranscriptFinal } from "../testing/l0-bot.ts";
import type { Plugin } from "../core/types.ts";
import type { AudioUtterance } from "./vad.ts";

// audio.utterance → STT provider → transcript.final.
// t stays the utterance's capture-time start, however long STT takes, so the
// timeline is right even when transcription lags.
//
// One queue for all speakers: the provider handles one request at a time on
// this machine. Speech is never dropped (drop: "never"); if STT falls behind,
// captions get later, they don't disappear.

export interface TranscriptMeta {
  sttMs: number; // provider latency, for the latency budget
}

export function transcribe(stt: SttProvider): Plugin {
  return {
    name: "transcribe",
    subscribes: ["audio.utterance"],
    queue: { max: 500, drop: "never" },
    async handle(ev, ctx) {
      const u = ev.data as AudioUtterance;
      const started = performance.now();
      const { text } = await stt.transcribe(u.samples, PCM_RATE);
      if (!text) return; // whisper heard no words (noise, breath)
      ctx.emit<TranscriptFinal & TranscriptMeta>("transcript.final", ev.t, {
        speaker: u.speaker,
        text,
        endT: u.endT,
        sttMs: Math.round(performance.now() - started),
      });
    },
  };
}
