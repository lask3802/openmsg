// Tests for the path that lets a command in a Codex sandbox ask the gateway to
// run it. A small script stands in for the command line.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "openmsg-local-"));
process.env.OPENMSG_HOME = HOME;

const localrun = await import("../src/localrun.mjs");
const gateway = await import("../src/gateway.mjs");
const { saveSettings } = await import("../src/settings.mjs");

// It prints what it got, so a test can see each argument and the environment.
const CLI = path.join(HOME, "fake-cli.mjs");
const FAKE_CLI = `
  console.log(JSON.stringify({
    args: process.argv.slice(2),
    thread: process.env.CODEX_THREAD_ID,
    local: process.env.OPENMSG_LOCAL,
    self: process.env.OPENMSG_SELF ?? null,
    socket: process.env.CLAUDE_CODE_MESSAGING_SOCKET ?? null,
  }));
  process.exit(process.argv[2] === "ack" ? 3 : 0);
`;
fs.writeFileSync(CLI, FAKE_CLI);

const THREAD = "01a18cbd-49fa-7311-88fd-751a9f8e2665";
const running = await gateway.serve({ local: { cli: CLI } });
saveSettings({ port: running.port });
const key = localrun.ensureKey();
after(async () => {
  await running.close();
  fs.rmSync(HOME, { recursive: true, force: true });
});

function post(body, authorization = `Bearer ${key}`) {
  return fetch(`http://127.0.0.1:${running.port}${localrun.LOCAL_PATH}`, {
    method: "POST",
    headers: { authorization, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("a command runs when the key is right, and each argument stays one argument", async () => {
  const text = 'hello" & calc.exe & "';
  const res = await post({ args: ["send", "claude:a@b", text], thread: THREAD });
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.equal(out.code, 0);
  const seen = JSON.parse(out.stdout);
  assert.deepEqual(seen.args, ["send", "claude:a@b", text]);
  assert.equal(seen.thread, THREAD);
  assert.equal(seen.local, "1", "the command must not ask the gateway again");
});

test("the command gets no identity of the gateway process", async () => {
  process.env.OPENMSG_SELF = "claude:owner";
  process.env.CLAUDE_CODE_MESSAGING_SOCKET = "pipe";
  try {
    const out = await (await post({ args: ["send", "claude:x@bob", "y"], thread: THREAD })).json();
    const seen = JSON.parse(out.stdout);
    assert.equal(seen.self, null);
    assert.equal(seen.socket, null);
  } finally {
    delete process.env.OPENMSG_SELF;
    delete process.env.CLAUDE_CODE_MESSAGING_SOCKET;
  }
});

test("the exit code of the command comes back", async () => {
  const out = await (await post({ args: ["ack", "abc"], thread: THREAD })).json();
  assert.equal(out.code, 3);
});

test("a wrong key and no key are refused", async () => {
  assert.equal((await post({ args: ["send"], thread: THREAD }, "Bearer nope")).status, 401);
  assert.equal((await post({ args: ["send"], thread: THREAD }, "")).status, 401);
});

test("the gateway runs only send and ack", async () => {
  for (const command of ["accept", "permit", "publish", "invite", "id"]) {
    assert.equal((await post({ args: [command], thread: THREAD })).status, 403, command);
  }
});

test("the gateway sends only to a person, because it holds the tokens of the local sessions", async () => {
  for (const target of ["claude:local-session", "project:C:/work", "project:C:/a@b", "x"]) {
    assert.equal((await post({ args: ["send", target, "y"], thread: THREAD })).status, 403, target);
  }
  assert.equal((await post({ args: ["send", "--reply-to", "claude:a@b", "claude:local", "y"], thread: THREAD })).status, 403);
  assert.equal((await post({ args: ["send"], thread: THREAD })).status, 403);
  assert.equal((await post({ args: ["send", "--project", "p", "claude:a@b", "y"], thread: THREAD })).status, 200);
});

test("a body of the wrong shape is refused", async () => {
  assert.equal((await post({ args: "send", thread: THREAD })).status, 400);
  assert.equal((await post({ args: [], thread: THREAD })).status, 400);
  assert.equal((await post({ args: ["send", 1], thread: THREAD })).status, 400);
  assert.equal((await post({ args: ["send"], thread: "../../x" })).status, 400);
  assert.equal((await post({ args: ["send"] })).status, 400);
});

test("a caller on another machine is refused, also with the right key", async () => {
  const req = { socket: { remoteAddress: "192.168.1.50" }, headers: { authorization: `Bearer ${key}` } };
  const out = await localrun.handle(req, { args: ["send", "claude:a@b", "y"], thread: THREAD }, { key, cli: CLI });
  assert.equal(out.code, 403);
  assert.match(out.body.error, /this machine/);
});

test("an empty key opens nothing, and the next start makes a real one", async () => {
  const req = { socket: { remoteAddress: "127.0.0.1" }, headers: {} };
  const out = await localrun.handle(req, { args: ["send", "claude:a@b", "y"], thread: THREAD }, { key: "", cli: CLI });
  assert.equal(out.code, 401);
  const file = path.join(HOME, "gateway.key");
  const held = fs.readFileSync(file, "utf8");
  fs.writeFileSync(file, "");
  try {
    assert.match(localrun.ensureKey(), /^[0-9a-f]{64}$/);
  } finally {
    fs.writeFileSync(file, held);
  }
});

test("the command runs outside the working directory of the gateway", async () => {
  fs.writeFileSync(CLI, `
    console.log(JSON.stringify({ cwd: process.cwd() }));
  `);
  try {
    const out = await (await post({ args: ["send", "claude:x@bob", "y"], thread: THREAD })).json();
    assert.equal(fs.realpathSync(JSON.parse(out.stdout).cwd), fs.realpathSync(HOME));
  } finally {
    fs.writeFileSync(CLI, FAKE_CLI);
  }
});

test("only a Codex session asks the gateway, and only for a person and for ack", () => {
  const codex = { CODEX_THREAD_ID: THREAD };
  const person = ["claude:a@alice", "hi"];
  assert.equal(localrun.shouldAsk("send", person, codex, "win32"), true);
  assert.equal(localrun.shouldAsk("ack", ["abc"], codex, "win32"), true);
  assert.equal(localrun.shouldAsk("send", person, {}, "win32"), false);
  assert.equal(localrun.shouldAsk("list", [], codex, "win32"), false);
  assert.equal(localrun.shouldAsk("send", person, { ...codex, OPENMSG_LOCAL: "1" }, "win32"), false);
  assert.equal(localrun.shouldAsk("send", ["claude:local", "hi"], codex, "win32"), false);
});

test("macOS and Linux keep their own path", () => {
  for (const platform of ["darwin", "linux"]) {
    assert.equal(localrun.shouldAsk("send", ["claude:a@alice", "hi"], { CODEX_THREAD_ID: THREAD }, platform), false);
  }
});

test("ask goes to the gateway of this owner", async () => {
  const out = await localrun.ask(["send", "claude:x@bob", "y"], { env: { CODEX_THREAD_ID: THREAD } });
  assert.deepEqual(JSON.parse(out.stdout).args, ["send", "claude:x@bob", "y"]);
});

// A port that a closed server held, so nothing answers there. `fetch` refuses
// some low ports with no connection, and such a port proves nothing.
async function closedPort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test("a gateway that does not answer gives null, so the command runs in place", async () => {
  saveSettings({ port: await closedPort() });
  try {
    assert.equal(await localrun.ask(["send"], { env: { CODEX_THREAD_ID: THREAD } }), null);
  } finally {
    saveSettings({ port: running.port });
  }
});

test("a gateway that took the request and went away is an error, because the message can have left", async () => {
  const server = net.createServer((socket) => socket.once("data", () => socket.destroy()));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  saveSettings({ port: server.address().port });
  try {
    await assert.rejects(
      localrun.ask(["send", "claude:x@bob", "y"], { env: { CODEX_THREAD_ID: THREAD } }),
      /can have left/,
    );
  } finally {
    saveSettings({ port: running.port });
    await new Promise((resolve) => server.close(resolve));
  }
});

test("the same key stays after a second start", () => {
  assert.equal(localrun.ensureKey(), key);
});
