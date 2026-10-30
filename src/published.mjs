// The sessions that this owner publishes. The default is that nothing is
// published, and a session reaches the network only after `openmsg publish`.
//
// The epoch belongs to the alias. A name can move to a new session, and the
// epoch counts that move. A message for an old epoch is refused, so a message
// never lands in a session that took the name later.
import fs from "node:fs";
import path from "node:path";
import { home } from "./identity.mjs";

function file() {
  return path.join(home(), "published.json");
}

export function read() {
  try {
    return JSON.parse(fs.readFileSync(file(), "utf8"));
  } catch {
    return { version: 2, projects: {} };
  }
}

function save(data) {
  const target = file();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1) + "\n");
  fs.renameSync(tmp, target);
}

export function aliasOf(agent) {
  return `${agent.vendor}:${agent.name ?? agent.id}`;
}

// On native Windows, the gateway reaches a Claude session with the token of that
// session. Claude Code then treats the gateway as a child of the session, and it
// applies no hold to the message, also in a session that bypasses permission
// prompts. The gateway cannot see the mode of a session. So the owner says yes for
// each session, and the record keeps the answer. Section 7 of the 0.1 spec says
// more.
export function skipsHoldGate(vendor, platform = process.platform) {
  return vendor === "claude" && platform === "win32";
}

// A row from an earlier version, or from another system, can lack the answer.
export function reachable(row, platform = process.platform) {
  return !skipsHoldGate(row.vendor, platform) || row.skipHoldGate === true;
}

export function publish(projectId, agent, { skipHoldGate = false, platform = process.platform } = {}) {
  const skips = skipsHoldGate(agent.vendor, platform);
  const alias = aliasOf(agent);
  if (skips && !skipHoldGate) {
    throw new Error(
      `${alias} is a Claude session on native Windows, so it skips the hold gate of Claude Code. ` +
        "A person that you accepted can reach it with no hold, also if it bypasses permission prompts. " +
        "If you accept that, run the command again with --skip-hold-gate",
    );
  }
  const data = read();
  const project = data.projects[projectId] ?? {};
  const before = project[alias];
  const record = {
    alias,
    vendor: agent.vendor,
    name: agent.name ?? agent.id,
    session: agent.id,
    // A new session under one name is a new epoch.
    epoch: before && before.session !== agent.id ? before.epoch + 1 : (before?.epoch ?? 1),
    publishedAt: new Date().toISOString(),
    ...(skips ? { skipHoldGate: true } : {}),
  };
  project[alias] = record;
  data.projects[projectId] = project;
  save(data);
  return record;
}

export function unpublish(projectId, alias) {
  const data = read();
  const project = data.projects[projectId];
  if (!project?.[alias]) return null;
  const gone = project[alias];
  delete project[alias];
  save(data);
  return gone;
}

export function list(projectId = null) {
  const data = read();
  const out = [];
  for (const [id, project] of Object.entries(data.projects)) {
    if (projectId && id !== projectId) continue;
    for (const record of Object.values(project)) out.push({ project: id, ...record });
  }
  return out;
}

// One session id can exist under two vendors, so `vendor` narrows the search.
export function find(projectId, { alias = null, session = null, vendor = null }) {
  return (
    list(projectId).find(
      (r) => (alias ? r.alias === alias : true) && (session ? r.session === session : true) && (vendor ? r.vendor === vendor : true),
    ) ?? null
  );
}
