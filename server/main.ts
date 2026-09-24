import { mkdirSync } from "node:fs";
import { startApp } from "./app.ts";
import { whisperCpp } from "./providers/stt/whisper-cpp.ts";

mkdirSync("data", { recursive: true });
const app = await startApp({
  port: Number(process.env.PORT ?? 3000),
  dbPath: "data/meetings.sqlite",
  dev: process.env.NODE_ENV === "development",
  recordWav: process.env.NODE_ENV === "development" ? "data/recordings" : undefined,
  stt: whisperCpp(process.env.WHISPER_URL), // needs whisper-server running (see CLAUDE.md)
});
console.log(`meeting-scribe on ${app.url}${process.env.NODE_ENV === "development" ? " (dev routes on)" : ""}`);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => void app.close().then(() => process.exit(0)));
}
