// Tests for an address that must not leave this machine. Two gateways on one
// machine hide these faults, because 127.0.0.1 reaches the other gateway there.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "openmsg-endpoint-"));
process.env.OPENMSG_HOME = HOME;
after(() => fs.rmSync(HOME, { recursive: true, force: true }));

const { shareableEndpoint, saveSettings } = await import("../src/settings.mjs");
const identity = await import("../src/identity.mjs");
const dirsync = await import("../src/dirsync.mjs");
const directory = await import("../src/directory.mjs");
const device = await import("../src/device.mjs");
const { canonicalBytes } = await import("../src/canonical.mjs");

identity.create({ label: "alice" });

test("a loopback address stays on this machine", () => {
  const here = ["127.0.0.1:7801", "127.1.2.3:7801", "localhost:7801", "localhost.:7801", "[::1]:7801", "0.0.0.0:7801", "[::ffff:7f00:1]:7801"];
  for (const host of here) assert.equal(shareableEndpoint(`http://${host}`), null, host);
});

test("a real name that starts like a loopback address goes out", () => {
  assert.equal(shareableEndpoint("https://127.example.com"), "https://127.example.com");
});

test("an address that other machines reach goes out", () => {
  assert.equal(shareableEndpoint("http://192.168.1.50:7801"), "http://192.168.1.50:7801");
  assert.equal(shareableEndpoint("https://gw.example.com"), "https://gw.example.com");
});

test("no address, and a broken address, give nothing", () => {
  assert.equal(shareableEndpoint(null), null);
  assert.equal(shareableEndpoint(undefined), null);
  assert.equal(shareableEndpoint("not a url"), null);
});

test("the record on the relay does not carry a loopback address", () => {
  saveSettings({ endpoint: "http://127.0.0.1:7801" });
  assert.equal(dirsync.selfRecord("p_1").endpoint, null);
});

test("a record of an older version cannot put a loopback address in the directory", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "openmsg-endpoint-peer-"));
  const project = "p_older";
  const me = identity.load();
  const peer = (() => {
    process.env.OPENMSG_HOME = home;
    try {
      const made = identity.create({ label: "bob" });
      saveSettings({ endpoint: "http://192.168.1.50:7801" });
      return { made, record: dirsync.selfRecord(project) };
    } finally {
      process.env.OPENMSG_HOME = HOME;
    }
  })();
  directory.put({ id: project, label: "older" }, me, { source: "self" });
  directory.put({ id: project, label: "older" }, peer.made, { source: "invite", endpoint: "http://192.0.2.1:1" });
  assert.deepEqual(dirsync.apply(project, [peer.record]).updated, [{ owner: peer.made.ownerId, endpoint: "http://192.168.1.50:7801" }]);
  // This version signs no loopback address, so the test signs one as 0.4 did.
  process.env.OPENMSG_HOME = home;
  let old;
  try {
    const { signature, ...body } = peer.record;
    const signer = device.signer({ project });
    const full = { ...body, endpoint: "http://127.0.0.1:7812" };
    old = { ...full, signature: { ...signature, value: signer.sign(canonicalBytes(full)).toString("base64url") } };
  } finally {
    process.env.OPENMSG_HOME = HOME;
  }
  const applied = dirsync.apply(project, [old]);
  assert.deepEqual(applied.refused, [], "the signature holds");
  assert.deepEqual(applied.updated, []);
  assert.equal(directory.member(project, peer.made.ownerId).endpoint, "http://192.168.1.50:7801");
  fs.rmSync(home, { recursive: true, force: true });
});

test("the record on the relay carries a reachable address", () => {
  saveSettings({ endpoint: "http://192.168.1.50:7801" });
  assert.equal(dirsync.selfRecord("p_1").endpoint, "http://192.168.1.50:7801");
});
