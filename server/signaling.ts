import { randomUUID } from "node:crypto";
import type { Meeting } from "./core/types.ts";

// WebRTC signaling: rooms + message relay. Media never touches the server here.
//
// Roles:
//   participant — normal user or test bot; shown as a tile to others.
//   recorder    — the Scribe. Never listed in `peers` and never announced via
//                 peer-joined, but announced separately (`recorder`) so clients
//                 can send it media and show the "AI notes on" banner.

export type Role = "participant" | "recorder";

export interface PeerInfo {
  id: string;
  name: string;
  bot: boolean;
}

export type ClientMsg =
  | { type: "join"; meetingId: string; name: string; role?: Role; bot?: boolean }
  | { type: "signal"; to: string; data: unknown };

export type ServerMsg =
  | { type: "welcome"; selfId: string; meeting: Meeting; peers: PeerInfo[]; recorder: PeerInfo | null }
  | { type: "peer-joined"; peer: PeerInfo }
  | { type: "peer-left"; id: string }
  | { type: "recorder-joined"; peer: PeerInfo }
  | { type: "recorder-left"; id: string }
  | { type: "signal"; from: string; data: unknown }
  | { type: "ended" }
  | { type: "error"; message: string };

export interface Transport {
  send(data: string): void;
  close(): void;
}

interface Conn extends PeerInfo {
  role: Role;
  meeting: Meeting;
  transport: Transport;
}

export interface SignalingDeps {
  getMeeting(id: string): Meeting | undefined;
  startMeeting(id: string): Meeting; // first participant join starts the clock
  onPresence(meeting: Meeting, peer: PeerInfo, kind: "join" | "leave"): void;
}

export class Signaling {
  #deps: SignalingDeps;
  #rooms = new Map<string, Map<string, Conn>>();

  constructor(deps: SignalingDeps) {
    this.#deps = deps;
  }

  // Returns handlers the transport layer calls on message / close.
  connect(transport: Transport): { onMessage(raw: string): void; onClose(): void } {
    let conn: Conn | null = null;
    const send = (msg: ServerMsg) => transport.send(JSON.stringify(msg));

    return {
      onMessage: (raw) => {
        let msg: ClientMsg;
        try {
          msg = JSON.parse(raw) as ClientMsg;
        } catch {
          return send({ type: "error", message: "invalid json" });
        }
        if (msg.type === "join") {
          if (conn) return send({ type: "error", message: "already joined" });
          const meeting = this.#deps.getMeeting(msg.meetingId);
          if (!meeting) return send({ type: "error", message: "unknown meeting" });
          if (meeting.startedAt !== null && Date.now() > meeting.startedAt + meeting.durationMs) {
            return send({ type: "error", message: "meeting ended" });
          }
          conn = {
            id: randomUUID().slice(0, 8),
            name: String(msg.name || "guest").slice(0, 40),
            bot: msg.bot === true,
            role: msg.role === "recorder" ? "recorder" : "participant",
            meeting,
            transport,
          };
          this.#join(conn);
        } else if (msg.type === "signal") {
          if (!conn) return send({ type: "error", message: "join first" });
          const target = this.#rooms.get(conn.meeting.id)?.get(msg.to);
          if (!target) return send({ type: "error", message: "unknown peer" });
          target.transport.send(JSON.stringify({ type: "signal", from: conn.id, data: msg.data } satisfies ServerMsg));
        }
      },
      onClose: () => {
        if (conn) this.#leave(conn);
      },
    };
  }

  // Meeting hit its fixed duration: tell everyone, then disconnect.
  end(meetingId: string): void {
    const room = this.#rooms.get(meetingId);
    if (!room) return;
    for (const c of room.values()) {
      c.transport.send(JSON.stringify({ type: "ended" } satisfies ServerMsg));
      c.transport.close();
    }
  }

  #join(conn: Conn): void {
    const room = this.#rooms.get(conn.meeting.id) ?? new Map<string, Conn>();
    this.#rooms.set(conn.meeting.id, room);
    if (conn.role === "participant" && conn.meeting.startedAt === null) {
      const started = this.#deps.startMeeting(conn.meeting.id);
      conn.meeting = started;
      for (const c of room.values()) c.meeting = started; // e.g. a recorder that joined early
    }
    const others = [...room.values()];
    const recorder = others.find((c) => c.role === "recorder");
    room.set(conn.id, conn);

    const welcome: ServerMsg = {
      type: "welcome",
      selfId: conn.id,
      meeting: conn.meeting,
      peers: others.filter((c) => c.role === "participant").map(info),
      recorder: recorder ? info(recorder) : null,
    };
    conn.transport.send(JSON.stringify(welcome));

    const note: ServerMsg =
      conn.role === "recorder" ? { type: "recorder-joined", peer: info(conn) } : { type: "peer-joined", peer: info(conn) };
    for (const c of others) c.transport.send(JSON.stringify(note));
    if (conn.role === "participant") this.#deps.onPresence(conn.meeting, info(conn), "join");
  }

  #leave(conn: Conn): void {
    const room = this.#rooms.get(conn.meeting.id);
    if (!room?.delete(conn.id)) return;
    if (room.size === 0) this.#rooms.delete(conn.meeting.id);
    const note: ServerMsg = conn.role === "recorder" ? { type: "recorder-left", id: conn.id } : { type: "peer-left", id: conn.id };
    for (const c of room.values()) c.transport.send(JSON.stringify(note));
    if (conn.role === "participant") this.#deps.onPresence(conn.meeting, info(conn), "leave");
  }
}

function info(c: Conn): PeerInfo {
  return { id: c.id, name: c.name, bot: c.bot };
}
