import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import type { Placement } from "./protocol.ts";
const execFileAsync = promisify(execFile);

export interface TmuxTarget { paneId: string; placement: Placement; windowId?: string }
export type TmuxExec = (args: string[], input?: string) => Promise<string>;

export const tmuxExec: TmuxExec = async (args, input) => {
  if (input === undefined) return (await execFileAsync("tmux", args)).stdout.trim();
  const child = execFile("tmux", args);
  child.stdin?.end(input);
  return await new Promise<string>((resolve, reject) => {
    let stdout = "", stderr = "";
    child.stdout?.on("data", (data) => stdout += data);
    child.stderr?.on("data", (data) => stderr += data);
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr.trim() || `tmux exited ${code}`)));
  });
};

function safeWindowName(name: string): string { return name.replace(/[^A-Za-z0-9_.-]+/g, "-").slice(0, 30) || "subagent"; }

export async function createTarget(placement: Placement, parentPane: string, command: string, displayName: string, sharedDefault: string, run = tmuxExec): Promise<TmuxTarget> {
  if (placement.type === "split") {
    const geometry = await run(["display-message", "-p", "-t", parentPane, "#{pane_width} #{pane_height}"]);
    const [width, height] = geometry.split(" ").map(Number);
    const orientation = width >= height * 2 ? "-h" : "-v";
    const paneId = await run(["split-window", orientation, "-d", "-P", "-F", "#{pane_id}", "-t", parentPane, command]);
    return { paneId, placement };
  }
  if (placement.type === "window") {
    const paneId = await run(["new-window", "-d", "-P", "-F", "#{pane_id}", "-n", safeWindowName(placement.windowName ?? displayName), command]);
    return { paneId, placement };
  }
  const windowName = safeWindowName(placement.windowName ?? sharedDefault);
  let windowId = "";
  try { windowId = await run(["display-message", "-p", "-t", `:${windowName}`, "#{window_id}"]); } catch { /* create below */ }
  let paneId: string;
  if (!windowId) {
    paneId = await run(["new-window", "-d", "-P", "-F", "#{pane_id}", "-n", windowName, command]);
    windowId = await run(["display-message", "-p", "-t", paneId, "#{window_id}"]);
  } else {
    paneId = await run(["split-window", "-d", "-P", "-F", "#{pane_id}", "-t", windowId, command]);
    await run(["select-layout", "-t", windowId, "tiled"]);
  }
  return { paneId, placement, windowId };
}

export async function paneExists(paneId: string, run = tmuxExec): Promise<boolean> {
  try { return (await run(["display-message", "-p", "-t", paneId, "#{pane_id}"])) === paneId; } catch { return false; }
}

export async function sendToPane(paneId: string, message: string, run = tmuxExec): Promise<void> {
  if (!message.includes("\n")) {
    await run(["send-keys", "-t", paneId, "-l", message]);
    await run(["send-keys", "-t", paneId, "Enter"]);
    return;
  }
  const buffer = `suba-${randomBytes(8).toString("hex")}`;
  await run(["load-buffer", "-b", buffer, "-"], message);
  await run(["paste-buffer", "-t", paneId, "-b", buffer, "-p", "-d"]);
  await new Promise((resolve) => setTimeout(resolve, 100));
  await run(["send-keys", "-t", paneId, "Enter"]);
}
