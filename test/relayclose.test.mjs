// A connection that stays open must not hold the stop of the relay.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as wait } from "node:timers/promises";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "openmsg-close-"));
const RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "openmsg-close-relay-"));
process.env.OPENMSG_HOME = HOME;
process.env.OPENMSG_RELAY_HOME = RELAY_HOME;
after(() => {
  for (const dir of [HOME, RELAY_HOME]) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

const relay = await import("../src/relay.mjs");
const relaylink = await import("../src/relaylink.mjs");
const identity = await import("../src/identity.mjs");

// A stop that waits must fail the test, and it must not hold the test run.
function stops(t, running) {
  const seen = new Set();
  running.server.on("connection", (socket) => seen.add(socket));
  t.after(() => {
    for (const socket of seen) socket.destroy();
  });
  return () => Promise.race([running.close().then(() => true), wait(5000, false, { ref: false })]);
}

test("a stop of the relay does not wait for an open connection", async (t) => {
  identity.create({ label: "alice" });
  const running = await relay.serve({ port: 0, host: "127.0.0.1" });
  const stop = stops(t, running);
  const link = await relaylink.open(running.url);
  assert.equal(link.welcome.type, "welcome");
  assert.equal(await stop(), true);
});

test("a stop of the relay does not wait for a client that stays silent", async (t) => {
  const running = await relay.serve({ port: 0, host: "127.0.0.1" });
  const stop = stops(t, running);
  const silent = net.connect(running.port, "127.0.0.1");
  silent.on("error", () => {});
  await new Promise((resolve) => silent.once("connect", resolve));
  await wait(50);
  assert.equal(await stop(), true);
});
