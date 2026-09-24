import type { AudioPcm } from "../ingest/scribe.ts";
import { PCM_RATE } from "../ingest/scribe.ts";
import type { Plugin } from "../core/types.ts";

// Energy VAD: per-speaker PCM → whole utterances for Whisper (which is not a
// streaming model; whole phrases give it context and skip silence entirely).
// Pure event time, so an L1 bot can replay an hour of audio in seconds.
//
//   frame     20 ms; speech if RMS > SPEECH_DBFS
//   pre-roll  PREROLL_MS of audio before onset is kept (soft consonants)
//   end       HANGOVER_MS of silence closes the utterance (shorter than a
//             between-sentence pause, longer than a between-word gap)
//   cap       MAX_MS forces a cut so captions keep flowing in a monologue
//   drop      < MIN_SPEECH_MS of voiced audio = a cough or click, not speech
//
// Emits audio.utterance { speaker, samples, endT } at t = start (non-durable:
// audio does not belong in the event log).

export const SPEECH_DBFS = -45;
export const PREROLL_MS = 200;
export const HANGOVER_MS = 600;
export const MAX_MS = 15_000;
export const MIN_SPEECH_MS = 250;
const FRAME = (PCM_RATE * 20) / 1000; // 320 samples

export interface AudioUtterance {
  speaker: string;
  samples: Int16Array;
  endT: number;
}

interface SpeakerState {
  preroll: { t: number; samples: Int16Array }[];
  utterance: { startT: number; frames: Int16Array[]; voicedMs: number; lastVoiceT: number } | null;
  nextT: number; // expected t of the next frame
}

export function vad(): Plugin {
  const states = new Map<string, SpeakerState>(); // `${meetingId}/${speaker}`

  return {
    name: "vad",
    subscribes: ["audio.pcm", "presence.leave", "scribe.offline"],
    queue: { max: 10_000, drop: "never" }, // speech is never dropped
    async handle(ev, ctx) {
      const emit = (speaker: string, u: NonNullable<SpeakerState["utterance"]>) => {
        // Trim trailing silence beyond the pre-roll length; keep a little tail.
        const keep = Math.ceil((u.lastVoiceT - u.startT + PREROLL_MS) / 20);
        const frames = u.frames.slice(0, keep);
        if (u.voicedMs < MIN_SPEECH_MS) return;
        const samples = concat(frames);
        ctx.emit<AudioUtterance>("audio.utterance", u.startT, { speaker, samples, endT: u.startT + (samples.length / PCM_RATE) * 1000 }, { durable: false });
      };

      // Flush when a speaker's audio can no longer arrive.
      if (ev.topic !== "audio.pcm") {
        for (const [key, s] of states) {
          const [meetingId, speaker] = key.split("/") as [string, string];
          if (meetingId !== ev.meetingId || (ev.topic === "presence.leave" && speaker !== ev.source)) continue;
          if (s.utterance) emit(speaker, s.utterance);
          states.delete(key);
        }
        return;
      }

      const key = `${ev.meetingId}/${ev.source}`;
      const s = states.get(key) ?? { preroll: [], utterance: null, nextT: ev.t };
      states.set(key, s);
      const { samples } = ev.data as AudioPcm;

      for (let off = 0; off < samples.length; off += FRAME) {
        const frame = samples.subarray(off, off + FRAME);
        const t = Math.max(ev.t + (off / PCM_RATE) * 1000, s.nextT - 5);
        const gapMs = t - s.nextT; // lost packets / sender paused: counts as silence
        s.nextT = t + 20;
        const voiced = dbfs(frame) > SPEECH_DBFS;
        const u = s.utterance;

        if (!u) {
          if (gapMs > 20) s.preroll = []; // pre-roll must be contiguous with the onset
          if (voiced) {
            s.utterance = {
              startT: s.preroll[0]?.t ?? t,
              frames: [...s.preroll.map((p) => p.samples), frame.slice()],
              voicedMs: 20,
              lastVoiceT: t,
            };
            s.preroll = [];
          } else {
            s.preroll.push({ t, samples: frame.slice() });
            if (s.preroll.length > PREROLL_MS / 20) s.preroll.shift();
          }
          continue;
        }

        if (gapMs > HANGOVER_MS) {
          emit(ev.source, u);
          s.utterance = null;
          off -= FRAME; // re-process this frame as a possible new onset
          s.nextT = t;
          continue;
        }
        u.frames.push(frame.slice());
        if (voiced) {
          u.voicedMs += 20;
          u.lastVoiceT = t;
        }
        const ended = t - u.lastVoiceT >= HANGOVER_MS;
        const tooLong = t + 20 - u.startT >= MAX_MS;
        if (ended || tooLong) {
          emit(ev.source, u);
          s.utterance = null;
          if (tooLong && !ended) s.utterance = { startT: t + 20, frames: [], voicedMs: 0, lastVoiceT: t + 20 }; // keep going
        }
      }
    },
  };
}

function dbfs(frame: Int16Array): number {
  let sum = 0;
  for (const v of frame) sum += v * v;
  const rms = Math.sqrt(sum / Math.max(1, frame.length));
  return rms > 0 ? 20 * Math.log10(rms / 32768) : -Infinity;
}

function concat(frames: Int16Array[]): Int16Array {
  const out = new Int16Array(frames.reduce((n, f) => n + f.length, 0));
  let o = 0;
  for (const f of frames) {
    out.set(f, o);
    o += f.length;
  }
  return out;
}
