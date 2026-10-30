// Two facts of native Windows that other modules need.
//
// A bare program name in a call searches the working directory first, so a file
// in a project can run in place of a system tool (CWE-427). A system tool goes by
// its full path here, and any other tool by a full path from the PATH.
//
// Windows ignores the mode of a file, so `mode: 0o600` protects nothing there. A
// directory with a secret gets an access list with one user.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export function system32(...parts) {
  return path.win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", ...parts);
}

// It gives the full path of a program, or null. A relative entry of the PATH
// means the working directory, so it does not count.
export function onPath(name, env = process.env) {
  for (const dir of (env.PATH ?? env.Path ?? "").split(path.win32.delimiter).filter(Boolean)) {
    if (!path.win32.isAbsolute(dir)) continue;
    const file = path.win32.join(dir, name);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

// The list goes by the security id, because a name can mean a local account and
// a domain account. The grant comes first: a failed grant leaves the directory as
// it was, and the owner keeps access.
//
// It gives false when it did nothing. The inherited list of a home directory is
// already private on a normal machine, so a failure stops nothing.
export function lockDown(dir, { platform = process.platform } = {}) {
  if (platform !== "win32" || !fs.existsSync(dir)) return false;
  const quiet = { stdio: ["ignore", "pipe", "ignore"], windowsHide: true, timeout: 10_000 };
  try {
    const row = execFileSync(system32("whoami.exe"), ["/user", "/fo", "csv", "/nh"], { ...quiet, encoding: "utf8" });
    const sid = row.match(/S-1-[0-9-]+/)?.[0];
    if (!sid) return false;
    execFileSync(system32("icacls.exe"), [dir, "/grant:r", `*${sid}:(OI)(CI)F`], quiet);
    execFileSync(system32("icacls.exe"), [dir, "/inheritance:r"], quiet);
    return true;
  } catch {
    return false;
  }
}
