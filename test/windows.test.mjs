// Tests for the paths that only native Windows takes. Most of them run on every
// system, because a stub of the Codex app-server stands in for the real one.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
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
const { isUnder, senderByDirectory, sessionById } = await import("../src/registry.mjs");
const { hookTargets, installHooks } = await import("../src/hookinstall.mjs");
const { system32, lockDown, onPath, pathDirs } = await import("../src/windows.mjs");
const { layoutOf, workspaceOf } = await import("../src/remote.mjs");
const { compose } = await import("../src/envelope.mjs");
const { forPeer, release, descriptions } = await import("../src/gateway.mjs");
const published = await import("../src/published.mjs");
const identity = await import("../src/identity.mjs");

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

test("an old token of a session that still runs stays", () => {
  const old = path.join(HOME, "claude-tokens", "long.json");
  tokens.put({ id: "long", socket: "x", token: "t" });
  const past = new Date(Date.now() - tokens.MAX_AGE_MS - 1000);
  fs.utimesSync(old, past, past);
  tokens.put({ id: "new2", socket: "y", token: "t", isLive: (id) => id === "long" });
  assert.equal(fs.existsSync(old), true);
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

const WINDOWS_ONLY = { skip: process.platform === "win32" ? false : "for Windows" };

// In a sandbox, Windows Script Host hangs with no error, and a test of the launcher
// proves nothing there. It takes 300 ms on a normal machine, so a long wait tells
// the two apart. It writes this file with `fs`, because a fault in the code under
// test must fail a test, and not skip it.
let scriptHost = null;
function scriptHostRuns() {
  if (scriptHost !== null) return scriptHost;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openmsg-wsh-"));
  const mark = path.join(dir, "ran.txt");
  const script = path.join(dir, "probe.vbs");
  fs.writeFileSync(script, `﻿CreateObject("Scripting.FileSystemObject").CreateTextFile("${mark}").Close\r\n`, "utf16le");
  spawnSync(system32("wscript.exe"), ["//B", "//T:10", script], { stdio: "ignore", timeout: 15_000 });
  scriptHost = fs.existsSync(mark);
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  return scriptHost;
}

function hook(home, id, env) {
  return spawnSync(process.execPath, [CLI, "hook", "claude"], {
    input: JSON.stringify({ session_id: id, cwd: HOME, hook_event_name: "SessionStart" }),
    env: { ...process.env, OPENMSG_HOME: home, ...env },
    encoding: "utf8",
  });
}

test("the hook hands the token of the session to the gateway", WINDOWS_ONLY, () => {
  const r = hook(HOME, "hook-1", { CLAUDE_CODE_MESSAGING_SOCKET: "pipe-h", CLAUDE_CODE_MESSAGING_TOKEN: "t-h" });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), {});
  assert.equal(tokens.tokenFor({ id: "hook-1", transport: { path: "pipe-h" } }), "t-h");
  assert.equal(tokens.tokenFor({ id: "hook-1", transport: { path: "other-pipe" } }), null);
});

test("the hook writes nothing with no token in its environment", WINDOWS_ONLY, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "openmsg-win-hook-"));
  const r = hook(home, "hook-2", { CLAUDE_CODE_MESSAGING_SOCKET: "pipe-h", CLAUDE_CODE_MESSAGING_TOKEN: "" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.existsSync(path.join(home, "claude-tokens")), false);
  fs.rmSync(home, { recursive: true, force: true });
});

test("a hook that cannot write the token does not stop the agent", WINDOWS_ONLY, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "openmsg-win-hook-"));
  fs.writeFileSync(path.join(home, "claude-tokens"), "a file where the directory goes");
  const r = hook(home, "hook-3", { CLAUDE_CODE_MESSAGING_SOCKET: "pipe-h", CLAUDE_CODE_MESSAGING_TOKEN: "t-h" });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), {});
  fs.rmSync(home, { recursive: true, force: true });
});

test("the hook runs in each Claude config directory", () => {
  const dirs = [path.join(HOME, "cfg-a"), path.join(HOME, "cfg-b"), path.join(HOME, "cfg-absent")];
  for (const d of dirs.slice(0, 2)) fs.mkdirSync(d);
  const targets = hookTargets(dirs).filter((t) => t.vendor === "claude");
  assert.equal(targets.length, 3);
  const rows = installHooks("node cli.mjs", targets);
  assert.deepEqual(rows.map((r) => r.action), ["created", "created", "skipped (agent not installed)"]);
  for (const d of dirs.slice(0, 2)) {
    const written = JSON.parse(fs.readFileSync(path.join(d, "settings.json"), "utf8"));
    assert.equal(written.hooks.SessionStart[0].hooks[0].command, "node cli.mjs hook claude");
  }
});

test("a system tool goes by its full path, so the working directory cannot replace it", () => {
  assert.ok(path.win32.isAbsolute(system32("reg.exe")));
  assert.match(system32("WindowsPowerShell", "v1.0", "powershell.exe"), /System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/);
  assert.ok(service.runCommand("C:\\g.vbs").endsWith('wscript.exe" //B "C:\\g.vbs"'));
});

test("the directory of the keys has one user in its access list", WINDOWS_ONLY, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openmsg-win-acl-"));
  assert.equal(lockDown(dir), true);
  const list = spawnSync(system32("icacls.exe"), [dir], { encoding: "utf8" }).stdout;
  assert.ok(!/Everyone|Users:|BUILTIN|Authenticated/i.test(list), list);
  assert.match(list, new RegExp(process.env.USERNAME, "i"));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a command from a plain shell does not take the name of a Codex thread", () => {
  const here = "C:\\work";
  const codex = [{ vendor: "codex", id: "a", name: "work-a", cwd: here }, { vendor: "codex", id: "b", name: "work-b", cwd: here }];
  const facts = { here, codex, opencode: [] };
  assert.equal(senderByDirectory({ ...facts, names: ["pwsh", "explorer"], platform: "win32" }), null);
  assert.equal(senderByDirectory({ ...facts, names: [], platform: "win32" }), null);
  assert.throws(() => senderByDirectory({ ...facts, names: ["node", "codex"], platform: "win32" }), /2 Codex sessions/);
  assert.throws(() => senderByDirectory({ ...facts, names: ["", ""], platform: "linux" }), /2 Codex sessions/);
  assert.equal(senderByDirectory({ ...facts, codex: codex.slice(0, 1), names: ["", ""], platform: "linux" }), codex[0]);
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

test("a published thread goes by its id, at any age", async () => {
  const old = Math.floor(Date.now() / 1000) - 30 * 86400;
  const stub = stubCodex("read", {
    "thread/read": { result: { thread: { id: "dddd-4444", cwd: "C:\\repo\\api", updatedAt: old, createdAt: old } } },
  });
  const out = await sessionById("codex", "dddd-4444", { platform: "win32", options: { env: stub.env } });
  assert.equal(out.id, "dddd-4444");
  assert.equal(out.name, "api-4444");
  assert.deepEqual(out.transport, { kind: "codex-queue" });
  assert.deepEqual(stub.seen().find((r) => r.method === "thread/read").params, { threadId: "dddd-4444", includeTurns: false });
});

test("a thread that Codex does not know gives null, and other vendors do not look", async () => {
  const stub = stubCodex("unread", { "thread/read": { error: { code: -32600, message: "thread not loaded" } } });
  assert.equal(await sessionById("codex", "nope", { platform: "win32", options: { env: stub.env } }), null);
  assert.equal(await sessionById("claude", "x", { platform: "win32" }), null);
  assert.equal(await sessionById("codex", "x", { platform: "linux" }), null);
});

test("the end of stdin stops the wrapper of npm and the binary behind it", async () => {
  const pidFile = path.join(HOME, "real-codex.pid");
  const real = path.join(HOME, "real-codex.mjs");
  fs.writeFileSync(real, `
    import fs from "node:fs";
    import readline from "node:readline";
    fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
    const lines = readline.createInterface({ input: process.stdin });
    lines.on("line", (line) => {
      const m = JSON.parse(line);
      if (m.id !== undefined) console.log(JSON.stringify({ id: m.id, result: {} }));
    });
    lines.on("close", () => process.exit(0));
  `);
  const wrapper = path.join(HOME, "wrapper.mjs");
  fs.writeFileSync(wrapper, `
    import { spawn } from "node:child_process";
    const child = spawn(process.execPath, [${JSON.stringify(real)}], { stdio: "inherit" });
    child.on("exit", (code) => process.exit(code ?? 0));
  `);
  const env = { ...process.env, OPENMSG_CODEX_BIN: wrapper };
  await rpc.withAppServer(async (call) => call("thread/list", {}), { env });
  const pid = Number(fs.readFileSync(pidFile, "utf8"));
  assert.throws(() => process.kill(pid, 0), "the binary must end with the wrapper");
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

test("a relative entry of the PATH cannot give the Codex that runs", () => {
  const checkout = fs.mkdtempSync(path.join(os.tmpdir(), "openmsg-win-checkout-"));
  const before = process.cwd();
  fs.writeFileSync(path.join(checkout, "codex.exe"), "");
  fs.mkdirSync(path.join(checkout, "node_modules", "@openai", "codex", "bin"), { recursive: true });
  fs.writeFileSync(path.join(checkout, "node_modules", "@openai", "codex", "bin", "codex.js"), "");
  fs.mkdirSync(path.join(checkout, "bin"));
  fs.writeFileSync(path.join(checkout, "bin", "codex.exe"), "");
  fs.mkdirSync(path.join(checkout, "OpenAI", "Codex", "bin", "1"), { recursive: true });
  fs.writeFileSync(path.join(checkout, "OpenAI", "Codex", "bin", "1", "codex.exe"), "");
  fs.mkdirSync(path.join(checkout, "packages", "app-server-daemon", "current", "bin"), { recursive: true });
  fs.writeFileSync(path.join(checkout, "packages", "app-server-daemon", "current", "bin", "codex.exe"), "");
  const none = { CODEX_HOME: path.join(HOME, "no-codex-home") };
  process.chdir(checkout);
  try {
    for (const PATH of [".", `.${path.delimiter}node_modules`, "bin", "node_modules/.."]) {
      assert.equal(rpc.resolveCodex({ ...none, PATH }), null, `PATH=${PATH}`);
    }
    assert.equal(rpc.resolveCodex({ ...none, PATH: "", OPENMSG_CODEX_BIN: "codex.exe" }), null, "a bare name is not a full path");
    assert.equal(rpc.resolveCodex({ ...none, PATH: "", LOCALAPPDATA: "." }), null, "the data directory of the app");
    assert.equal(rpc.resolveCodex({ PATH: "", CODEX_HOME: "." }), null, "the home of Codex");
    assert.equal(rpc.resolveCodex({ ...none, PATH: checkout }).command, path.join(checkout, "codex.exe"), "a full path still works");
  } finally {
    process.chdir(before);
    fs.rmSync(checkout, { recursive: true, force: true });
  }
});

test("a directory of the PATH needs a full root", WINDOWS_ONLY, () => {
  const dirs = pathDirs({ PATH: ["C:\\tools", ".", "bin", "\\on-this-drive", "C:relative", "\\\\host\\share\\bin"].join(";") });
  assert.deepEqual(dirs, ["C:\\tools", "\\\\host\\share\\bin"]);
});

test("each source of the Codex binary needs a full root", WINDOWS_ONLY, () => {
  const none = { CODEX_HOME: path.join(HOME, "no-codex-home"), PATH: "" };
  for (const file of ["\\tools\\codex.exe", "/tools/codex.exe", "C:codex.exe"]) {
    assert.equal(rpc.resolveCodex({ ...none, OPENMSG_CODEX_BIN: file }), null, file);
  }
  assert.ok(rpc.resolveCodex({ ...none, OPENMSG_CODEX_BIN: "C:\\tools\\codex.exe" }));
});

test("a script path with a percent sign does not fit the Run key", () => {
  assert.throws(() => service.mustFitRunKey("C:\\x\\%USERNAME%\\gateway.vbs"), /holds a "%"/);
  assert.doesNotThrow(() => service.mustFitRunKey("C:\\Users\\測試\\.openmsg\\gateway.vbs"));
});

test("the launcher quotes each path, and it runs the gateway with no window", () => {
  const script = service.launcherScript({
    node: "C:\\Program Files\\nodejs\\node.exe",
    cli: "C:\\a b\\cli.mjs",
    log: "C:\\Users\\x y\\gateway.log",
    stop: "C:\\Users\\x y\\gateway.stop",
    lock: "C:\\Users\\x y\\gateway.lock",
    args: ["--port", "7801"],
  });
  assert.ok(script.includes('("OPENMSG_LAUNCH_NODE") = "C:\\Program Files\\nodejs\\node.exe"'), script);
  assert.ok(script.includes('""%OPENMSG_LAUNCH_NODE%"" ""%OPENMSG_LAUNCH_CLI%"" gateway start --log ""%OPENMSG_LAUNCH_LOG%"" --port 7801'), script);
  assert.ok(script.includes(', 0, True'), "window style 0, and it waits for the gateway");
  assert.ok(script.includes("Do While Not"), "it starts the gateway again until the stop file exists");
  assert.ok(!script.includes("cmd /c"), "no shell reads a path");
});

test("the launcher has a byte order mark, so each path survives", () => {
  const file = path.join(HOME, "mark.vbs");
  service.writeLauncher(file, "' café 測試\r\n");
  const bytes = fs.readFileSync(file);
  assert.deepEqual([...bytes.subarray(0, 2)], [0xff, 0xfe]);
  assert.equal(bytes.subarray(2).toString("utf16le"), "' café 測試\r\n");
});

test("the arguments of the launcher take only a strict shape", () => {
  assert.deepEqual(service.startArgs({ port: "7801", host: "0.0.0.0", relay: "wss://192.168.1.241:7800" }), [
    "--port", "7801", "--host", "0.0.0.0", "--relay", "wss://192.168.1.241:7800",
  ]);
  assert.deepEqual(service.startArgs({}), []);
  assert.throws(() => service.startArgs({ port: '1" & calc' }), /--port/);
  assert.throws(() => service.startArgs({ host: 'a" b' }), /--host/);
  assert.throws(() => service.startArgs({ relay: 'wss://a"b' }), /--relay/);
  assert.throws(() => service.startArgs({ relay: "http://a" }), /--relay/);
});

test("the log keeps one old copy", () => {
  const file = path.join(HOME, "rotate.log");
  const say = service.logTo(file, { maxBytes: 10 });
  say("first line, long enough");
  say("second");
  assert.equal(fs.readFileSync(`${file}.1`, "utf8"), "first line, long enough\n");
  assert.equal(fs.readFileSync(file, "utf8"), "second\n");
});

test("the real launcher keeps each path as it is, and the stop file ends it", WINDOWS_ONLY, async (t) => {
  if (!scriptHostRuns()) return t.skip("Windows Script Host does not run here");
  // `Run` would expand this name, and the result is a directory that does not exist.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "openmsg-測試 café 100%-%USERNAME%-"));
  const started = [];
  t.after(() => {
    for (const child of started) child.kill();
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 });
  });
  const mark = path.join(home, "ran.txt");
  const cli = path.join(home, "cli.mjs");
  fs.writeFileSync(cli, `
    import fs from "node:fs";
    fs.appendFileSync(${JSON.stringify(mark)}, process.argv.slice(2).join(" ") + "\\n");
  `);
  const launcher = path.join(home, "gateway.vbs");
  const stop = path.join(home, "gateway.stop");
  const lock = path.join(home, "gateway.lock");
  // The program itself goes under that name too. A hard link fails across volumes.
  const node = path.join(home, "node.exe");
  fs.copyFileSync(fs.realpathSync(process.execPath), node);
  service.writeLauncher(launcher, service.launcherScript({ node, cli, log: path.join(home, "g.log"), stop, lock, args: ["--port", "1"] }));
  // A stop file from an earlier day must not stop this start.
  fs.writeFileSync(stop, "");
  const start = () => {
    const child = spawn(system32("wscript.exe"), ["//B", launcher], { stdio: "ignore" });
    started.push(child);
    return child;
  };
  const ended = (c) => new Promise((resolve) => c.once("exit", resolve));
  const child = start();
  const gone = ended(child);
  const until = Date.now() + 20_000;
  while (!fs.existsSync(mark) && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
  const seen = fs.readFileSync(mark, "utf8");
  assert.ok(seen.includes(`gateway start --log ${path.join(home, "g.log")} --port 1`), seen);

  // A second script ends at once, so it cannot start a gateway after a stop.
  const second = start();
  const quick = await Promise.race([ended(second), new Promise((r) => setTimeout(() => r("still runs"), 4000))]);
  assert.equal(quick, 0, "one script runs for one owner");

  fs.writeFileSync(stop, "");
  const code = await Promise.race([gone, new Promise((r) => setTimeout(() => r("still runs"), 12_000))]);
  assert.equal(code, 0, "the script ends when the stop file exists");
  assert.equal(fs.existsSync(stop), false, "the script removes the stop file");
});

test("the launcher writes to the log when node does not start", WINDOWS_ONLY, async (t) => {
  if (!scriptHostRuns()) return t.skip("Windows Script Host does not run here");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "openmsg-win-node-"));
  let child = null;
  t.after(() => {
    child?.kill();
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 });
  });
  const log = path.join(home, "g.log");
  const launcher = path.join(home, "gateway.vbs");
  const stop = path.join(home, "gateway.stop");
  service.writeLauncher(launcher, service.launcherScript({
    node: path.join(home, "no-node.exe"), cli: "x.mjs", log, stop, lock: path.join(home, "gateway.lock"),
  }));
  child = spawn(system32("wscript.exe"), ["//B", launcher], { stdio: "ignore" });
  const gone = new Promise((resolve) => child.once("exit", resolve));
  const until = Date.now() + 8000;
  while (!fs.existsSync(log) && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
  fs.writeFileSync(stop, "");
  await Promise.race([gone, new Promise((r) => setTimeout(r, 8000))]);
  assert.match(fs.readFileSync(log, "utf8"), /could not start node/);
});

test("a failed start of a gateway leaves its reason in the log, and leaves the stop file", WINDOWS_ONLY, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "openmsg-win-log-"));
  const log = path.join(home, "g.log");
  const stop = path.join(home, "gateway.stop");
  fs.writeFileSync(stop, "");
  const r = spawnSync(process.execPath, [CLI, "gateway", "start", "--port", "0", "--log", log], {
    env: { ...process.env, OPENMSG_HOME: home },
    encoding: "utf8",
  });
  assert.equal(r.status, 1);
  assert.match(fs.readFileSync(log, "utf8"), /the gateway failed: .*identity/i);
  assert.equal(fs.existsSync(stop), true, "a start that fails must not eat a stop");
  fs.rmSync(home, { recursive: true, force: true });
});

test("gateway stop ends a gateway of this owner, and the port is free again", WINDOWS_ONLY, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "openmsg-win-stop-"));
  const env = { ...process.env, OPENMSG_HOME: home };
  assert.equal(spawnSync(process.execPath, [CLI, "id", "create", "--label", "w"], { env }).status, 0);
  const child = spawn(process.execPath, [CLI, "gateway", "start", "--port", "0"], { env, stdio: ["ignore", "pipe", "pipe"] });
  const gone = new Promise((resolve) => child.once("exit", resolve));
  await new Promise((resolve) => child.stdout.on("data", (d) => /listens on/.test(String(d)) && resolve()));
  const r = spawnSync(process.execPath, [CLI, "gateway", "stop"], { env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /the gateway stopped/);
  assert.equal(await Promise.race([gone, new Promise((res) => setTimeout(() => res("still runs"), 8000))]), 0);
  fs.rmSync(home, { recursive: true, force: true });
});

test("a program in the checkout does not run in place of git", WINDOWS_ONLY, () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "openmsg-win-git-"));
  fs.copyFileSync(path.join(system32(), "whoami.exe"), path.join(repo, "git.exe"));
  assert.equal(onPath("git.exe", { PATH: ".;relative\\dir" }), null, "a relative entry does not count");
  assert.ok(path.win32.isAbsolute(onPath("git.exe")));
  assert.notEqual(path.win32.dirname(onPath("git.exe")).toLowerCase(), repo.toLowerCase());
  assert.equal(workspaceOf(repo), null, "this directory is no repository, and the git of the PATH says so");
  fs.rmSync(repo, { recursive: true, force: true });
});

test("a Claude session on native Windows waits for the yes of its owner", () => {
  const agent = { vendor: "claude", id: "ses-hold", name: "worker" };
  assert.throws(() => published.publish("p-hold", agent, { platform: "win32" }), /skips the hold gate.*--skip-hold-gate/);
  assert.equal(published.list("p-hold").length, 0);
  assert.equal(published.publish("p-hold", agent, { platform: "win32", skipHoldGate: true }).skipHoldGate, true);
});

test("each new session under one name needs its own yes", () => {
  const next = { vendor: "claude", id: "ses-hold-2", name: "worker" };
  assert.throws(() => published.publish("p-hold", next, { platform: "win32" }), /--skip-hold-gate/);
  assert.equal(published.find("p-hold", { alias: "claude:worker" }).session, "ses-hold", "a refused publish changes nothing");
});

test("a session that keeps its hold gate needs no yes", () => {
  const claude = { vendor: "claude", id: "ses-mac", name: "mac" };
  assert.equal("skipHoldGate" in published.publish("p-keep", claude, { platform: "linux", skipHoldGate: true }), false);
  const codex = { vendor: "codex", id: "thread-1", name: "win" };
  assert.equal("skipHoldGate" in published.publish("p-keep", codex, { platform: "win32" }), false);
});

test("a row with no yes is not reachable on native Windows", () => {
  assert.equal(published.reachable({ vendor: "claude" }, "win32"), false);
  assert.equal(published.reachable({ vendor: "claude", skipHoldGate: true }, "win32"), true);
  assert.equal(published.reachable({ vendor: "claude" }, "linux"), true);
  assert.equal(published.reachable({ vendor: "codex" }, "win32"), true);
});

test("the gateway does not offer or reach a Claude row with no yes", WINDOWS_ONLY, async () => {
  const before = process.env.OPENMSG_HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "openmsg-win-row-"));
  process.env.OPENMSG_HOME = home;
  try {
    identity.create({ label: "w" });
    const write = (extra) => fs.writeFileSync(path.join(home, "published.json"), JSON.stringify({
      version: 2,
      projects: { p: { "claude:old": { alias: "claude:old", vendor: "claude", name: "old", session: "ses-old", epoch: 1, ...extra } } },
    }));
    const record = {
      messageId: "11111111-0000-0000-0000-000000000000",
      project: "p",
      from: { owner: "o_x", label: "x" },
      target: { session: "ses-old", epoch: 1 },
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const deliver = () => assert.fail("no adapter may see this message");

    write({});
    assert.deepEqual((await descriptions("p")).routing, []);
    assert.equal((await release(record, { deliver })).reason, "not-published");

    // With the yes, the same row goes on to the next rule.
    write({ skipHoldGate: true });
    assert.equal((await descriptions("p")).routing.length, 1);
    assert.equal((await release(record, { deliver })).reason, "session-gone");
  } finally {
    process.env.OPENMSG_HOME = before;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("publish takes --skip-hold-gate, and it says what that means", WINDOWS_ONLY, (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "openmsg-win-pub-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const sessions = path.join(home, ".claude", "sessions");
  fs.mkdirSync(sessions, { recursive: true });
  fs.writeFileSync(path.join(sessions, "1.json"), JSON.stringify({
    sessionId: "ses-pub",
    name: "pub",
    pid: process.pid,
    messagingSocketPath: "\\\\.\\pipe\\openmsg-test",
  }));
  const env = {
    ...process.env,
    OPENMSG_HOME: path.join(home, "om"),
    OPENMSG_CODEX_BIN: path.join(home, "no-such-codex.exe"),
    USERPROFILE: home,
  };
  delete env.CLAUDE_CONFIG_DIR;
  const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { env, encoding: "utf8" });
  assert.equal(run("id", "create", "--label", "w").status, 0);
  assert.equal(run("invite", "create", "--project", "web").status, 0);

  const refused = run("publish", "claude:pub");
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /skips the hold gate.*--skip-hold-gate/);
  assert.match(run("publish").stdout, /nothing is published/);

  const yes = run("publish", "claude:pub", "--skip-hold-gate");
  assert.equal(yes.status, 0, yes.stderr);
  assert.match(yes.stdout, /skips the hold gate/);
  assert.match(yes.stdout, /crossSessionInbound/);
  assert.match(run("publish").stdout, /claude:pub.*skips the hold gate/);
});

test("accept keeps a held message for a row with no yes", WINDOWS_ONLY, (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "openmsg-win-held-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const row = {
    messageId: "22222222-0000-0000-0000-000000000000",
    project: "p",
    from: { owner: "o_x", label: "x" },
    target: { session: "ses-held", epoch: 1 },
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    status: "held",
  };
  fs.writeFileSync(path.join(home, "inbound.jsonl"), JSON.stringify(row) + "\n");
  fs.writeFileSync(path.join(home, "published.json"), JSON.stringify({
    version: 2,
    projects: { p: { "claude:held": { alias: "claude:held", vendor: "claude", name: "held", session: "ses-held", epoch: 1 } } },
  }));
  const r = spawnSync(process.execPath, [CLI, "accept", "22222222"], { env: { ...process.env, OPENMSG_HOME: home }, encoding: "utf8" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /publish claude:held --skip-hold-gate/);
  const last = fs.readFileSync(path.join(home, "inbound.jsonl"), "utf8").trim().split("\n").at(-1);
  assert.equal(JSON.parse(last).status, "held");
});

test("the frame gives no quote of the sender to the command that it shows", () => {
  const hostile = 'x" && calc && echo "';
  const parts = layoutOf({
    message: {
      messageId: "12345678-0000-0000-0000-000000000000",
      parts: [{ text: "hello" }],
      openmsg: { from: { vendor: "claude", id: hostile, name: hostile }, project: { label: "p" }, workspace: { branch: 'b"$(calc)' } },
    },
    verified: { owner: "o_12345678", label: hostile, project: "p" },
  });
  const frame = compose(parts);
  const line = frame.split("\n").find((l) => l.startsWith("To answer:"));
  assert.equal(line.split('"').length, 5, line);
  assert.ok(line.includes("@o_12345678"), line);
  assert.ok(!frame.includes("$(calc)"));
});

test("a stop works while the first join waits for a silent relay", WINDOWS_ONLY, async (t) => {
  const net = await import("node:net");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "openmsg-win-join-"));
  const held = new Set();
  const relay = net.createServer((socket) => {
    held.add(socket);
    socket.on("error", () => {});
  });
  await new Promise((resolve) => relay.listen(0, "127.0.0.1", resolve));
  const env = { ...process.env, OPENMSG_HOME: home };
  assert.equal(spawnSync(process.execPath, [CLI, "id", "create", "--label", "w"], { env }).status, 0);
  const asked = new Promise((resolve) => relay.once("connection", resolve));
  const child = spawn(process.execPath, [CLI, "gateway", "start", "--port", "0", "--relay", `ws://127.0.0.1:${relay.address().port}`], { env, stdio: "ignore" });
  const gone = new Promise((resolve) => child.once("exit", resolve));
  t.after(() => {
    child.kill();
    for (const socket of held) socket.destroy();
    relay.close();
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 });
  });
  await asked;
  const r = spawnSync(process.execPath, [CLI, "gateway", "stop"], { env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(await Promise.race([gone, new Promise((res) => setTimeout(res, 5000, "still runs").unref())]), 0);
});

test("the reason of a failed adapter goes to the sender, and its detail stays here", () => {
  const out = { status: "refused", reason: "adapter-failed", detail: "claude socket \\\\.\\pipe\\LOCAL\\cc-msg-1: timeout", messageId: "m" };
  assert.deepEqual(forPeer(out), { status: "refused", reason: "adapter-failed", messageId: "m" });
  const other = { status: "refused", reason: "old-epoch", detail: "the message names epoch 1", messageId: "m" };
  assert.deepEqual(forPeer(other), other);
});

test("a port that another program holds is an error of the command", async () => {
  const net = await import("node:net");
  const holder = net.createServer();
  await new Promise((resolve) => holder.listen(0, "127.0.0.1", resolve));
  const { port } = holder.address();
  const gateway = await import("../src/gateway.mjs");
  await assert.rejects(gateway.serve({ port, host: "127.0.0.1" }), /EADDRINUSE/);
  await new Promise((resolve) => holder.close(resolve));
});

test("the install command stops with a clear error outside Windows", { skip: process.platform === "win32" ? "for macOS and Linux" : false }, async () => {
  await assert.rejects(service.install("cli"), /for Windows/);
});

const chain = (rows) => new Map(rows.map(([pid, ppid, name]) => [pid, { ppid, name }]));

test("a gap above a Git Bash shell keeps the socket as the evidence", () => {
  const table = chain([[50, 40, "node"], [40, 30, "sh"]]);
  assert.equal(isUnder(table, 40, 9, "win32"), true);
});

test("a gap at the top of the chain means that the session is not a parent", () => {
  const table = chain([[50, 40, "pwsh"], [40, 30, "explorer"]]);
  assert.equal(isUnder(table, 50, 9, "win32"), false);
});

test("a gap above a shell counts only on Windows", () => {
  const table = chain([[40, 30, "sh"]]);
  assert.equal(isUnder(table, 40, 9, "linux"), false);
});

test("another agent in the chain stops the walk, also above a shell", () => {
  const table = chain([[50, 40, "sh"], [40, 30, "codex"], [30, 9, "claude"]]);
  assert.equal(isUnder(table, 50, 9, "win32"), false);
});

test("the session in the chain is the answer", () => {
  const table = chain([[50, 40, "bash"], [40, 9, "bash"], [9, 1, "claude"]]);
  assert.equal(isUnder(table, 50, 9, "win32"), true);
});
