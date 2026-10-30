// Native Windows asks each connection to a Claude Code session for the token of
// that session, and it drops a connection without one. Claude Code gives the
// token only to the hooks and the commands of that session. The gateway is
// another process, so a hook of the session writes the token here.
//
// A token lets a process deliver into one session. This directory holds what the
// user can already read, in the same trust boundary: the same OS user.
// Source: https://code.claude.com/docs/en/cross-session-messaging
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// The home reads from the environment at each call, as in selfregistry.mjs.
function dir() {
  return path.join(process.env.OPENMSG_HOME ?? path.join(os.homedir(), ".openmsg"), "claude-tokens");
}

function fileOf(id) {
  return path.join(dir(), `${id}.json`.replace(/[^A-Za-z0-9._-]/g, "_"));
}

// A session that has not started for this long holds a dead token.
export const MAX_AGE_MS = 14 * 24 * 3600 * 1000;

function prune(now) {
  for (const f of fs.readdirSync(dir())) {
    const full = path.join(dir(), f);
    try {
      if (now - fs.statSync(full).mtimeMs > MAX_AGE_MS) fs.rmSync(full, { force: true });
    } catch {
      // Another hook can take the same file away. Nothing depends on it.
    }
  }
}

export function put({ id, socket, token, now = Date.now() }) {
  fs.mkdirSync(dir(), { recursive: true, mode: 0o700 });
  prune(now);
  fs.writeFileSync(fileOf(id), JSON.stringify({ id, socket, token }), { mode: 0o600 });
}

// The token holds for one socket. A session that restarted on a new socket has
// a new token, so an old record gives nothing.
export function tokenFor(agent) {
  try {
    const rec = JSON.parse(fs.readFileSync(fileOf(agent.id), "utf8"));
    return rec.socket === agent.transport?.path ? rec.token : null;
  } catch {
    return null;
  }
}
