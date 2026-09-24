// Monologues for L3 bots: a person talking about something, with the pauses a
// real speaker has. Pauses are `say` silence commands, so they are true
// silence in the WAV — what VAD (phase 4) must split on — and the content is
// specific enough to ask about later ("what did bot-1 say about netcode?").

export interface Talk {
  topic: string;
  voice: string;
  lines: string[];
}

export const TALKS: Talk[] = [
  {
    topic: "game dev",
    voice: "Daniel",
    lines: [
      "So I've been rewriting the physics loop in our game this week.",
      "The old version stepped the simulation once per rendered frame, which meant the game ran faster on a 144 hertz monitor.",
      "The fix is a fixed timestep. You accumulate real time, and step physics in exact sixteen millisecond chunks.",
      "Then the renderer interpolates between the last two physics states, so it still looks smooth.",
      "The other thing is netcode. For a fighting game you want rollback, not delay based.",
      "Each client predicts the other player's input, and when the real input arrives late, you rewind a few frames and re-simulate.",
      "That only works if the simulation is fully deterministic. So no floating point surprises, and no random numbers without a shared seed.",
      "Anyway, that's where I am. Rollback is working locally, next is testing it over a real network.",
    ],
  },
  {
    topic: "databases",
    voice: "Samantha",
    lines: [
      "Quick update on the storage work.",
      "We compared a B-tree engine against an LSM tree for the event log.",
      "LSM wins on writes, because everything is an append to a memtable, then flushed as sorted files.",
      "The cost shows up on reads, since a lookup may check several levels, so bloom filters matter a lot.",
      "For our workload, which is almost all appends and range scans by time, the LSM tree is the better fit.",
      "The open question is compaction. If it falls behind, write latency spikes, so we want an alert on pending compaction bytes.",
      "I'll write up the numbers and share them before Friday.",
    ],
  },
  {
    topic: "networking",
    voice: "Rishi",
    lines: [
      "Let me talk about why video calls use UDP.",
      "With TCP, one lost packet blocks everything behind it until it is retransmitted. That's head of line blocking.",
      "For live audio, a late packet is useless. It's better to skip it and let the codec conceal the gap.",
      "So WebRTC sends RTP over UDP, with a jitter buffer on the receiver to smooth out arrival times.",
      "QUIC is interesting here, because it runs over UDP but gives you independent streams, so one loss doesn't stall the others.",
      "My guess is we'll see more media moving to QUIC in the next few years.",
    ],
  },
  {
    topic: "rendering",
    voice: "Karen",
    lines: [
      "I spent today on the lighting pass.",
      "We switched from forward to deferred shading, because the scene has hundreds of small lights.",
      "The geometry pass writes normals, albedo and depth into a G-buffer, and lighting runs once per pixel instead of once per object per light.",
      "The downside is transparency. Glass and particles don't fit in a G-buffer, so they still go through a forward pass at the end.",
      "Memory bandwidth is the real limit now. At 4K the G-buffer alone is over a hundred megabytes per frame.",
      "Next step is packing the normals tighter to cut that down.",
    ],
  },
];

// Pause after each line: mostly short, sometimes a longer "thinking" gap.
// Deterministic per line index so the rendered WAV (and its cache key) is stable.
const PAUSES_MS = [900, 1600, 700, 2800, 1200, 5000, 1000];

export function talkScript(talk: Talk): string {
  return talk.lines.map((line, i) => `${line} [[slnc ${PAUSES_MS[i % PAUSES_MS.length]}]]`).join(" ");
}
