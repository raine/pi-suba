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

interface PaneGeometry {
  paneId: string
  left: number
  top: number
  width: number
  height: number
  role: string
}

interface LayoutRect {
  width: number
  height: number
  left: number
  top: number
}

interface LayoutNode {
  rect: LayoutRect
  paneId?: number
  split?: "horizontal" | "vertical"
  children?: LayoutNode[]
}

function distribute(total: number, count: number): number[] {
  const available = total - Math.max(0, count - 1)
  const size = Math.floor(available / count)
  return Array.from({ length: count }, (_, index) =>
    index === count - 1 ? available - size * (count - 1) : size,
  )
}

function gridLayout(panes: PaneGeometry[], rect: LayoutRect): LayoutNode {
  const rowCount = Math.ceil(Math.sqrt(panes.length))
  const columnCount = Math.ceil(panes.length / rowCount)
  const rowHeights = distribute(rect.height, rowCount)
  const rows: LayoutNode[] = []
  let paneIndex = 0
  let top = rect.top
  for (let rowIndex = 0; rowIndex < rowCount; rowIndex++) {
    const count = Math.min(columnCount, panes.length - paneIndex)
    const widths = distribute(rect.width, count)
    const children: LayoutNode[] = []
    let left = rect.left
    for (const width of widths) {
      const pane = panes[paneIndex++]!
      children.push({
        rect: { width, height: rowHeights[rowIndex]!, left, top },
        paneId: Number(pane.paneId.slice(1)),
      })
      left += width + 1
    }
    const rowRect = { width: rect.width, height: rowHeights[rowIndex]!, left: rect.left, top }
    rows.push(
      children.length === 1 ? children[0]! : { rect: rowRect, split: "horizontal", children },
    )
    top += rowHeights[rowIndex]! + 1
  }
  return rows.length === 1 ? rows[0]! : { rect, split: "vertical", children: rows }
}

function serializeLayoutNode(node: LayoutNode): string {
  const { width, height, left, top } = node.rect
  const prefix = `${width}x${height},${left},${top}`
  if (node.paneId !== undefined) return `${prefix},${node.paneId}`
  const brackets = node.split === "horizontal" ? ["{", "}"] : ["[", "]"]
  return `${prefix}${brackets[0]}${node.children!.map(serializeLayoutNode).join(",")}${brackets[1]}`
}

function layoutChecksum(layout: string): string {
  let checksum = 0
  for (const byte of Buffer.from(layout)) {
    checksum = ((checksum >> 1) | ((checksum & 1) << 15)) + byte
    checksum &= 0xffff
  }
  return checksum.toString(16).padStart(4, "0")
}

async function equalizeSplitHeights(
  windowId: string,
  parentPane: string,
  run: TmuxExec,
): Promise<void> {
  const panes = await run([
    "list-panes",
    "-t",
    windowId,
    "-F",
    "#{pane_id}\t#{pane_top}\t#{pane_height}\t#{@suba-parent-pane}",
  ])
  const children = panes
    .split("\n")
    .flatMap((line) => {
      const [paneId, top, height, owner] = line.split("\t")
      return paneId && owner === parentPane
        ? [{ paneId, top: Number(top), height: Number(height) }]
        : []
    })
    .sort((left, right) => left.top - right.top)
  if (children.length < 2) return
  const height = Math.floor(
    children.reduce((total, child) => total + child.height, 0) / children.length,
  )
  for (const child of children.slice(0, -1))
    await run(["resize-pane", "-t", child.paneId, "-y", String(height)])
}

async function sharedWindowPanes(windowId: string, run: TmuxExec): Promise<PaneGeometry[]> {
  const panes = await run([
    "list-panes",
    "-t",
    windowId,
    "-F",
    "#{pane_id}\t#{pane_left}\t#{pane_top}\t#{pane_width}\t#{pane_height}\t#{@workmux_role}",
  ])
  return panes.split("\n").flatMap((line) => {
    const [paneId, left, top, width, height, role = ""] = line.split("\t")
    return paneId
      ? [
          {
            paneId,
            left: Number(left),
            top: Number(top),
            width: Number(width),
            height: Number(height),
            role,
          },
        ]
      : []
  })
}

export async function applySharedWindowGrid(windowId: string, run = tmuxExec): Promise<void> {
  const panes = await sharedWindowPanes(windowId, run)
  const agents = panes.filter((pane) => pane.role !== "sidebar")
  if (!agents.length) return
  const [windowWidth, windowHeight] = (
    await run(["display-message", "-p", "-t", windowId, "#{window_width}\t#{window_height}"])
  )
    .split("\t")
    .map(Number)
  const sidebar = panes.find((pane) => pane.role === "sidebar")
  let contentRect = { width: windowWidth!, height: windowHeight!, left: 0, top: 0 }
  let root: LayoutNode
  if (sidebar && sidebar.left === 0 && sidebar.width < windowWidth!) {
    const sidebarRect = { width: sidebar.width, height: windowHeight!, left: 0, top: 0 }
    contentRect = {
      width: windowWidth! - sidebar.width - 1,
      height: windowHeight!,
      left: sidebar.width + 1,
      top: 0,
    }
    root = {
      rect: { width: windowWidth!, height: windowHeight!, left: 0, top: 0 },
      split: "horizontal",
      children: [
        { rect: sidebarRect, paneId: Number(sidebar.paneId.slice(1)) },
        gridLayout(agents, contentRect),
      ],
    }
  } else if (sidebar && sidebar.top === 0 && sidebar.height < windowHeight!) {
    const sidebarRect = { width: windowWidth!, height: sidebar.height, left: 0, top: 0 }
    contentRect = {
      width: windowWidth!,
      height: windowHeight! - sidebar.height - 1,
      left: 0,
      top: sidebar.height + 1,
    }
    root = {
      rect: { width: windowWidth!, height: windowHeight!, left: 0, top: 0 },
      split: "vertical",
      children: [
        { rect: sidebarRect, paneId: Number(sidebar.paneId.slice(1)) },
        gridLayout(agents, contentRect),
      ],
    }
  } else {
    root = gridLayout(agents, contentRect)
  }
  const body = serializeLayoutNode(root)
  await run(["select-layout", "-t", windowId, `${layoutChecksum(body)},${body}`])
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
      await equalizeSplitHeights(windowId, parentPane, run)
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
      const panes = await sharedWindowPanes(windowId, run)
      const targetPane = panes.find((pane) => pane.role !== "sidebar")?.paneId
      paneId = await run([
        "split-window",
        "-v",
        "-d",
        "-P",
        "-F",
        "#{pane_id}",
        "-t",
        targetPane ?? windowId,
        command,
      ])
      await applySharedWindowGrid(windowId, run)
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
