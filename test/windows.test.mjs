// Tests for the paths that only native Windows takes. Most of them run on every
// system, because a stub of the Codex app-server stands in for the real one.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "openmsg-win-"));
process.env.OPENMSG_HOME = HOME;
after(() => fs.rmSync(HOME, { recursive: true, force: true }));

const CLI = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));
const tokens = await import("../src/sessiontokens.mjs");
const { claudeToken } = await import("../src/deliver.mjs");
const rpc = await import("../src/adapters/codexrpc.mjs");
const service = await import("../src/service.mjs");

// A stub of `codex app-server`. It writes each request and its own argv to a
// file, and it answers with the JSON that the test gives it.
function stubCodex(name, answers) {
  const file = path.join(HOME, `${name}.mjs`);
  const seen = path.join(HOME, `${name}.seen`);
  fs.writeFileSync(file, `
    import fs from "node:fs";
    import readline from "node:readline";
    const answers = ${JSON.stringify(answers)};
    const seen = ${JSON.stringify(seen)};
    fs.appendFileSync(seen, JSON.stringify({ argv: process.argv.slice(2) }) + "\\n");
    readline.createInterface({ input: process.stdin }).on("line", (line) => {
      const m = JSON.parse(line);
      fs.appendFileSync(seen, line + "\\n");
      if (m.id === undefined) return;
      if (m.method === "initialize") return console.log(JSON.stringify({ id: m.id, result: { userAgent: "stub" } }));
      const answer = answers[m.method];
      if (answer) console.log(JSON.stringify({ id: m.id, ...answer }));
    });
  `);
  const env = { ...process.env, OPENMSG_CODEX_BIN: file };
  return { env, seen: () => fs.readFileSync(seen, "utf8").trim().split("\n").map((l) => JSON.parse(l)) };
}

const agent = { id: "s-1", name: "api", transport: { path: "\\\\.\\pipe\\LOCAL\\cc-msg-1" } };

test("a token holds for the socket that it came from, and for no other", () => {
  tokens.put({ id: "s-1", socket: agent.transport.path, token: "t-1" });
  assert.equal(tokens.tokenFor(agent), "t-1");
  assert.equal(tokens.tokenFor({ ...agent, transport: { path: "\\\\.\\pipe\\LOCAL\\cc-msg-2" } }), null);
  assert.equal(tokens.tokenFor({ ...agent, id: "s-2" }), null);
});

test("an old token goes away when a new session writes its own", () => {
  const old = path.join(HOME, "claude-tokens", "old.json");
  tokens.put({ id: "old", socket: "x", token: "t" });
  const past = new Date(Date.now() - tokens.MAX_AGE_MS - 1000);
  fs.utimesSync(old, past, past);
  tokens.put({ id: "new", socket: "y", token: "t" });
  assert.equal(fs.existsSync(old), false);
});

test("Windows refuses to deliver with no token, because the session would drop the message with no error", () => {
  const other = { id: "s-9", name: "gone", transport: { path: "\\\\.\\pipe\\LOCAL\\cc-msg-9" } };
  assert.throws(() => claudeToken(other, { platform: "win32", env: {} }), /openmsg install --hooks/);
});

test("macOS and Linux send no stored token, so the inbound rules of the session apply", () => {
  assert.equal(claudeToken(agent, { platform: "linux", env: {} }), undefined);
});

test("the own session uses the token of the environment", () => {
  const env = { CLAUDE_CODE_MESSAGING_SOCKET: agent.transport.path, CLAUDE_CODE_MESSAGING_TOKEN: "own" };
  assert.equal(claudeToken(agent, { platform: "win32", env }), "own");
});

test("the hook writes the token on Windows only", { skip: process.platform === "win32" ? false : "for Windows" }, () => {
  const r = spawnSync(process.execPath, [CLI, "hook", "claude"], {
    input: JSON.stringify({ session_id: "hook-1", cwd: HOME, hook_event_name: "SessionStart" }),
    env: { ...process.env, CLAUDE_CODE_MESSAGING_SOCKET: "pipe-h", CLAUDE_CODE_MESSAGING_TOKEN: "t-h" },
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(tokens.tokenFor({ id: "hook-1", transport: { path: "pipe-h" } }), "t-h");
});

test("the text of a message goes over stdin, and never on a command line", async () => {
  const stub = stubCodex("queue", { "thread/queue/add": { result: { queuedSubmission: { id: "q-1" } } } });
  const text = 'hello" & calc.exe & "';
  const out = await rpc.queueOverStdio("t-1", text, { start: 0, end: 5 }, { env: stub.env });
  assert.deepEqual([out.delivered, out.transport], [true, "codex-stdio"]);
  const rows = stub.seen();
  assert.deepEqual(rows[0].argv, ["app-server", "--listen", "stdio://"]);
  const add = rows.find((r) => r.method === "thread/queue/add");
  assert.equal(add.params.threadId, "t-1");
  assert.equal(add.params.input[0].text, text);
  assert.deepEqual(add.params.input[0].text_elements, [{ byteRange: { start: 0, end: 5 }, placeholder: null }]);
});

test("a refusal from Codex is an error", async () => {
  const stub = stubCodex("refuse", { "thread/queue/add": { error: { message: "thread not found" } } });
  await assert.rejects(rpc.queueOverStdio("t", "x", null, { env: stub.env }), /thread not found/);
});

test("no answer is an error that says the message can be in the queue", async () => {
  const stub = stubCodex("mute", {});
  await assert.rejects(
    rpc.queueOverStdio("t", "x", null, { env: stub.env, timeoutMs: 400 }),
    /can be in its queue/,
  );
});

test("a Codex binary that does not start is an error, and not a hang", async () => {
  const env = { ...process.env, OPENMSG_CODEX_BIN: path.join(HOME, "no-such-codex.exe") };
  await assert.rejects(rpc.queueOverStdio("t", "x", null, { env, timeoutMs: 2000 }), /did not start/);
});

test("the list holds the recent threads, and it leaves out old and ephemeral threads", async () => {
  const now = Date.now();
  const at = Math.floor(now / 1000);
  const stub = stubCodex("list", {
    "thread/list": {
      result: {
        data: [
          { id: "aaaa-1111", cwd: "C:\\repo\\api", updatedAt: at - 60, createdAt: at - 90, name: "fix", source: "vscode" },
          { id: "bbbb-2222", cwd: "C:\\repo\\old", updatedAt: at - 13 * 3600, createdAt: at - 14 * 3600 },
          { id: "cccc-3333", cwd: "C:\\repo\\tmp", updatedAt: at - 60, createdAt: at - 60, ephemeral: true },
        ],
      },
    },
  });
  const rows = await rpc.listThreads({ now, options: { env: stub.env } });
  assert.deepEqual(rows.map((r) => r.id), ["aaaa-1111"]);
  assert.equal(rows[0].name, "api-1111");
  assert.equal(rows[0].title, "fix");
  assert.deepEqual(rows[0].transport, { kind: "codex-queue" });
  const asked = stub.seen().find((r) => r.method === "thread/list").params;
  assert.deepEqual(asked.sourceKinds, ["cli", "vscode"]);
});

test("the binary of the Codex app goes before the PATH, and the newest one wins", () => {
  const local = path.join(HOME, "local");
  const dirOf = (name) => path.join(local, "OpenAI", "Codex", "bin", name);
  for (const name of ["old", "new"]) {
    fs.mkdirSync(dirOf(name), { recursive: true });
    fs.writeFileSync(path.join(dirOf(name), "codex.exe"), "");
  }
  const past = new Date(Date.now() - 3600 * 1000);
  fs.utimesSync(path.join(dirOf("old"), "codex.exe"), past, past);
  const pathDir = path.join(HOME, "bin");
  fs.mkdirSync(pathDir, { recursive: true });
  fs.writeFileSync(path.join(pathDir, "codex.exe"), "");
  const empty = path.join(HOME, "no-codex-home");
  assert.equal(
    rpc.resolveCodex({ LOCALAPPDATA: local, PATH: pathDir, CODEX_HOME: empty }).command,
    path.join(dirOf("new"), "codex.exe"),
  );
  assert.equal(rpc.resolveCodex({ PATH: pathDir, CODEX_HOME: empty }).command, path.join(pathDir, "codex.exe"));
});

test("an npm install of Codex runs through node, and never through its .cmd file", () => {
  const npm = path.join(HOME, "npm");
  const script = path.join(npm, "node_modules", "@openai", "codex", "bin", "codex.js");
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.writeFileSync(script, "");
  fs.writeFileSync(path.join(npm, "codex.cmd"), "");
  const out = rpc.resolveCodex({ PATH: npm, CODEX_HOME: path.join(HOME, "no-codex-home") });
  assert.deepEqual(out, { command: process.execPath, args: [script] });
});

test("no Codex anywhere gives null", () => {
  assert.equal(rpc.resolveCodex({ PATH: path.join(HOME, "empty"), CODEX_HOME: path.join(HOME, "no-codex-home") }), null);
});

test("the launcher quotes each path, and it runs the gateway with no window", () => {
  const script = service.launcherScript({
    node: "C:\\Program Files\\nodejs\\node.exe",
    cli: "C:\\a b\\cli.mjs",
    log: "C:\\Users\\x y\\gateway.log",
  });
  assert.ok(script.includes('""C:\\Program Files\\nodejs\\node.exe""'), script);
  assert.ok(script.includes('""C:\\a b\\cli.mjs"" gateway start'), script);
  assert.ok(script.includes(', 0, True'), "window style 0, and it waits for the gateway");
  assert.ok(script.includes("Do"), "it starts the gateway again");
  assert.equal(service.runCommand("C:\\x y\\gateway.vbs"), 'wscript.exe //B "C:\\x y\\gateway.vbs"');
});

test("the install command stops with a clear error outside Windows", { skip: process.platform === "win32" ? "for macOS and Linux" : false }, async () => {
  await assert.rejects(service.install("cli"), /for Windows/);
});
