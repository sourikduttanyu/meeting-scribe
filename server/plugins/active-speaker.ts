import type { AudioLevel } from "../ingest/scribe.ts";
import type { Plugin } from "../core/types.ts";

// Dominant speaker from per-packet RTP audio levels (no decoding), the way
// SFUs pick who to spotlight. Pure event time: replaying the same levels
// gives the same switches.
//
//   smoothing  exponential average in dB; fast attack (50 ms) so a new
//              speaker registers quickly, slow release (300 ms) so a
//              syllable gap doesn't drop them
//   speech     smoothed level above SPEECH_DBOV
//   switch     a new loudest speaker must win continuously for HOLD_MS
//   silence    nobody above threshold for SILENCE_MS → speaker null
//              (longer than a between-sentence pause, so pauses don't flap)
//
// Emits speaker.active { id: string | null } only on change (durable).

export const SPEECH_DBOV = -50;
export const HOLD_MS = 500;
export const SILENCE_MS = 1500;
const ATTACK_MS = 50;
const RELEASE_MS = 300;

export interface SpeakerActive {
  id: string | null;
}

interface MeetingState {
  level: Map<string, { db: number; t: number }>;
  current: string | null;
  candidate: string | null;
  since: number; // when candidate started winning
}

export function activeSpeaker(): Plugin {
  const meetings = new Map<string, MeetingState>();

  return {
    name: "active-speaker",
    subscribes: ["audio.level"],
    queue: { max: 2000, drop: "oldest" }, // levels are a stream; stale ones are worthless
    async handle(ev, ctx) {
      const s = meetings.get(ev.meetingId) ?? { level: new Map(), current: null, candidate: null, since: ev.t };
      meetings.set(ev.meetingId, s);

      const { dbov } = ev.data as AudioLevel;
      const prev = s.level.get(ev.source);
      const tau = prev && dbov > prev.db ? ATTACK_MS : RELEASE_MS;
      const alpha = prev ? 1 - Math.exp(-Math.max(0, ev.t - prev.t) / tau) : 1;
      s.level.set(ev.source, { db: prev ? prev.db + alpha * (dbov - prev.db) : dbov, t: ev.t });

      let loudest: string | null = null;
      let best = SPEECH_DBOV;
      for (const [id, l] of s.level) {
        if (ev.t - l.t < 200 && l.db > best) { // ignore participants whose packets stopped
          best = l.db;
          loudest = id;
        }
      }

      if (loudest !== s.candidate) {
        s.candidate = loudest;
        s.since = ev.t;
      }
      const need = loudest === null ? SILENCE_MS : HOLD_MS;
      if (s.candidate !== s.current && ev.t - s.since >= need) {
        s.current = s.candidate;
        ctx.emit<SpeakerActive>("speaker.active", s.since, { id: s.current }); // t = when the change actually began
      }
    },
  };
}
