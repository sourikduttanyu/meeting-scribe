import type { RtpPacket } from "werift";

// SFU forwarding core. Knows nothing about PeerConnections: publishers push
// packets in, sinks (subscriber PCs, the Scribe) get packets out. That keeps
// it unit-testable and makes the transport swappable.
//
// Invariants:
// - Every sink gets its own clone of every packet. werift's RTCRtpSender
//   rewrites SSRC/PT/seq/extensions in place and keeps the object in its NACK
//   history, so a shared packet would be corrupted by the next subscriber.
// - Keyframe requests (PLI) toward a publisher are coalesced: at most one per
//   PLI_INTERVAL_MS per track, however many subscribers join or lose sync.

export type Source = "mic" | "camera" | "screen";
export const PLI_INTERVAL_MS = 500;

export interface TrackInfo {
  id: string;
  meetingId: string;
  owner: string; // participantId
  source: Source;
  kind: "audio" | "video";
}

export interface Sink {
  write(rtp: RtpPacket, ext?: Record<string, unknown>): void;
}

export interface Publication {
  info: TrackInfo;
  push(rtp: RtpPacket, ext?: Record<string, unknown>): void;
  close(): void;
}

export interface Subscription {
  requestKeyframe(): void;
  close(): void;
}

export type RouterEvent = { type: "published" | "unpublished"; track: TrackInfo };

interface Published {
  info: TrackInfo;
  sinks: Set<Sink>;
  requestKeyframe: () => void;
  lastPli: number;
}

export class Router {
  #tracks = new Map<string, Published>();
  #listeners = new Set<(ev: RouterEvent) => void>();
  #now: () => number;
  #seq = 0;

  constructor(now: () => number = () => performance.now()) {
    this.#now = now;
  }

  publish(info: Omit<TrackInfo, "id">, requestKeyframe: () => void): Publication {
    const track: Published = {
      info: { ...info, id: `${info.owner}:${info.source}:${++this.#seq}` },
      sinks: new Set(),
      requestKeyframe,
      lastPli: -Infinity,
    };
    this.#tracks.set(track.info.id, track);
    this.#notify({ type: "published", track: track.info });
    return {
      info: track.info,
      push: (rtp, ext) => {
        for (const sink of track.sinks) sink.write(rtp.clone(), ext);
      },
      close: () => {
        if (!this.#tracks.delete(track.info.id)) return;
        track.sinks.clear();
        this.#notify({ type: "unpublished", track: track.info });
      },
    };
  }

  subscribe(trackId: string, sink: Sink): Subscription | null {
    const track = this.#tracks.get(trackId);
    if (!track) return null;
    track.sinks.add(sink);
    if (track.info.kind === "video") this.#pli(track); // new viewer can't decode until the next keyframe
    return {
      requestKeyframe: () => this.#pli(track),
      close: () => void track.sinks.delete(sink),
    };
  }

  tracks(meetingId: string): TrackInfo[] {
    return [...this.#tracks.values()].filter((t) => t.info.meetingId === meetingId).map((t) => t.info);
  }

  on(listener: (ev: RouterEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #pli(track: Published): void {
    const now = this.#now();
    if (now - track.lastPli < PLI_INTERVAL_MS) return;
    track.lastPli = now;
    track.requestKeyframe();
  }

  #notify(ev: RouterEvent): void {
    for (const l of this.#listeners) l(ev);
  }
}
