import OpusScript from "opusscript";
import {
  RTCPeerConnection,
  useAudioLevelIndication,
  useOPUS,
  useSdesMid,
  useVP8,
  type MediaStreamTrack,
  type RtpPacket,
} from "werift";
import type { PublishInput } from "../core/pipeline.ts";
import type { EmitOptions, Meeting } from "../core/types.ts";
import type { ServerMsg, Signaling } from "../signaling.ts";

// The Scribe: a hidden recorder that joins each meeting through the same
// signaling protocol as a browser (role "recorder"), over an in-process
// transport. Moving it to its own process later only swaps the transport.
//
// Each participant opens one sendonly PeerConnection to the Scribe carrying
// only their mic (+ screen while sharing). Identity is therefore structural:
// every packet on that connection belongs to that participant.
//
// Clients always offer, the Scribe always answers: no glare by construction.
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

interface Participant {
  id: string;
  pc: RTCPeerConnection;
  claimsScreen: boolean; // client meta says it is sharing
  screenFlowing: boolean; // we are receiving screen RTP
  sharing: boolean; // emitted state = claim ∧ media
  pendingCandidates: unknown[] | null; // held until our answer is out; null once sent
}

export class Scribe {
  #signaling: Signaling;
  #publish: Publish;
  #sessions = new Map<string, Session>();

  constructor(signaling: Signaling, publish: Publish) {
    this.#signaling = signaling;
    this.#publish = publish;
  }

  // Idempotent. Called whenever a participant joins, so a restarted server
  // rejoins meetings that are already running.
  ensure(meetingId: string): void {
    if (this.#sessions.has(meetingId)) return;
    const session = new Session(meetingId, this.#signaling, this.#publish, () => this.#sessions.delete(meetingId));
    this.#sessions.set(meetingId, session);
  }

  close(): void {
    for (const s of this.#sessions.values()) s.close();
  }
}

class Session {
  #meetingId: string;
  #meeting: Meeting | null = null;
  #publish: Publish;
  #send: (msg: unknown) => void;
  #leave: () => void;
  #participants = new Map<string, Participant>();
  #closed = false;
  #onClosed: () => void;

  constructor(meetingId: string, signaling: Signaling, publish: Publish, onClosed: () => void) {
    this.#meetingId = meetingId;
    this.#publish = publish;
    this.#onClosed = onClosed;
    const handlers = signaling.connect({
      send: (raw) => this.#onServer(JSON.parse(raw) as ServerMsg),
      close: () => this.close(), // meeting ended
    });
    this.#send = (msg) => handlers.onMessage(JSON.stringify(msg));
    this.#leave = () => handlers.onClose();
    this.#send({ type: "join", meetingId, name: "Scribe", role: "recorder" });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const p of this.#participants.values()) this.#drop(p);
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
    switch (msg.type) {
      case "welcome":
        this.#meeting = msg.meeting;
        this.#emit("scribe.online", "scribe", {});
        break;
      case "peer-left": {
        const p = this.#participants.get(msg.id);
        if (p) this.#drop(p);
        break;
      }
      case "signal":
        this.#onSignal(msg.from, msg.data as SignalData).catch((err) => console.error("[scribe]", err));
        break;
    }
  }

  async #onSignal(from: string, data: SignalData): Promise<void> {
    const p = this.#participants.get(from) ?? this.#connect(from);
    if (data.meta) {
      p.claimsScreen = !!data.meta.screen;
      this.#syncShare(p);
    } else if (data.description?.type === "offer") {
      await p.pc.setRemoteDescription(data.description);
      await p.pc.setLocalDescription(await p.pc.createAnswer());
      this.#signal(from, { description: p.pc.localDescription });
      // werift gathers during setLocalDescription; candidates sent before the
      // answer would hit a PC with no remote description and be rejected.
      for (const c of p.pendingCandidates ?? []) this.#signal(from, { candidate: c });
      p.pendingCandidates = null;
    } else if (data.candidate) {
      await p.pc.addIceCandidate(data.candidate);
    }
  }

  #signal(to: string, data: unknown): void {
    this.#send({ type: "signal", to, data });
  }

  #connect(id: string): Participant {
    const pc = new RTCPeerConnection({
      codecs: { audio: [useOPUS()], video: [useVP8()] },
      headerExtensions: { audio: [useSdesMid(), useAudioLevelIndication()], video: [useSdesMid()] },
    });
    const p: Participant = { id, pc, claimsScreen: false, screenFlowing: false, sharing: false, pendingCandidates: [] };
    this.#participants.set(id, p);
    pc.onIceCandidate.subscribe((c) => {
      if (!c) return;
      if (p.pendingCandidates) p.pendingCandidates.push(c.toJSON());
      else this.#signal(id, { candidate: c.toJSON() });
    });
    pc.onTrack.subscribe((track) => (track.kind === "audio" ? this.#onAudio(p, track) : this.#onScreen(p, track)));
    return p;
  }

  #onAudio(p: Participant, track: MediaStreamTrack): void {
    const decoder = new OpusScript(PCM_RATE, 1); // libopus resamples internally: decode straight to 16 kHz
    let anchor: { rtp: number; t: number } | null = null;

    track.onReceiveRtp.subscribe((rtp: RtpPacket, ext?: Record<string, unknown>) => {
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
      if (level) this.#emit("audio.level", p.id, { dbov: -level.level, voice: level.v } satisfies AudioLevel, t, false);

      let pcm: Buffer;
      try {
        pcm = decoder.decode(rtp.payload);
      } catch {
        return; // corrupt packet: drop; the gap stays silent
      }
      const samples = new Int16Array(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength));
      this.#emit("audio.pcm", p.id, { samples } satisfies AudioPcm, t, false);
    });
  }

  // Frames are decoded in phase 6. Here only "is media actually flowing".
  #onScreen(p: Participant, track: MediaStreamTrack): void {
    track.onReceiveRtp.subscribe(() => {
      if (p.screenFlowing) return;
      p.screenFlowing = true;
      this.#syncShare(p);
    });
  }

  // Share starts when the client says so AND screen RTP arrives (a claim with
  // no media is not a share). It stops when the claim is withdrawn: RTP can
  // legitimately pause on a static screen, and straggler packets after stop
  // must not restart it.
  #syncShare(p: Participant): void {
    if (!p.claimsScreen) p.screenFlowing = false;
    const sharing = p.claimsScreen && p.screenFlowing;
    if (sharing === p.sharing) return;
    p.sharing = sharing;
    this.#emit(sharing ? "screen.share.start" : "screen.share.stop", p.id, { by: p.id } satisfies ShareState);
  }

  #drop(p: Participant): void {
    p.claimsScreen = false;
    this.#syncShare(p);
    p.pc.close().catch(() => {});
    this.#participants.delete(p.id);
  }
}

interface SignalData {
  meta?: { screen?: string | null };
  description?: { type: "offer" | "answer"; sdp: string };
  candidate?: Parameters<RTCPeerConnection["addIceCandidate"]>[0];
}

// Signed difference of two 32-bit RTP timestamps (handles wraparound).
function rtpDelta(a: number, b: number): number {
  const d = (a - b) >>> 0;
  return d > 0x7fffffff ? d - 0x1_0000_0000 : d;
}
