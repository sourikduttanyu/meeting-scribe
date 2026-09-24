import assert from "node:assert/strict";
import { test } from "node:test";
import { RtpHeader, RtpPacket } from "werift";
import { PLI_INTERVAL_MS, Router, type RouterEvent } from "./router.ts";

const packet = (seq: number) => new RtpPacket(new RtpHeader({ sequenceNumber: seq, ssrc: 1111, payloadType: 111 }), Buffer.from([seq]));

function collector() {
  const got: RtpPacket[] = [];
  return { got, sink: { write: (rtp: RtpPacket) => void got.push(rtp) } };
}

test("fans out to every sink, each with its own clone", () => {
  const r = new Router();
  const pub = r.publish({ meetingId: "m", owner: "a", source: "mic", kind: "audio" }, () => {});
  const x = collector();
  const y = collector();
  r.subscribe(pub.info.id, x.sink);
  r.subscribe(pub.info.id, y.sink);
  const original = packet(7);
  pub.push(original);

  assert.equal(x.got.length, 1);
  assert.equal(y.got.length, 1);
  // What werift's sender does to a forwarded packet:
  x.got[0]!.header.ssrc = 2222;
  x.got[0]!.header.sequenceNumber = 99;
  assert.equal(y.got[0]!.header.ssrc, 1111, "other subscriber unaffected");
  assert.equal(original.header.sequenceNumber, 7, "publisher's packet unaffected");
  assert.notEqual(x.got[0], y.got[0]);
});

test("unsubscribe stops delivery; unpublish notifies and drops sinks", () => {
  const r = new Router();
  const events: RouterEvent[] = [];
  r.on((ev) => events.push(ev));
  const pub = r.publish({ meetingId: "m", owner: "a", source: "screen", kind: "video" }, () => {});
  const x = collector();
  const sub = r.subscribe(pub.info.id, x.sink)!;
  pub.push(packet(1));
  sub.close();
  pub.push(packet(2));
  assert.equal(x.got.length, 1);

  assert.deepEqual(r.tracks("m").map((t) => t.source), ["screen"]);
  pub.close();
  pub.close(); // idempotent
  assert.deepEqual(events.map((e) => `${e.type}:${e.track.source}`), ["published:screen", "unpublished:screen"]);
  assert.deepEqual(r.tracks("m"), []);
  assert.equal(r.subscribe(pub.info.id, x.sink), null, "can't subscribe to a gone track");
});

test("video subscribe requests a keyframe; PLIs are coalesced per track", () => {
  let now = 0;
  const r = new Router(() => now);
  let plis = 0;
  const video = r.publish({ meetingId: "m", owner: "a", source: "camera", kind: "video" }, () => plis++);
  const audio = r.publish({ meetingId: "m", owner: "a", source: "mic", kind: "audio" }, () => assert.fail("no PLI for audio"));

  r.subscribe(audio.info.id, collector().sink);
  const s1 = r.subscribe(video.info.id, collector().sink)!;
  assert.equal(plis, 1, "first viewer triggers PLI");

  now = 100;
  r.subscribe(video.info.id, collector().sink); // join storm within the window
  s1.requestKeyframe();
  assert.equal(plis, 1, "coalesced");

  now = PLI_INTERVAL_MS;
  s1.requestKeyframe();
  assert.equal(plis, 2, "allowed again after the interval");
});

test("tracks are scoped per meeting", () => {
  const r = new Router();
  r.publish({ meetingId: "m1", owner: "a", source: "mic", kind: "audio" }, () => {});
  r.publish({ meetingId: "m2", owner: "b", source: "mic", kind: "audio" }, () => {});
  assert.deepEqual(r.tracks("m1").map((t) => t.owner), ["a"]);
});
