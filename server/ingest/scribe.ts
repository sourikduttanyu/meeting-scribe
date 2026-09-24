import OpusScript from "opusscript";
import type { RtpPacket } from "werift";
import type { PublishInput } from "../core/pipeline.ts";
import type { EmitOptions, Meeting } from "../core/types.ts";
import type { ServerMsg, Signaling } from "../signaling.ts";
import type { Router, RouterEvent, Subscription, TrackInfo } from "../sfu/router.ts";

// The Scribe: a hidden recorder for each meeting.
//
// Media: an in-process subscriber of the SFU router. No PeerConnection, no
// extra upload from clients. Every track in the router is labelled with its
// owner (participantId from signaling), so attribution is structural: no
// diarization.
//
// Presence: it still joins signaling as role "recorder" (in-process
// transport), so clients show the consent indicator exactly when it is there.
//
// Emits (source = participantId unless noted):
//   audio.pcm         { samples: Int16Array }  16 kHz mono, 20 ms, non-durable
//   audio.level       { dbov, voice }           per packet, non-durable (RFC 6464)
//   screen.share.start / .stop { by }          durable
//   scribe.online / scribe.offline {}           durable, source "scribe"

export const PCM_RATE = 16_000;
const RTP_CLOCK = 48_000; // Opus RTP clock is always 48 kHz
const REANCHOR_MS = 500; // sender clock vs our clock drifted this far → re-anchor
const LEVEL_URI = "urn:ietf:params:rtp-hdrext:ssrc-audio-level";

export interface AudioPcm {
  samples: Int16Array;
}
export interface AudioLevel {
  dbov: number; // 0 = loudest, -127 = silence
  voice: boolean; // sender-side VAD bit, if set
}
export interface ShareState {
  by: string;
}

type Publish = (input: PublishInput, opts?: EmitOptions) => unknown;

export class Scribe {
  #signaling: Signaling;
  #router: Router;
  #publish: Publish;
  #sessions = new Map<string, Session>();

  constructor(signaling: Signaling, router: Router, publish: Publish) {
    this.#signaling = signaling;
    this.#router = router;
    this.#publish = publish;
  }

  // Idempotent. Called whenever a participant joins, so a restarted server
  // rejoins meetings that are already running.
  ensure(meetingId: string): void {
    if (this.#sessions.has(meetingId)) return;
    const session = new Session(meetingId, this.#signaling, this.#router, this.#publish, () => this.#sessions.delete(meetingId));
    this.#sessions.set(meetingId, session);
  }

  close(): void {
    for (const s of this.#sessions.values()) s.close();
  }
}

class Session {
  #meetingId: string;
  #meeting: Meeting | null = null;
  #router: Router;
  #publish: Publish;
  #leave: () => void;
  #subs = new Map<string, Subscription>(); // by track id
  #sharing = new Map<string, string>(); // screen track id → owner, once media is seen
  #unlisten: (() => void) | null = null;
  #closed = false;
  #onClosed: () => void;

  constructor(meetingId: string, signaling: Signaling, router: Router, publish: Publish, onClosed: () => void) {
    this.#meetingId = meetingId;
    this.#router = router;
    this.#publish = publish;
    this.#onClosed = onClosed;
    const handlers = signaling.connect({
      send: (raw) => this.#onServer(JSON.parse(raw) as ServerMsg),
      close: () => this.close(), // meeting ended
    });
    this.#leave = () => handlers.onClose();
    handlers.onMessage(JSON.stringify({ type: "join", meetingId, name: "Scribe", role: "recorder" }));
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#unlisten?.();
    for (const id of [...this.#subs.keys()]) this.#unsubscribe(id);
    this.#emit("scribe.offline", "scribe", {});
    this.#leave();
    this.#onClosed();
  }

  // ms since meeting start, from our wall clock. The ingest edge is the only
  // place wall clock becomes event time.
  #now(): number {
    return Date.now() - this.#meeting!.startedAt!;
  }

  #emit(topic: string, source: string, data: unknown, t = this.#now(), durable = true): void {
    if (!this.#meeting?.startedAt) return;
    this.#publish({ meetingId: this.#meetingId, topic, t, source, data }, { durable });
  }

  #onServer(msg: ServerMsg): void {
    if (msg.type !== "welcome" || this.#unlisten) return;
    this.#meeting = msg.meeting;
    this.#emit("scribe.online", "scribe", {});
    this.#unlisten = this.#router.on((ev) => this.#onRouter(ev));
    for (const track of this.#router.tracks(this.#meetingId)) this.#subscribe(track);
  }

  #onRouter(ev: RouterEvent): void {
    if (ev.track.meetingId !== this.#meetingId) return;
    if (ev.type === "published") this.#subscribe(ev.track);
    else this.#unsubscribe(ev.track.id);
  }

  #subscribe(track: TrackInfo): void {
    if (track.source === "camera") return; // faces add little to "what happened"; not worth decoding
    const sink = track.source === "mic" ? this.#audioSink(track.owner) : this.#screenSink(track);
    const sub = this.#router.subscribe(track.id, sink);
    if (sub) this.#subs.set(track.id, sub);
  }

  #unsubscribe(trackId: string): void {
    this.#subs.get(trackId)?.close();
    this.#subs.delete(trackId);
    const owner = this.#sharing.get(trackId);
    if (owner !== undefined) {
      this.#sharing.delete(trackId);
      this.#emit("screen.share.stop", owner, { by: owner } satisfies ShareState);
    }
  }

  #audioSink(owner: string) {
    const decoder = new OpusScript(PCM_RATE, 1); // libopus resamples internally: decode straight to 16 kHz
    let anchor: { rtp: number; t: number } | null = null;

    return {
      write: (rtp: RtpPacket, ext?: Record<string, unknown>) => {
        if (!this.#meeting?.startedAt || rtp.payload.length === 0) return;
        // Capture time from the RTP timestamp, not arrival: jitter and bursts
        // don't smear the timeline. Anchored to our clock on the first packet.
        const arrival = this.#now();
        let t = anchor ? anchor.t + rtpDelta(rtp.header.timestamp, anchor.rtp) / (RTP_CLOCK / 1000) : arrival;
        if (!anchor || Math.abs(t - arrival) > REANCHOR_MS) {
          anchor = { rtp: rtp.header.timestamp, t: arrival };
          t = arrival;
        }
        t = Math.round(t);

        const level = ext?.[LEVEL_URI] as { v: boolean; level: number } | undefined;
        if (level) this.#emit("audio.level", owner, { dbov: -level.level, voice: level.v } satisfies AudioLevel, t, false);

        let pcm: Buffer;
        try {
          pcm = decoder.decode(rtp.payload);
        } catch {
          return; // corrupt packet: drop; the gap stays silent
        }
        const samples = new Int16Array(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength));
        this.#emit("audio.pcm", owner, { samples } satisfies AudioPcm, t, false);
      },
    };
  }

  // Frames are decoded in phase 6. Here: a share starts when screen media
  // actually arrives (not when it is announced) and stops when the track is
  // unpublished.
  #screenSink(track: TrackInfo) {
    return {
      write: () => {
        if (this.#sharing.has(track.id)) return;
        this.#sharing.set(track.id, track.owner);
        this.#emit("screen.share.start", track.owner, { by: track.owner } satisfies ShareState);
      },
    };
  }
}

// Signed difference of two 32-bit RTP timestamps (handles wraparound).
function rtpDelta(a: number, b: number): number {
  const d = (a - b) >>> 0;
  return d > 0x7fffffff ? d - 0x1_0000_0000 : d;
}
