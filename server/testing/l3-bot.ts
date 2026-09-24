import { chromium, type Browser, type Page } from "playwright-core";
import { resolve } from "node:path";
import { renderSpeech } from "./tts.ts";

export interface L3Bot {
  name: string;
  page: Page;
  close(): Promise<void>;
}

export interface L3BotOptions {
  baseUrl: string;
  meetingId: string;
  name: string;
  voice?: string;
  say?: string; // looped as the bot's microphone
  headless?: boolean;
}

// L3 bot: a real Chrome joining through the real web UI. Chrome's fake-media
// flags turn a WAV into the microphone and a test pattern into the camera, so
// the browser's own encoder, getUserMedia and WebRTC stack are exercised.
// One browser per bot: the fake-audio file is a per-process flag.
export async function launchBot(opts: L3BotOptions): Promise<L3Bot> {
  const wav = renderSpeech(opts.voice ?? "Daniel", opts.say ?? `Hello, this is ${opts.name}, a test bot. One, two, three.`);
  const browser: Browser = await chromium.launch({
    channel: "chrome", // use installed Chrome; no bundled download
    headless: opts.headless ?? true,
    args: [
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      `--use-file-for-fake-audio-capture=${resolve(wav.path)}`,
      "--autoplay-policy=no-user-gesture-required",
    ],
  });
  const page = await browser.newPage();
  page.on("pageerror", (err) => console.error(`[${opts.name}] ${err.message}`));
  page.on("console", (msg) => msg.type() === "error" && console.error(`[${opts.name}] console: ${msg.text()}`));
  const q = new URLSearchParams({ m: opts.meetingId, name: opts.name, bot: "1" });
  await page.goto(`${opts.baseUrl}/room.html?${q}`);
  return { name: opts.name, page, close: () => browser.close() };
}

export interface MediaStats {
  peers: number;
  connected: number;
  audioBytesIn: number;
  videoBytesIn: number;
  states: string[]; // signaling/ice/connection per peer, for debugging
}

// Reads WebRTC stats from the page (window.__room exposed by room.js).
export function mediaStats(page: Page): Promise<MediaStats> {
  return page.evaluate(async () => {
    const room = (window as unknown as { __room: { peers: Map<string, { pc: RTCPeerConnection }> } }).__room;
    const out = { peers: 0, connected: 0, audioBytesIn: 0, videoBytesIn: 0, states: [] as string[] };
    for (const { pc } of room.peers.values()) {
      out.peers++;
      out.states.push(`${pc.signalingState}/${pc.iceGatheringState}/${pc.iceConnectionState}/${pc.connectionState} local=${pc.localDescription?.type ?? '-'} remote=${pc.remoteDescription?.type ?? '-'}`);
      if (pc.connectionState === "connected") out.connected++;
      for (const s of (await pc.getStats()).values()) {
        if (s.type !== "inbound-rtp") continue;
        if (s.kind === "audio") out.audioBytesIn += s.bytesReceived;
        if (s.kind === "video") out.videoBytesIn += s.bytesReceived;
      }
    }
    return out;
  });
}
