// `openmsg gateway install` keeps the gateway running on native Windows. The
// entry goes in the Run key of the user, because a scheduled task at logon needs
// an administrator on many machines. A small script runs the gateway with no
// window, and it starts the gateway again after a stop.
//
// macOS and Linux have launchd and systemd for this job.
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const VALUE = "openmsg-gateway";

function home() {
  return process.env.OPENMSG_HOME ?? path.join(os.homedir(), ".openmsg");
}

export function paths() {
  return { launcher: path.join(home(), "gateway.vbs"), log: path.join(home(), "gateway.log") };
}

// VBScript writes one quote in a string as two quotes.
export function launcherScript({ node, cli, log, openmsgHome = null }) {
  const line = `cmd /c ""${node}" "${cli}" gateway start >> "${log}" 2>&1"`;
  const vbs = (s) => `"${s.replaceAll('"', '""')}"`;
  return [
    'Set shell = CreateObject("WScript.Shell")',
    ...(openmsgHome ? [`shell.Environment("Process")("OPENMSG_HOME") = ${vbs(openmsgHome)}`] : []),
    "Do",
    `  shell.Run ${vbs(line)}, 0, True`,
    "  WScript.Sleep 5000",
    "Loop",
    "",
  ].join("\r\n");
}

export function runCommand(launcher) {
  return `wscript.exe //B "${launcher}"`;
}

function needWindows() {
  if (process.platform !== "win32") {
    throw new Error("this command is for Windows. On macOS use launchd, and on Linux use systemd");
  }
}

export async function install(cli) {
  needWindows();
  const { launcher, log } = paths();
  fs.mkdirSync(path.dirname(launcher), { recursive: true });
  const script = launcherScript({ node: process.execPath, cli, log, openmsgHome: process.env.OPENMSG_HOME ?? null });
  fs.writeFileSync(launcher, script);
  await run("reg.exe", ["add", RUN_KEY, "/v", VALUE, "/t", "REG_SZ", "/d", runCommand(launcher), "/f"], { windowsHide: true });
  return { launcher, log };
}

export async function uninstall() {
  needWindows();
  const { launcher } = paths();
  await run("reg.exe", ["delete", RUN_KEY, "/v", VALUE, "/f"], { windowsHide: true }).catch(() => {});
  fs.rmSync(launcher, { force: true });
  return { launcher };
}
