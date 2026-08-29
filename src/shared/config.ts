import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"
import { THINKING_LEVELS, type Placement, type ThinkingLevel } from "./protocol.ts"

export interface SubaConfig {
  defaultProfile: string
  model?: string
  thinking?: ThinkingLevel
  placement: Placement
  autoComplete: boolean
  childExtensions: string[]
  activity: { pollMs: number; maxRows: number }
  sharedWindowName: string
}

export const DEFAULT_CONFIG: SubaConfig = {
  defaultProfile: "default",
  placement: { type: "split" },
  autoComplete: true,
  childExtensions: [],
  activity: { pollMs: 500, maxRows: 8 },
  sharedWindowName: "suba",
}

const ROOT_KEYS = new Set([
  "defaultProfile",
  "model",
  "thinking",
  "placement",
  "autoComplete",
  "childExtensions",
  "activity",
  "sharedWindowName",
])

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}
function string(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${label} must be a non-empty string`)
  return value
}
function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`)
  return value
}
function integer(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}`)
  }
  return value as number
}

export function parsePlacement(value: unknown, label = "placement"): Placement {
  const input = object(value, label)
  for (const key of Object.keys(input))
    if (key !== "type" && key !== "windowName")
      throw new Error(`${label} has unsupported key: ${key}`)
  if (input.type !== "split" && input.type !== "window" && input.type !== "shared-window")
    throw new Error(`${label}.type is invalid`)
  if (input.type !== "shared-window" && input.windowName !== undefined)
    throw new Error(`${label}.windowName is valid only for shared-window placement`)
  if (input.type !== "shared-window") return { type: input.type }
  const windowName =
    input.windowName === undefined ? undefined : string(input.windowName, `${label}.windowName`)
  return windowName ? { type: input.type, windowName } : { type: input.type }
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
  const result = value.map((item, index) => string(item, `${label}[${index}]`).trim())
  if (new Set(result).size !== result.length)
    throw new Error(`${label} must not contain duplicates`)
  return result
}

export function resolveChildExtensionSource(
  source: string,
  agentDir = join(homedir(), ".pi", "agent"),
): string {
  if (source === "~") return homedir()
  if (source.startsWith("~/")) return resolve(homedir(), source.slice(2))
  if (isAbsolute(source)) return source
  if (source.startsWith(".")) return resolve(agentDir, source)
  return source
}

export function parseConfig(value: unknown): SubaConfig {
  const input = object(value, "configuration")
  for (const key of Object.keys(input))
    if (!ROOT_KEYS.has(key)) throw new Error(`configuration has unsupported key: ${key}`)
  const activityInput = input.activity === undefined ? {} : object(input.activity, "activity")
  for (const key of Object.keys(activityInput))
    if (!["pollMs", "maxRows"].includes(key))
      throw new Error(`activity has unsupported key: ${key}`)
  const thinking =
    input.thinking === undefined ? undefined : (string(input.thinking, "thinking") as ThinkingLevel)
  if (thinking && !THINKING_LEVELS.includes(thinking))
    throw new Error(`thinking is invalid: ${thinking}`)
  return {
    defaultProfile:
      input.defaultProfile === undefined
        ? DEFAULT_CONFIG.defaultProfile
        : string(input.defaultProfile, "defaultProfile"),
    model: input.model === undefined ? undefined : string(input.model, "model"),
    thinking,
    placement:
      input.placement === undefined ? DEFAULT_CONFIG.placement : parsePlacement(input.placement),
    autoComplete:
      input.autoComplete === undefined
        ? DEFAULT_CONFIG.autoComplete
        : boolean(input.autoComplete, "autoComplete"),
    childExtensions:
      input.childExtensions === undefined
        ? [...DEFAULT_CONFIG.childExtensions]
        : stringArray(input.childExtensions, "childExtensions"),
    activity: {
      pollMs:
        activityInput.pollMs === undefined
          ? DEFAULT_CONFIG.activity.pollMs
          : integer(activityInput.pollMs, "activity.pollMs", 100, 60_000),
      maxRows:
        activityInput.maxRows === undefined
          ? DEFAULT_CONFIG.activity.maxRows
          : integer(activityInput.maxRows, "activity.maxRows", 1, 100),
    },
    sharedWindowName:
      input.sharedWindowName === undefined
        ? DEFAULT_CONFIG.sharedWindowName
        : string(input.sharedWindowName, "sharedWindowName"),
  }
}

export async function loadConfig(
  path = join(homedir(), ".pi", "suba", "config.json"),
): Promise<SubaConfig> {
  try {
    return parseConfig(JSON.parse(await readFile(path, "utf8")))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return structuredClone(DEFAULT_CONFIG)
    throw new Error(
      `Cannot load ${path}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}
