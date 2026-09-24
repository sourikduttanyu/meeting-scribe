import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

export const SAMPLE_RATE = 16_000;
const WAV_HEADER_BYTES = 44; // guaranteed by -fflags +bitexact -map_metadata -1

export interface RenderedLine {
  path: string;
  durationMs: number;
  cached: boolean;
}

// Renders speech with macOS `say`, converted to the pipeline's native format
// (16 kHz mono PCM16 WAV). Cached by hash(voice, text) so scenarios render once.
export function renderSpeech(voice: string, text: string, cacheDir = "data/tts"): RenderedLine {
  const key = createHash("sha1").update(`${voice}\n${text}`).digest("hex").slice(0, 16);
  const path = join(cacheDir, `${key}.wav`);
  const cached = existsSync(path);
  if (!cached) {
    mkdirSync(cacheDir, { recursive: true });
    const aiff = `${path}.aiff`;
    execFileSync("say", ["-v", voice, "-o", aiff, text]);
    execFileSync("ffmpeg", [
      "-y", "-loglevel", "error", "-i", aiff,
      "-ar", String(SAMPLE_RATE), "-ac", "1", "-c:a", "pcm_s16le",
      "-fflags", "+bitexact", "-map_metadata", "-1", path,
    ]);
    unlinkSync(aiff);
  }
  const bytes = statSync(path).size - WAV_HEADER_BYTES;
  return { path, durationMs: Math.round((bytes / 2 / SAMPLE_RATE) * 1000), cached };
}
