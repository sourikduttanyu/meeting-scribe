import type { MeetingEvent } from "./types.ts";

// "What is happening right now" is not stored anywhere: it is a fold over the
// durable event log. The same function answers "who was sharing at 12:00?"
// by folding only the events up to that t.

export interface NowSnapshot {
  t: number;
  participants: { id: string; name: string; bot: boolean }[];
  sharing: { by: string } | null;
  speaking: string | null;
  scribeOnline: boolean;
}

export function foldNow(events: MeetingEvent[], t: number): NowSnapshot {
  const participants = new Map<string, { id: string; name: string; bot: boolean }>();
  const shares: string[] = []; // stack: most recent sharer wins, earlier resumes if it stops
  let speaking: string | null = null;
  let scribeOnline = false;

  for (const ev of events) {
    if (ev.t > t) break; // events are ordered by t
    const data = ev.data as Record<string, unknown>;
    switch (ev.topic) {
      case "presence.join":
        participants.set(ev.source, { id: ev.source, name: String(data.name), bot: data.bot === true });
        break;
      case "presence.leave":
        participants.delete(ev.source);
        if (speaking === ev.source) speaking = null;
        break;
      case "screen.share.start":
        shares.push(String(data.by));
        break;
      case "screen.share.stop": {
        const i = shares.lastIndexOf(String(data.by));
        if (i >= 0) shares.splice(i, 1);
        break;
      }
      case "speaker.active":
        speaking = (data.id as string | null) ?? null;
        break;
      case "scribe.online":
        scribeOnline = true;
        break;
      case "scribe.offline":
        scribeOnline = false;
        break;
    }
  }
  const by = shares.at(-1);
  return { t, participants: [...participants.values()], sharing: by ? { by } : null, speaking, scribeOnline };
}
