// The sandbox of Codex blocks the local network, and it allows this machine. So
// `openmsg send` in a Codex session cannot reach the relay, or write to the home
// directory. The gateway runs outside the sandbox and it is on this machine, so
// the command asks the gateway to run it.
//
// This path is narrower than network access for the session: it runs `send` and
// `ack`, and a message reaches only the people that the owner accepted. A message
// to a session on this machine stays out of this path, because the gateway holds
// what the sandbox does not: the tokens of the Claude sessions. It is still a way
// out of the sandbox for text, so a session can tell those people what it can read.
//
// The thread id in a request comes from the caller, and the gateway cannot prove
// it. Each session of one user holds the same key, and a sandbox can read the
// transcript of every other session, so a secret for one session reaches them all.
// The check of that id stops a mistake, and it does not stop a session that lies.
// That id also becomes the sender of a `send`, and it need not be a real session.
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { home } from "./identity.mjs";
import { settings } from "./settings.mjs";
import { isProjectAddress } from "./projectbox.mjs";

export const LOCAL_PATH = "/openmsg/local";
const COMMANDS = new Set(["send", "ack"]);
const SEND_FLAGS = ["--reply-to", "--project", "--key"];
const THREAD_ID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
// A send can take 20 seconds of routing and 30 seconds on a dead address, and the
// relay takes it after that.
const RUN_TIMEOUT_MS = 60_000;
// These failures say that the request never reached a gateway.
const NOT_REACHED = new Set(["ECONNREFUSED", "EACCES", "EPERM", "ENETUNREACH", "EHOSTUNREACH"]);
const CLI = fileURLToPath(new URL("cli.mjs", import.meta.url));

function keyFile() {
  return path.join(home(), "gateway.key");
}

// The key says that the caller runs as this user. Each gateway start keeps it, so
// a command that reads it before a restart still works.
export function ensureKey() {
  const file = keyFile();
  try {
    const held = fs.readFileSync(file, "utf8").trim();
    if (held) return held;
  } catch {
    // The first start of a gateway has no key.
  }
  const key = crypto.randomBytes(32).toString("hex");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, key, { mode: 0o600 });
  return key;
}

// The address of a `send`, with the same reading as the command line.
function targetOf(args) {
  for (let i = 0; i < args.length; i += 1) {
    if (SEND_FLAGS.includes(args[i])) i += 1;
    else if (!args[i].startsWith("--")) return args[i];
  }
  return null;
}

function reachesPerson(command, args) {
  if (command !== "send") return true;
  const target = targetOf(args);
  return Boolean(target) && target.includes("@") && !isProjectAddress(target);
}

// OPENMSG_LOCAL marks the command that the gateway runs, so it does not ask the
// gateway a second time. macOS and Linux keep their own path: a command there
// runs where the session runs.
export function shouldAsk(command, args = [], env = process.env, platform = process.platform) {
  return platform === "win32" && COMMANDS.has(command) && reachesPerson(command, args) && Boolean(env.CODEX_THREAD_ID) && !env.OPENMSG_LOCAL;
}

// It gives null when no gateway answers. Then the command runs here, and it can
// still work in a session with no sandbox.
export async function ask(args, { env = process.env, timeoutMs = RUN_TIMEOUT_MS + 5000 } = {}) {
  const { port } = settings();
  let key;
  try {
    key = fs.readFileSync(keyFile(), "utf8").trim();
  } catch {
    return null;
  }
  if (!port || !key) return null;
  let res;
  try {
    res = await fetch(`http://127.0.0.1:${port}${LOCAL_PATH}`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ args, thread: env.CODEX_THREAD_ID }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    if (NOT_REACHED.has(e.cause?.code)) return null;
    // The gateway took the request, so the message can have left. A second try
    // here would send it again under another id.
    throw new Error(`the gateway did not finish: ${e.cause?.code ?? e.message}. The message can have left. Run: openmsg outbox`);
  }
  // A gateway of an older version has no such path.
  if (res.status === 404) return null;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`the gateway refused the command: ${body.error ?? res.status}`);
  return body;
}

export function isLoopbackAddress(address) {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function sameKey(given, key) {
  const a = Buffer.from(String(given));
  const b = Buffer.from(key);
  return b.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

// The answer of the gateway to one request. No shell runs here: the text of a
// message stays one argument.
export async function handle(req, body, { key = ensureKey(), cli = CLI } = {}) {
  if (!isLoopbackAddress(req.socket.remoteAddress)) return { code: 403, body: { error: "this path is for this machine" } };
  if (!sameKey((req.headers.authorization ?? "").replace(/^Bearer /, ""), key)) {
    return { code: 401, body: { error: "the key is wrong" } };
  }
  const { args, thread } = body ?? {};
  if (!Array.isArray(args) || args.length === 0 || !args.every((a) => typeof a === "string")) {
    return { code: 400, body: { error: "args must be a list of strings" } };
  }
  if (!COMMANDS.has(args[0])) return { code: 403, body: { error: `the gateway does not run ${args[0]}` } };
  if (typeof thread !== "string" || !THREAD_ID.test(thread)) return { code: 400, body: { error: "the thread id is not valid" } };
  if (!reachesPerson(args[0], args.slice(1))) {
    return { code: 403, body: { error: "the gateway sends only to a person, as <agent>@<owner>" } };
  }
  return { code: 200, body: await run(args, thread, cli) };
}

function run(args, thread, cli) {
  const env = { ...process.env, CODEX_THREAD_ID: thread, OPENMSG_LOCAL: "1" };
  for (const name of ["OPENMSG_SELF", "CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_MESSAGING_TOKEN"]) delete env[name];
  return new Promise((resolve) => {
    // The working directory of the gateway can be a project that a sandbox writes
    // to, and a program there must not run with the rights of the gateway.
    const child = spawn(process.execPath, ["--no-deprecation", cli, ...args], {
      env,
      cwd: home(),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      timeout: RUN_TIMEOUT_MS,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => resolve({ code: 1, stdout, stderr: `${stderr}${e.message}\n` }));
    child.on("close", (code, signal) => {
      if (signal) stderr += "openmsg: the command ran too long. The message can have left. Run: openmsg outbox\n";
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}
