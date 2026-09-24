import type { Plugin, PluginContext } from "../core/types.ts";
import type { ServerMsg } from "../signaling.ts";
import type { TranscriptFinal } from "../testing/l0-bot.ts";

// Output adapter: transcript.final → every participant's Live tab, with the
// speaker's display name resolved from the log (they may have left since).
export function liveCaptions(broadcast: (meetingId: string, msg: ServerMsg) => void): Plugin {
  return {
    name: "live-captions",
    subscribes: ["transcript.final"],
    async handle(ev, ctx) {
      const { speaker, text, endT } = ev.data as TranscriptFinal;
      broadcast(ev.meetingId, { type: "caption", t: ev.t, endT, speaker, name: speakerName(ctx, speaker), text });
    },
  };
}

export function speakerName(ctx: Pick<PluginContext, "query">, id: string): string {
  const join = ctx.query({ topic: "presence.join" }).findLast((e) => e.source === id);
  return (join?.data as { name?: string } | undefined)?.name ?? id;
}
