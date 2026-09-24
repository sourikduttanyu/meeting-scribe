// NATS-style subject matching, so moving the bus to NATS later is a 1:1 swap.
//   "*" matches exactly one segment:  "screen.*"  ~ "screen.frame"
//   ">" matches one or more trailing: "audio.>"   ~ "audio.pcm", "audio.vad.start"
export function matchTopic(pattern: string, topic: string): boolean {
  const p = pattern.split(".");
  const t = topic.split(".");
  for (let i = 0; i < p.length; i++) {
    if (p[i] === ">") return t.length > i;
    if (i >= t.length) return false;
    if (p[i] !== "*" && p[i] !== t[i]) return false;
  }
  return p.length === t.length;
}
