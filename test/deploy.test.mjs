// Tests for the scripts of deploy/relay. Shell functions stand in for pct, qm, and
// ping, so no test touches a Proxmox host.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { onPath } from "../src/windows.mjs";

const SCRIPT = fileURLToPath(new URL("../deploy/relay/create-lxc.sh", import.meta.url)).replaceAll("\\", "/");
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "openmsg-deploy-"));
after(() => fs.rmSync(WORK, { recursive: true, force: true, maxRetries: 5 }));

// Git for Windows keeps git.exe in cmd, or in mingw64\bin, and its shell in bin.
function findShell() {
  if (process.platform !== "win32") return "/bin/sh";
  const git = onPath("git.exe");
  const near = git ? [path.resolve(git, "../../bin/sh.exe"), path.resolve(git, "../../../bin/sh.exe")] : [];
  return near.find((file) => fs.existsSync(file)) ?? onPath("sh.exe");
}

function usable(shell) {
  if (!shell || !fs.existsSync(shell)) return false;
  return spawnSync(shell, ["-c", "exit 0"], { stdio: "ignore", timeout: 10_000 }).status === 0;
}

const SHELL = findShell();
const NO_SHELL = usable(SHELL) ? false : "no POSIX shell runs here";

// The arguments of each call of pct go to a file, in the order of the calls.
function run(name, { status = 1, create = 0, start = 0 } = {}) {
  const dir = path.join(WORK, name);
  fs.mkdirSync(dir);
  const stubs = `
    pct() {
      echo "pct $*" >> calls.log
      case "$1" in
        status) return ${status} ;;
        create) return ${create} ;;
        start) return ${start} ;;
      esac
    }
    qm() { return 1; }
    ping() { return 1; }
  `;
  fs.writeFileSync(path.join(dir, "stubs.sh"), stubs);
  const r = spawnSync(SHELL, ["-c", `. ./stubs.sh; set -- 209 192.0.2.9 192.0.2.1 main; . "${SCRIPT}"`], {
    cwd: dir,
    encoding: "utf8",
    timeout: 15_000,
  });
  const calls = fs.existsSync(path.join(dir, "calls.log")) ? fs.readFileSync(path.join(dir, "calls.log"), "utf8") : "";
  return { status: r.status, calls };
}

test("a create that fails leaves the id to its owner", { skip: NO_SHELL }, () => {
  const { status, calls } = run("create-fails", { create: 1 });
  assert.notEqual(status, 0);
  assert.match(calls, /^pct create 209/m);
  assert.doesNotMatch(calls, /^pct (stop|destroy)/m);
});

test("a run that fails after its create removes its own container", { skip: NO_SHELL }, () => {
  const { status, calls } = run("start-fails", { start: 1 });
  assert.notEqual(status, 0);
  assert.match(calls, /^pct stop 209/m);
  assert.match(calls, /^pct destroy 209 --purge/m);
});

test("an id that is in use stops the run before the create", { skip: NO_SHELL }, () => {
  const { status, calls } = run("in-use", { status: 0 });
  assert.notEqual(status, 0);
  assert.doesNotMatch(calls, /^pct (create|stop|destroy)/m);
});
