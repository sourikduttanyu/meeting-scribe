import {
  MediaStreamTrack,
  RTCPeerConnection,
  useAudioLevelIndication,
  useOPUS,
  useSdesMid,
  useVP8,
  type RTCRtpTransceiver,
} from "werift";
import type { Publication, Router, RouterEvent, Source, Subscription, TrackInfo } from "./router.ts";

// Per-participant WebRTC edge of the SFU. Two PeerConnections per client:
//   pub — client offers, we answer. Client says which mid is mic/camera/screen.
//   sub — we offer, client answers. One sendonly transceiver per remote track.
// One offerer per connection → glare is impossible.
//
// Protocol (inside signaling's { type: "media", data }):
//   client → server  { op: "publish", sdp, sources: { [mid]: Source } }   (offer; sources = what is sending now)
//                    { op: "subscribe-answer", sdp }
//                    { op: "candidate", pc: "pub" | "sub", candidate }
//                    { op: "state", mic, cam }
//   server → client  { op: "publish-answer", sdp }
//                    { op: "subscribe-offer", sdp, tracks: { [mid]: { id, owner, source } } }
//                    { op: "candidate", pc: "pub" | "sub", candidate }
//                    { op: "peer-state", id, mic, cam }

export interface MediaPeer {
  id: string;
  meetingId: string;
  send(data: unknown): void;
}

type ClientOp =
  | { op: "publish"; sdp: string; sources: Record<string, Source> }
  | { op: "subscribe-answer"; sdp: string }
  | { op: "candidate"; pc: "pub" | "sub"; candidate: Parameters<RTCPeerConnection["addIceCandidate"]>[0] }
  | { op: "state"; mic: boolean; cam: boolean };

const CONFIG = {
  bundlePolicy: "max-bundle" as const, // one ICE transport per PC from the first offer (else werift opens one per m-line and leaks the extras)
  iceServers: [], // werift defaults to Google STUN; the server advertises host candidates only (public IP in prod)
  // Fixed on both PCs → same codec both ways. No congestion feedback to
  // publishers yet (see PLAN 3.5 critique): enabling werift's transport-cc
  // broke forwarding, so encoders stay near their start bitrate.
  codecs: { audio: [useOPUS()], video: [useVP8()] },
  headerExtensions: { audio: [useSdesMid(), useAudioLevelIndication()], video: [useSdesMid()] },
};

export class Sfu {
  #router: Router;
  #clients = new Map<string, Client>();

  constructor(router: Router) {
    this.#router = router;
  }

  join(peer: MediaPeer): void {
    const client = new Client(peer, this.#router);
    this.#clients.set(peer.id, client);
    for (const other of this.#room(peer.meetingId)) {
      if (other === client) continue;
      peer.send({ op: "peer-state", id: other.peer.id, ...other.state });
    }
  }

  message(id: string, data: unknown): void {
    const client = this.#clients.get(id);
    if (!client) return;
    const msg = data as ClientOp;
    if (msg.op === "state") {
      client.state = { mic: !!msg.mic, cam: !!msg.cam };
      for (const other of this.#room(client.peer.meetingId)) {
        if (other !== client) other.peer.send({ op: "peer-state", id, ...client.state });
      }
      return;
    }
    client.handle(msg).catch((err) => console.error("[sfu]", err));
  }

  leave(id: string): void {
    this.#clients.get(id)?.close();
    this.#clients.delete(id);
  }

  close(): void {
    for (const id of [...this.#clients.keys()]) this.leave(id);
  }

  #room(meetingId: string): Client[] {
    return [...this.#clients.values()].filter((c) => c.peer.meetingId === meetingId);
  }
}

class Client {
  peer: MediaPeer;
  state = { mic: true, cam: true };
  #router: Router;
  #pub = new RTCPeerConnection(CONFIG);
  #sub = new RTCPeerConnection(CONFIG);
  #sources: Record<string, Source> = {}; // mid → source, as last declared by the client
  #publications = new Map<string, Publication>(); // by pub mid
  #incoming = new Map<string, { track: MediaStreamTrack; transceiver: RTCRtpTransceiver }>(); // by pub mid
  #outgoing = new Map<string, { transceiver: RTCRtpTransceiver; sub: Subscription; info: TrackInfo }>(); // by track id
  #pending = { pub: [] as unknown[] | null, sub: [] as unknown[] | null }; // candidates held until our SDP is out
  #seen = new Set<RTCRtpTransceiver>(); // every transceiver ever created, for close()
  #negotiating = false;
  #dirty = false;
  #closed = false;
  #unlisten: () => void;

  constructor(peer: MediaPeer, router: Router) {
    this.peer = peer;
    this.#router = router;
    for (const kind of ["pub", "sub"] as const) {
      const pc = kind === "pub" ? this.#pub : this.#sub;
      pc.onIceCandidate.subscribe((c) => {
        if (!c) return;
        const pending = this.#pending[kind];
        if (pending) pending.push(c.toJSON());
        else this.peer.send({ op: "candidate", pc: kind, candidate: c.toJSON() });
      });
    }
    this.#pub.ontrack = ({ track, transceiver }) => {
      this.#incoming.set(transceiver.mid!, { track, transceiver });
      this.#seen.add(transceiver);
      // One RTP subscription per incoming track, for its whole life; it feeds
      // whichever publication currently owns that mid (re-shares reuse it).
      track.onReceiveRtp.subscribe((rtp, ext) => this.#publications.get(transceiver.mid!)?.push(rtp, ext));
      this.#syncPublications();
    };

    this.#unlisten = router.on((ev) => this.#onRouter(ev));
    for (const info of router.tracks(peer.meetingId)) this.#addOutgoing(info);
    this.#negotiate();
  }

  async handle(msg: Exclude<ClientOp, { op: "state" }>): Promise<void> {
    if (msg.op === "publish") {
      this.#sources = msg.sources;
      await this.#pub.setRemoteDescription({ type: "offer", sdp: msg.sdp });
      await this.#pub.setLocalDescription(await this.#pub.createAnswer());
      this.peer.send({ op: "publish-answer", sdp: this.#pub.localDescription!.sdp });
      this.#flush("pub");
      this.#syncPublications();
    } else if (msg.op === "subscribe-answer") {
      await this.#sub.setRemoteDescription({ type: "answer", sdp: msg.sdp });
      this.#negotiating = false;
      if (this.#dirty) this.#negotiate();
    } else if (msg.op === "candidate") {
      await (msg.pc === "pub" ? this.#pub : this.#sub).addIceCandidate(msg.candidate);
    }
  }

  close(): void {
    this.#closed = true;
    this.#unlisten();
    for (const p of this.#publications.values()) p.close();
    for (const o of this.#outgoing.values()) o.sub.close();
    // werift bug workaround: a rejected m-line's transceiver is flagged
    // `stopped` without stopping its receiver, and when the m-line is recycled
    // it drops out of getTransceivers(); pc.close() never reaches it and its
    // RTCP loop keeps the process alive forever. So we stop every transceiver
    // we have ever seen ourselves.
    for (const t of this.#seen) {
      t.receiver.stop();
      t.sender.stop();
    }
    this.#pub.close().catch((e) => console.error("[sfu] pub close", e));
    this.#sub.close().catch((e) => console.error("[sfu] sub close", e));
  }

  // Publications follow the client's declared sources: a mid that stops being
  // declared (share stopped) is unpublished; a declared mid with media is published.
  #syncPublications(): void {
    for (const [mid, pub] of this.#publications) {
      if (this.#sources[mid] !== pub.info.source) {
        pub.close();
        this.#publications.delete(mid);
      }
    }
    for (const [mid, source] of Object.entries(this.#sources)) {
      const incoming = this.#incoming.get(mid);
      if (!incoming || this.#publications.has(mid)) continue;
      const { track, transceiver } = incoming;
      this.#publications.set(
        mid,
        this.#router.publish(
          { meetingId: this.peer.meetingId, owner: this.peer.id, source, kind: track.kind as "audio" | "video" },
          () => void transceiver.receiver.sendRtcpPLI(track.ssrc!),
        ),
      );
    }
  }

  #onRouter(ev: RouterEvent): void {
    if (ev.track.meetingId !== this.peer.meetingId) return;
    if (ev.type === "published") this.#addOutgoing(ev.track);
    else this.#removeOutgoing(ev.track.id);
    this.#negotiate();
  }

  #addOutgoing(info: TrackInfo): void {
    if (info.owner === this.peer.id || this.#outgoing.has(info.id)) return;
    const local = new MediaStreamTrack({ kind: info.kind });
    const transceiver = this.#sub.addTransceiver(local, { direction: "sendonly" });
    this.#seen.add(transceiver);
    const sub = this.#router.subscribe(info.id, { write: (rtp) => local.writeRtp(rtp) });
    if (!sub) return;
    transceiver.sender.onPictureLossIndication.subscribe(() => sub.requestKeyframe());
    this.#outgoing.set(info.id, { transceiver, sub, info });
  }

  #removeOutgoing(trackId: string): void {
    const out = this.#outgoing.get(trackId);
    if (!out) return;
    out.sub.close();
    out.transceiver.setDirection("inactive");
    this.#outgoing.delete(trackId);
  }

  // Server-driven offers, strictly one at a time: changes that land while an
  // offer is outstanding set #dirty and go out after the answer.
  #negotiate(): void {
    if (this.#negotiating) {
      this.#dirty = true;
      return;
    }
    if (this.#sub.getTransceivers().length === 0) return; // nothing to offer yet
    this.#negotiating = true;
    this.#dirty = false;
    (async () => {
      await this.#sub.setLocalDescription(await this.#sub.createOffer());
      const tracks: Record<string, { id: string; owner: string; source: Source }> = {};
      for (const { transceiver, info } of this.#outgoing.values()) {
        tracks[transceiver.mid!] = { id: info.id, owner: info.owner, source: info.source };
      }
      this.peer.send({ op: "subscribe-offer", sdp: this.#sub.localDescription!.sdp, tracks });
      this.#flush("sub");
    })().catch((err) => {
      this.#negotiating = false;
      if (!this.#closed) console.error("[sfu] negotiate", err); // closing mid-offer is expected
    });
  }

  #flush(kind: "pub" | "sub"): void {
    for (const candidate of this.#pending[kind] ?? []) this.peer.send({ op: "candidate", pc: kind, candidate });
    this.#pending[kind] = null;
  }
}
