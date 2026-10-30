// Codex on native Windows. Three things differ from macOS and Linux:
//
// - Node cannot reach the socket of the shared daemon. On Windows, `net` opens
//   a named pipe, and that socket is an AF_UNIX file.
// - The npm install of Codex is a `.cmd` file. Node runs a `.cmd` file only
//   through a shell, and the text of a message comes from another person. So
//   the text of a message never goes on a command line here.
// - A person can have the Codex app and no `codex` on the PATH.
//
// This file starts its own app-server on stdio, and it sends JSON-RPC there. The
// queue of a thread sits in a database that every app-server of the user shares,
// and each app-server looks at that database. So a message reaches a thread that
// another app-server owns, such as the one inside the Codex app.
// Source: openai/codex, codex-rs/ext/queue/src/service.rs, watch_external_messages.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { randomUUID } from "node:crypto";
import { isFullPath, pathDirs } from "../windows.mjs";

const RPC_TIMEOUT_MS = 15000;
// A thread that changed in this window counts as a session that runs.
const LIVE_WINDOW_MS = 12 * 3600 * 1000;
const STOP_TIMEOUT_MS = 2000;

function asCommand(file) {
  return /\.m?js$/.test(file) ? { command: process.execPath, args: [file] } : { command: file, args: [] };
}

function newestAppBinary(localAppData) {
  const root = path.join(localAppData, "OpenAI", "Codex", "bin");
  let best = null;
  let dirs = [];
  try {
    dirs = fs.readdirSync(root);
  } catch {
    return null;
  }
  for (const d of dirs) {
    const file = path.join(root, d, "codex.exe");
    try {
      const { mtimeMs } = fs.statSync(file);
      if (!best || mtimeMs > best.mtimeMs) best = { file, mtimeMs };
    } catch {
      // This directory holds no binary.
    }
  }
  return best?.file ?? null;
}

// The binary of the Codex app goes first. It is the newest one that a person
// has, and an older binary can fail to read the database of a newer one.
//
// Only a full path runs. A bare name or a relative path finds a file in the working
// directory, and that directory can be a checkout that nobody trusts.
export function resolveCodex(env = process.env) {
  const full = (file) => (isFullPath(file) ? asCommand(file) : null);
  const chosen = full(env.OPENMSG_CODEX_BIN) ?? full(env.LOCALAPPDATA && newestAppBinary(env.LOCALAPPDATA));
  if (chosen) return chosen;
  const home = env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
  const managed = path.join(home, "packages", "app-server-daemon", "current", "bin", "codex.exe");
  if (fs.existsSync(managed) && full(managed)) return full(managed);
  for (const dir of pathDirs(env)) {
    const exe = path.join(dir, "codex.exe");
    if (fs.existsSync(exe)) return asCommand(exe);
    const script = path.join(dir, "node_modules", "@openai", "codex", "bin", "codex.js");
    if (fs.existsSync(script)) return asCommand(script);
  }
  return null;
}

// The npm install of Codex is a node script that starts the real binary. A kill
// ends the script only, and the binary stays. The binary shares the stdin of the
// script and it stops when stdin ends, so that comes first. The kill is for a
// server that does not stop.
function stopServer(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    const timer = setTimeout(() => {
      child.kill();
      resolve();
    }, STOP_TIMEOUT_MS);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.stdin.end();
  });
}

// It starts one app-server, gives `use` a function that calls a method, and stops
// the server after `use` ends.
export async function withAppServer(use, { timeoutMs = RPC_TIMEOUT_MS, env = process.env } = {}) {
  const bin = resolveCodex(env);
  if (!bin) throw new Error("no Codex binary found. Install the Codex app, or set OPENMSG_CODEX_BIN to a full path");
  const child = spawn(bin.command, [...bin.args, "app-server", "--listen", "stdio://"], {
    stdio: ["pipe", "pipe", "ignore"],
    windowsHide: true,
    env,
  });
  const waiting = new Map();
  let failure = null;
  const stop = (why) => {
    failure ??= why;
    for (const done of waiting.values()) done({ failed: failure });
    waiting.clear();
  };
  child.on("error", (e) => stop(`codex did not start: ${e.message}`));
  child.on("exit", (code) => stop(`codex exited with code ${code}`));
  child.stdin.on("error", () => {});
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    if (m.id !== undefined && m.method === undefined && waiting.has(m.id)) waiting.get(m.id)(m);
  });

  let next = 0;
  const call = (method, params) => new Promise((resolve) => {
    if (failure) return resolve({ failed: failure });
    const id = ++next;
    const timer = setTimeout(() => done({ timedOut: true }), timeoutMs);
    const done = (m) => {
      clearTimeout(timer);
      waiting.delete(id);
      resolve(m);
    };
    waiting.set(id, done);
    child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
  });

  try {
    const init = await call("initialize", {
      clientInfo: { name: "openmsg", title: null, version: "0.2" },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    if (!init.result) throw new Error(`codex app-server did not start: ${JSON.stringify(init.error ?? init.failed ?? "timeout")}`);
    child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
    return await use(call);
  } finally {
    await stopServer(child);
  }
}

export async function queueOverStdio(threadId, text, highlight, options) {
  return withAppServer(async (call) => {
    const elements = highlight && highlight.end > highlight.start
      ? [{ byteRange: highlight, placeholder: null }]
      : [];
    const out = await call("thread/queue/add", {
      threadId,
      input: [{ type: "text", text, text_elements: elements }],
      clientUserMessageId: randomUUID(),
    });
    // A failure after the request left can hide a message in the queue. A second
    // try could deliver it two times, so this path makes no second try.
    if (out.error) throw new Error(`codex refused the message: ${out.error.message ?? JSON.stringify(out.error)}`);
    if (!out.result) throw new Error(`the codex app-server gave no answer for thread ${threadId}. The message can be in its queue.`);
    const id = out.result.queuedSubmission?.id;
    return { delivered: true, transport: "codex-stdio", detail: `Queued message ${id} for thread ${threadId}.` };
  }, options);
}

// `status` is of no use here: this app-server does not hold the thread, so it
// reports `notLoaded` for a thread that runs in the Codex app.
export async function listThreads({ limit = 50, now = Date.now(), options } = {}) {
  const out = await withAppServer(
    (call) => call("thread/list", { limit, sortKey: "updated_at", sourceKinds: ["cli", "vscode"], archived: false }),
    options,
  );
  if (!out.result) throw new Error(`codex thread/list failed: ${JSON.stringify(out.error ?? out.failed ?? "timeout")}`);
  return (out.result.data ?? [])
    .filter((t) => !t.ephemeral && now - t.updatedAt * 1000 <= LIVE_WINDOW_MS)
    .map(agentOf);
}

// One thread by its id, at any age. It gives null when Codex does not know it.
export async function readThread(threadId, { options } = {}) {
  const out = await withAppServer((call) => call("thread/read", { threadId, includeTurns: false }), options);
  return out.result?.thread ? agentOf(out.result.thread) : null;
}

function agentOf(t) {
  return {
    vendor: "codex",
    id: t.id,
    name: t.cwd ? `${path.win32.basename(t.cwd)}-${t.id.slice(-4)}` : t.id.slice(-8),
    pid: null,
    cwd: t.cwd ?? null,
    status: "unknown",
    title: t.name ?? t.preview ?? null,
    startedAt: t.createdAt ? t.createdAt * 1000 : null,
    updatedAt: t.updatedAt * 1000,
    transport: { kind: "codex-queue" },
  };
}
