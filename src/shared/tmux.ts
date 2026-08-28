import { execFile } from "node:child_process"
import { randomBytes } from "node:crypto"
import { promisify } from "node:util"
import type { Placement } from "./protocol.ts"
const execFileAsync = promisify(execFile)

export interface TmuxTarget {
  paneId: string
  placement: Placement
  windowId?: string
}
export type TmuxExec = (args: string[], input?: string) => Promise<string>

export const tmuxExec: TmuxExec = async (args, input) => {
  if (input === undefined) return (await execFileAsync("tmux", args)).stdout.trim()
  const child = execFile("tmux", args)
  child.stdin?.end(input)
  return await new Promise<string>((resolve, reject) => {
    let stdout = "",
      stderr = ""
    child.stdout?.on("data", (data) => (stdout += data))
    child.stderr?.on("data", (data) => (stderr += data))
    child.on("error", reject)
    child.on("close", (code) =>
      code === 0
        ? resolve(stdout.trim())
        : reject(new Error(stderr.trim() || `tmux exited ${code}`)),
    )
  })
}

function safeWindowName(name: string): string {
  return name.replace(/[^A-Za-z0-9_.-]+/g, "-").slice(0, 30) || "subagent"
}

export function subaWindowName(name: string): string {
  const safe = safeWindowName(name)
  if (safe === "suba" || safe.startsWith("suba-")) return safe
  return safeWindowName(`suba-${safe}`)
}

async function pinWindowName(target: string, name: string, run: TmuxExec): Promise<void> {
  await run(["set-option", "-w", "-t", target, "automatic-rename", "off"])
  await run(["set-option", "-w", "-t", target, "allow-rename", "off"])
  await run(["rename-window", "-t", target, name])
}

let splitQueue = Promise.resolve()
let sharedWindowQueue = Promise.resolve()

async function withQueue<T>(queue: "split" | "shared", action: () => Promise<T>): Promise<T> {
  const previous = queue === "split" ? splitQueue : sharedWindowQueue
  let release = () => {}
  const next = new Promise<void>((resolve) => {
    release = resolve
  })
  if (queue === "split") splitQueue = next
  else sharedWindowQueue = next
  await previous
  try {
    return await action()
  } finally {
    release()
  }
}

async function findWindow(
  sessionId: string,
  name: string,
  run: TmuxExec,
): Promise<string | undefined> {
  const windows = await run(["list-windows", "-t", sessionId, "-F", "#{window_id}\t#{window_name}"])
  for (const line of windows.split("\n")) {
    const separator = line.indexOf("\t")
    if (separator > 0 && line.slice(separator + 1) === name) return line.slice(0, separator)
  }
  return undefined
}

export async function createTarget(
  placement: Placement,
  parentPane: string,
  command: string,
  displayName: string,
  sharedDefault: string,
  run = tmuxExec,
): Promise<TmuxTarget> {
  if (placement.type === "split") {
    return withQueue("split", async () => {
      const windowId = await run(["display-message", "-p", "-t", parentPane, "#{window_id}"])
      const panes = await run([
        "list-panes",
        "-t",
        windowId,
        "-F",
        "#{pane_id}\t#{pane_top}\t#{@suba-parent-pane}",
      ])
      const children = panes.split("\n").flatMap((line) => {
        const [paneId, top, owner] = line.split("\t")
        return paneId && owner === parentPane ? [{ paneId, top: Number(top) }] : []
      })
      const bottom = children.reduce<{ paneId: string; top: number } | undefined>(
        (candidate, pane) => (!candidate || pane.top > candidate.top ? pane : candidate),
        undefined,
      )
      const paneId = await run([
        "split-window",
        bottom ? "-v" : "-h",
        "-d",
        "-P",
        "-F",
        "#{pane_id}",
        "-t",
        bottom?.paneId ?? parentPane,
        command,
      ])
      await run(["set-option", "-p", "-t", paneId, "@suba-parent-pane", parentPane])
      return { paneId, placement }
    })
  }
  if (placement.type === "window") {
    const windowName = subaWindowName(displayName)
    const sessionId = await run(["display-message", "-p", "-t", parentPane, "#{session_id}"])
    const paneId = await run([
      "new-window",
      "-d",
      "-P",
      "-F",
      "#{pane_id}",
      "-n",
      windowName,
      "-t",
      sessionId,
      command,
    ])
    await pinWindowName(paneId, windowName, run)
    return { paneId, placement }
  }
  return withQueue("shared", async () => {
    const windowName = subaWindowName(placement.windowName ?? sharedDefault)
    const sessionId = await run(["display-message", "-p", "-t", parentPane, "#{session_id}"])
    let windowId = await findWindow(sessionId, windowName, run)
    let paneId: string
    if (!windowId) {
      paneId = await run([
        "new-window",
        "-d",
        "-P",
        "-F",
        "#{pane_id}",
        "-n",
        windowName,
        "-t",
        sessionId,
        command,
      ])
      await pinWindowName(paneId, windowName, run)
      windowId = await run(["display-message", "-p", "-t", paneId, "#{window_id}"])
    } else {
      paneId = await run(["split-window", "-d", "-P", "-F", "#{pane_id}", "-t", windowId, command])
      await run(["select-layout", "-t", windowId, "tiled"])
    }
    return { paneId, placement, windowId }
  })
}

export async function paneExists(paneId: string, run = tmuxExec): Promise<boolean> {
  try {
    return (await run(["display-message", "-p", "-t", paneId, "#{pane_id}"])) === paneId
  } catch {
    return false
  }
}

export async function sendToPane(paneId: string, message: string, run = tmuxExec): Promise<void> {
  if (!message.includes("\n")) {
    await run(["send-keys", "-t", paneId, "-l", message])
    await run(["send-keys", "-t", paneId, "Enter"])
    return
  }
  const buffer = `suba-${randomBytes(8).toString("hex")}`
  await run(["load-buffer", "-b", buffer, "-"], message)
  await run(["paste-buffer", "-t", paneId, "-b", buffer, "-p", "-d"])
  await new Promise((resolve) => setTimeout(resolve, 100))
  await run(["send-keys", "-t", paneId, "Enter"])
}
