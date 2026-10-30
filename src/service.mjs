// `openmsg gateway install` keeps the gateway running on native Windows. The
// entry goes in the Run key of the user, because a scheduled task at logon needs
// an administrator on many machines. A small script runs the gateway with no
// window, and it starts the gateway again after a stop.
//
// `openmsg gateway stop` writes one small file. The gateway looks for that file
// and it ends, and the script sees the same file and ends too. Without the file,
// the script would start the gateway again five seconds later.
//
// macOS and Linux have launchd and systemd for the restart, and `gateway stop`
// works there too.
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { system32 } from "./windows.mjs";

const run = promisify(execFile);
const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const VALUE = "openmsg-gateway";
const STOP_TIMEOUT_MS = 8000;
export const LOG_MAX_BYTES = 5 * 1024 * 1024;

function home() {
  return process.env.OPENMSG_HOME ?? path.join(os.homedir(), ".openmsg");
}

export function paths() {
  return {
    launcher: path.join(home(), "gateway.vbs"),
    log: path.join(home(), "gateway.log"),
    stop: path.join(home(), "gateway.stop"),
    lock: path.join(home(), "gateway.lock"),
  };
}

// VBScript writes one quote in a string as two quotes. The script runs node
// directly, with no `cmd /c`, so no shell reads a path.
//
// One script runs for one owner. A second script would start the gateway again
// after a stop, so it ends at once. A stop file that is older than this script
// belongs to no one, so it goes first. A failure to start node goes to the log,
// because this process has no window.
export function launcherScript({ node, cli, log, stop, lock, openmsgHome = null, args = [] }) {
  const line = [`"${node}"`, `"${cli}"`, "gateway", "start", "--log", `"${log}"`, ...args].join(" ");
  const vbs = (s) => `"${s.replaceAll('"', '""')}"`;
  return [
    'Set shell = CreateObject("WScript.Shell")',
    'Set files = CreateObject("Scripting.FileSystemObject")',
    "On Error Resume Next",
    `Set held = files.OpenTextFile(${vbs(lock)}, 2, True)`,
    "If Err.Number <> 0 Then WScript.Quit",
    `If files.FileExists(${vbs(stop)}) Then files.DeleteFile ${vbs(stop)}`,
    ...(openmsgHome ? [`shell.Environment("Process")("OPENMSG_HOME") = ${vbs(openmsgHome)}`] : []),
    `Do While Not files.FileExists(${vbs(stop)})`,
    "  Err.Clear",
    `  shell.Run ${vbs(line)}, 0, True`,
    "  If Err.Number <> 0 Then",
    "    message = Err.Description",
    "    Err.Clear",
    `    Set out = files.OpenTextFile(${vbs(log)}, 8, True)`,
    '    out.WriteLine "the launcher could not start node: " & message',
    "    out.Close",
    "  End If",
    `  If Not files.FileExists(${vbs(stop)}) Then WScript.Sleep 5000`,
    "Loop",
    `files.DeleteFile ${vbs(stop)}`,
    "",
  ].join("\r\n");
}

// Windows reads a script with no mark in the code page of the system, so a path
// with other characters breaks. UTF-16 with a byte order mark holds every path.
export function writeLauncher(file, script) {
  fs.writeFileSync(file, `﻿${script}`, "utf16le");
}

export function runCommand(launcher) {
  return `"${system32("wscript.exe")}" //B "${launcher}"`;
}

// These values go into a line of the script, so each one has a strict shape.
export function startArgs({ host = null, port = null, relay = null } = {}) {
  const out = [];
  if (port !== null) {
    if (!/^\d{1,5}$/.test(port) || Number(port) > 65535) throw new Error(`--port takes a port number, and "${port}" is not one`);
    out.push("--port", port);
  }
  if (host !== null) {
    if (!/^[A-Za-z0-9.:_-]+$/.test(host)) throw new Error(`--host takes an address, and "${host}" is not one`);
    out.push("--host", host);
  }
  if (relay !== null) {
    if (!/^wss?:\/\/[A-Za-z0-9.:_/[\]-]+$/.test(relay)) throw new Error(`--relay takes a ws:// or wss:// address, and "${relay}" is not one`);
    out.push("--relay", relay);
  }
  return out;
}

function needWindows() {
  if (process.platform !== "win32") {
    throw new Error("this command is for Windows. On macOS use launchd, and on Linux use systemd");
  }
}

// A second install with other arguments must not run beside the first one.
export async function install(cli, { port = null, ...options } = {}) {
  needWindows();
  const { launcher, log, stop, lock } = paths();
  const args = startArgs({ port: options.givenPort ?? null, host: options.host ?? null, relay: options.relay ?? null });
  fs.mkdirSync(path.dirname(launcher), { recursive: true });
  const before = await stopGateway(port);
  if (before.running) await scriptEnded();
  writeLauncher(
    launcher,
    launcherScript({ node: process.execPath, cli, log, stop, lock, openmsgHome: process.env.OPENMSG_HOME ?? null, args }),
  );
  await run(system32("reg.exe"), ["add", RUN_KEY, "/v", VALUE, "/t", "REG_SZ", "/d", runCommand(launcher), "/f"], { windowsHide: true });
  return { launcher, log };
}

// The script removes the stop file as its last step, and then the lock is free.
async function scriptEnded({ timeoutMs = 2000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (fs.existsSync(paths().stop) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await new Promise((resolve) => setTimeout(resolve, 200));
}

// It asks the gateway of this owner to end, and it waits until the port is free.
// The next start removes the file, in the script and in the gateway.
export async function stopGateway(port, { timeoutMs = STOP_TIMEOUT_MS } = {}) {
  fs.mkdirSync(home(), { recursive: true });
  fs.writeFileSync(paths().stop, "");
  if (!port) return { stopped: true, running: false };
  const deadline = Date.now() + timeoutMs;
  let running = false;
  while (Date.now() < deadline) {
    try {
      await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) });
      running = true;
    } catch {
      return { stopped: true, running };
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return { stopped: false, running };
}

export async function uninstall({ port = null } = {}) {
  needWindows();
  const { launcher } = paths();
  await run(system32("reg.exe"), ["delete", RUN_KEY, "/v", VALUE, "/f"], { windowsHide: true }).catch(() => {});
  const out = await stopGateway(port);
  fs.rmSync(launcher, { force: true });
  return { launcher, ...out };
}

// A window of this process would give the operating system a place to write. A
// process with no window writes its own log, and one old copy stays.
export function logTo(file, { maxBytes = LOG_MAX_BYTES } = {}) {
  return (line) => {
    try {
      if (fs.statSync(file).size > maxBytes) fs.renameSync(file, `${file}.1`);
    } catch {
      // The first line of a new log has no file to measure.
    }
    fs.appendFileSync(file, `${line}\n`);
  };
}
