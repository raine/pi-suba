import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"
import { agentDirectory, subaDirectory } from "./paths.ts"
import { THINKING_LEVELS, type ThinkingLevel } from "./protocol.ts"

export interface SubaConfig {
  defaultProfile: string
  model?: string
  thinking?: ThinkingLevel
  autoComplete: boolean
  childExtensions: string[]
  childTools: string[]
  activity: { pollMs: number; maxRows: number }
}

export const DEFAULT_CONFIG: SubaConfig = {
  defaultProfile: "default",
  autoComplete: true,
  childExtensions: [],
  childTools: [],
  activity: { pollMs: 500, maxRows: 8 },
}

const ROOT_KEYS = new Set([
  "defaultProfile",
  "model",
  "thinking",
  "autoComplete",
  "childExtensions",
  "childTools",
  "activity",
  // Obsolete layout keys are accepted but never read or returned.
  "placement",
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

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
  const result = value.map((item, index) => string(item, `${label}[${index}]`).trim())
  if (new Set(result).size !== result.length)
    throw new Error(`${label} must not contain duplicates`)
  return result
}

function toolNames(value: unknown, label: string): string[] {
  const result = stringArray(value, label)
  for (const [index, name] of result.entries())
    if (name.includes(",") || /\s/.test(name))
      throw new Error(`${label}[${index}] must be a single tool name`)
  return result
}

export function resolveChildExtensionSource(source: string, agentDir = agentDirectory()): string {
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
    autoComplete:
      input.autoComplete === undefined
        ? DEFAULT_CONFIG.autoComplete
        : boolean(input.autoComplete, "autoComplete"),
    childExtensions:
      input.childExtensions === undefined
        ? [...DEFAULT_CONFIG.childExtensions]
        : stringArray(input.childExtensions, "childExtensions"),
    childTools:
      input.childTools === undefined
        ? [...DEFAULT_CONFIG.childTools]
        : toolNames(input.childTools, "childTools"),
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
  }
}

export async function loadConfig(path = join(subaDirectory(), "config.json")): Promise<SubaConfig> {
  try {
    return parseConfig(JSON.parse(await readFile(path, "utf8")))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return structuredClone(DEFAULT_CONFIG)
    throw new Error(
      `Cannot load ${path}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}
