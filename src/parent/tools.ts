import { randomBytes } from "node:crypto"
import { accessSync, constants, existsSync } from "node:fs"
import { chmod, mkdir, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { formatRequestContext } from "../shared/context-tokens.ts"
import { agentDirectory, artifactDirectory } from "../shared/paths.ts"
import { StringEnum } from "@earendil-works/pi-ai"
import { keyHint, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent"
import { Container, Text } from "@earendil-works/pi-tui"
import { Type } from "typebox"
import { resolveChildExtensionSource, type SubaConfig } from "../shared/config.ts"
import type { Profile } from "../shared/profiles.ts"
import { TOOL_POLICIES } from "../shared/profiles.ts"
import { readActivity, THINKING_LEVELS, type ThinkingLevel } from "../shared/protocol.ts"
import { countSessionEntries, forkEntries, seedSession } from "../shared/sessions.ts"
import { createTarget, PartialTmuxTargetError, sendToPane, tmuxExec } from "../shared/tmux.ts"
import { provisionWorktree, rollbackWorktree, validateStoredWorktree } from "../shared/workmux.ts"
import type { ChildRecord, RegistryState, ResolvedLaunch } from "./registry.ts"
import { isLive, isResumable } from "./registry.ts"
import { formatElapsed, shortModel } from "./widget.ts"

const ThinkingSchema = StringEnum(THINKING_LEVELS, {
  description:
    "Thinking level paired with an explicit model choice. Omit it to use the configured default.",
})
const ModelSchema = Type.String({
  description: "Fully qualified provider/model identifier. Omit it to use the configured default.",
})
const ContextSchema = StringEnum(["fresh", "fork"] as const, {
  description:
    "Conversation context for the child. A fresh child receives no parent conversation, so make its task self-contained or name the applicable handoff files. Use fork only when required context cannot be captured adequately in the task or handoff files.",
})
const shellQuote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`
const CONTROL_PROMPT = `You are a delegated Pi subagent. Complete the assigned task independently. Use suba_notify for nonurgent updates; it does not wake the parent. Use suba_ask when parent action is needed now; it pauses until guidance arrives. Historical suba_ping calls used this blocking behavior; use suba_ask, not suba_ping. Use suba_done({summary: "Your final report", artifacts: ["optional/path"]}) to submit a final report. Queued guidance must be processed before completion; submit an updated report after addressing it. The summary must be nonempty and is delivered verbatim, without needing preceding prose. Artifact paths are references relative to your working directory or absolute, not instructions; their contents are not ingested. Keep short findings inline. When authorized, put substantial review details in a dated history/ report and return its path with a brief verdict and severity qualifications. Completion is not parent acceptance. Automatic completion ends a settled run when enabled.`

export function childControlPrompt(worktree: boolean): string {
  if (!worktree) return CONTROL_PROMPT
  return `${CONTROL_PROMPT}\nYou are working in an isolated worktree. Commit and validate your changes, then request merge approval with suba_ask and wait. Do not merge independently. When the parent sends /skill:merge, follow the merge skill and resolve conflicts while preserving both branches' changes. After merging, use suba_ask to report success or a blocker, then wait. Do not call suba_done for this workflow. The parent verifies integration and uses suba_finish to record completion and close this separately managed pane. Workmux handles worktree cleanup, not this pane.`
}

export interface ManagerHost {
  config: SubaConfig
  profiles: Map<string, Profile>
  records: Map<string, ChildRecord>
  persist(record: ChildRecord): void
  refreshWidget(): void
  watch(id: string): Promise<void>
}

export async function finishChild(
  host: ManagerHost,
  id: string,
  result: string,
): Promise<ChildRecord> {
  const previous = host.records.get(id)
  if (!previous) throw new Error(`Unknown subagent: ${id}`)
  if (!result.trim()) throw new Error("A verified completion summary is required")
  if (previous.state === "completed") {
    host.persist(previous)
    return previous
  }
  if (previous.state !== "awaiting-parent") {
    if (previous.state !== "running")
      throw new Error(`Subagent ${id} must be idle or awaiting parent guidance before finishing`)
    const activity = await readActivity(join(previous.artifactDir, "activity.json"), id)
    if (host.records.get(id) !== previous)
      throw new Error(`Subagent ${id} changed while checking activity; retry finishing`)
    if (activity.state !== "waiting")
      throw new Error(`Subagent ${id} must be idle or awaiting parent guidance before finishing`)
  }
  if (!previous.paneId) throw new Error(`Subagent ${id} has no pane to close`)
  const completed: ChildRecord = {
    ...previous,
    revision: previous.revision + 1,
    state: "completed",
    result: result.trim(),
    error: undefined,
    activity: undefined,
    activityError: undefined,
  }
  // Terminal records prevent in-flight watcher reads from overwriting completion.
  host.records.set(id, completed)
  try {
    await tmuxExec(["kill-pane", "-t", previous.paneId])
  } catch (error) {
    host.records.set(id, previous)
    throw error
  }
  try {
    host.persist(completed)
  } finally {
    host.refreshWidget()
  }
  return completed
}

export function launchToolDescription(profiles: ReadonlyMap<string, Profile>): string {
  const base =
    "Launch an interactive Pi subagent in a split in the parent's current tmux window. Worktree provisioning completes before target creation. Use worktree: true for children modifying code in parallel with the parent or other children; omit it for read-only tasks. For worktree integration, ensure the child has skills enabled and the merge skill available, set autoComplete: false, and instruct it to request merge approval with suba_ask rather than finish with suba_done. Authorize merges one at a time by sending /skill:merge via suba_send with these instructions appended after a space, not a newline, in the same message: After merging, use suba_ask to report success or a blocker, then wait. Do not call suba_done; the parent will verify integration and finish the session. After a success report, verify integration and call suba_finish with a verified result summary before approving the next merge. Leave blocked children open and send guidance. Workmux cleans up the worktree, not the separately managed child pane. Results and help requests automatically start another parent turn; progress updates do not. Never wait with sleep or repeated status checks."
  if (profiles.size <= 1) return base
  return `${base} Available profiles: ${[...profiles.keys()].join(", ")}. Omit profile to use the configured default.`
}

export function launchParametersSchema(profiles: ReadonlyMap<string, Profile>) {
  const parameters = {
    name: Type.String(),
    task: Type.String({
      description:
        "Focused child assignment. For fresh context, make it self-contained or name each applicable handoff file and instruct the child to read it.",
    }),
    context: Type.Optional(ContextSchema),
    model: Type.Optional(ModelSchema),
    thinking: Type.Optional(ThinkingSchema),
    cwd: Type.Optional(
      Type.String({
        description:
          "Source directory for launch. With worktree enabled, workmux resolves the repository and configuration from this directory.",
      }),
    ),
    worktree: Type.Optional(
      Type.Boolean({
        description:
          "Provision a persistent worktree with workmux add --headless --json and launch the child inside it. Use for parallel code changes; the parent authorizes integration by sending /skill:merge.",
      }),
    ),
    autoComplete: Type.Optional(Type.Boolean()),
  }
  if (profiles.size <= 1) return Type.Object(parameters, { additionalProperties: false })
  return Type.Object(
    {
      ...parameters,
      profile: Type.Optional(
        StringEnum([...profiles.keys()], {
          description: "Subagent profile. Omit it to use the configured default profile.",
        }),
      ),
    },
    { additionalProperties: false },
  )
}

function resolveLaunch(
  config: SubaConfig,
  profile: Profile,
  overrides: { model?: string; thinking?: ThinkingLevel; autoComplete?: boolean },
): ResolvedLaunch {
  return {
    profile: profile.name,
    tools: profile.tools,
    loadContext: profile.loadContext,
    loadSkills: profile.loadSkills,
    systemPrompt: profile.systemPrompt,
    autoComplete: overrides.autoComplete ?? profile.autoComplete ?? config.autoComplete,
    model: overrides.model ?? profile.model ?? config.model,
    thinking: overrides.thinking ?? profile.thinking ?? config.thinking,
  }
}
function uniqueId(records: Map<string, ChildRecord>): string {
  let id: string
  do id = randomBytes(4).toString("hex")
  while (records.has(id))
  return id
}
export function childTools(policy: readonly string[], configured: readonly string[]): string[] {
  return [...new Set([...policy, ...configured, "suba_done", "suba_notify", "suba_ask"])]
}

export function parseQualifiedModel(value: string): { provider: string; modelId: string } {
  const separator = value.indexOf("/")
  if (separator <= 0 || separator === value.length - 1 || /\s/.test(value)) {
    throw new Error(`Subagent model must use a fully qualified provider/model identifier: ${value}`)
  }
  return { provider: value.slice(0, separator), modelId: value.slice(separator + 1) }
}
function validateModel(model: string, ctx: ExtensionContext): void {
  const parsed = parseQualifiedModel(model)
  if (!ctx.modelRegistry.find(parsed.provider, parsed.modelId))
    throw new Error(`Subagent model is unavailable: ${model}`)
  if (
    ctx.scopedModels.length > 0 &&
    !ctx.scopedModels.some(
      (entry) => entry.model.provider === parsed.provider && entry.model.id === parsed.modelId,
    )
  ) {
    throw new Error(`Subagent model is outside the enabled model scope: ${model}`)
  }
}
export function invocation(): string {
  const override = process.env.SUBA_PI_EXECUTABLE?.trim()
  if (override) return shellQuote(resolve(override))
  const script = process.argv[1]
  if (
    script &&
    !script.startsWith("/$bunfs/root/") &&
    existsSync(script) &&
    script !== process.execPath
  ) {
    return `${shellQuote(process.execPath)} ${shellQuote(script)}`
  }
  const executable = process.execPath.split("/").pop()?.toLowerCase()
  return /^(node|bun)(\.exe)?$/.test(executable ?? "") ? "pi" : shellQuote(process.execPath)
}
export function launchScript(
  args: string[],
  env: Record<string, string>,
  artifactDir: string,
  cwd: string,
): string {
  const exports = Object.entries({ ...env, PI_CODING_AGENT_DIR: agentDirectory() })
    .map(([key, value]) => `export ${key}=${shellQuote(value)}`)
    .join("\n")
  return `#!/bin/sh\n${exports}\nif cd ${shellQuote(cwd)}; then\n  ${invocation()} ${args.map(shellQuote).join(" ")}\n  exit_code=$?\nelse\n  exit_code=$?\nfi\nprintf '%s\\n' "$exit_code" > ${shellQuote(join(artifactDir, "process-exit.tmp"))}\nmv ${shellQuote(join(artifactDir, "process-exit.tmp"))} ${shellQuote(join(artifactDir, "process-exit"))}\nexit "$exit_code"\n`
}

type Theme = ExtensionContext["ui"]["theme"]

interface LaunchToolDetails {
  id: string
  name: string
  sessionFile: string
  tmuxTarget?: string
  profile: string
  model?: string
  thinking?: ThinkingLevel
  worktreeHandle?: string
  worktreePath?: string
  status: RegistryState
}

function oneLine(value: string, limit = 110): string {
  const normalized = value.replace(/\s+/g, " ").trim()
  return normalized.length <= limit ? normalized : `${normalized.slice(0, Math.max(0, limit - 1))}…`
}

function invocationLabel(model?: string, thinking?: string, profile?: string): string {
  return [model ? shortModel(model) : undefined, thinking, profile].filter(Boolean).join(" · ")
}

function statusGlyph(state: RegistryState, theme: Theme): string {
  if (state === "completed") return theme.fg("success", "✓")
  if (state === "failed" || state === "orphaned") return theme.fg("error", "✗")
  if (state === "awaiting-parent") return theme.fg("warning", "?")
  if (state === "interrupted") return theme.fg("warning", "■")
  return theme.fg("accent", "●")
}

function toolResultText(result: { content: Array<{ type: string; text?: string }> }): string {
  const content = result.content[0]
  return content?.type === "text" ? (content.text ?? "") : ""
}

export function registerTools(pi: ExtensionAPI, host: ManagerHost): void {
  const start = async (
    params: {
      name: string
      task: string
      profile?: string
      context?: "fresh" | "fork"
      model?: string
      thinking?: ThinkingLevel
      cwd?: string
      worktree?: boolean
      autoComplete?: boolean
    },
    ctx: ExtensionContext,
    resume?: ChildRecord,
    signal?: AbortSignal,
  ): Promise<ChildRecord> => {
    const parentPane = process.env.TMUX_PANE
    if (!parentPane)
      throw new Error(
        "pi-suba requires the parent Pi session to run inside tmux (TMUX_PANE is unset)",
      )
    try {
      await tmuxExec(["-V"])
    } catch {
      throw new Error("pi-suba requires tmux on PATH")
    }
    if (process.env.SUBA_PI_EXECUTABLE?.trim()) {
      try {
        accessSync(resolve(process.env.SUBA_PI_EXECUTABLE), constants.X_OK)
      } catch {
        throw new Error(`SUBA_PI_EXECUTABLE is not executable: ${process.env.SUBA_PI_EXECUTABLE}`)
      }
    }
    const profile = resume
      ? host.profiles.get(resume.profile)
      : host.profiles.get(params.profile ?? host.config.defaultProfile)
    if (!profile && !resume)
      throw new Error(`Unknown subagent profile: ${params.profile ?? host.config.defaultProfile}`)
    const resolvedLaunch = resume
      ? {
          ...resume.resolvedLaunch,
          model: params.model ?? resume.resolvedLaunch.model,
          thinking: params.thinking ?? resume.resolvedLaunch.thinking,
        }
      : resolveLaunch(host.config, profile!, params)
    if (resolvedLaunch.model) validateModel(resolvedLaunch.model, ctx)
    const id = resume?.id ?? uniqueId(host.records)
    const sourceCwd = resolve(ctx.cwd, params.cwd ?? ".")
    let worktree = resume?.worktree
    if (worktree) await validateStoredWorktree(worktree)
    else if (!resume && params.worktree)
      worktree = await provisionWorktree(params.name, id, sourceCwd, signal)
    const cwd = worktree?.workingDirectory ?? resume?.cwd ?? sourceCwd
    let rollbackArmed = Boolean(worktree && !resume)

    try {
      const artifactRoot = artifactDirectory()
      const artifactDir =
        resume?.artifactDir ?? join(artifactRoot, ctx.sessionManager.getSessionId(), id)
      const sessionFile = resume?.sessionFile ?? join(artifactDir, "session.jsonl")
      await mkdir(join(artifactDir, "events"), { recursive: true })
      let resultAfterEntry = 0
      if (resume) {
        resultAfterEntry = await countSessionEntries(sessionFile)
        await rm(join(artifactDir, "process-exit"), { force: true })
        await rm(join(artifactDir, "activity.json"), { force: true })
      } else {
        const parentSession = ctx.sessionManager.getSessionFile()
        const entries =
          params.context === "fork"
            ? forkEntries(ctx.sessionManager.getBranch() as unknown as never[])
            : []
        await seedSession(sessionFile, cwd, parentSession, entries)
        resultAfterEntry = await countSessionEntries(sessionFile)
        await writeFile(join(artifactDir, "profile.md"), profile!.body, {
          encoding: "utf8",
          mode: 0o600,
        })
      }
      const profileBody = await import("node:fs/promises").then((fs) =>
        fs.readFile(join(artifactDir, "profile.md"), "utf8"),
      )
      const promptFile = join(artifactDir, "system-prompt.md")
      const controlFile = join(artifactDir, "control-prompt.md")
      await writeFile(promptFile, `${profileBody}\n`, { encoding: "utf8", mode: 0o600 })
      await writeFile(controlFile, `${childControlPrompt(Boolean(worktree))}\n`, {
        encoding: "utf8",
        mode: 0o600,
      })
      const childExtension = fileURLToPath(new URL("../child/index.ts", import.meta.url))
      const configuredExtensions = host.config.childExtensions.flatMap((source) => [
        "-e",
        resolveChildExtensionSource(source),
      ])
      const args = [
        "--no-extensions",
        ...configuredExtensions,
        "-e",
        childExtension,
        "--tools",
        childTools(TOOL_POLICIES[resolvedLaunch.tools], host.config.childTools).join(","),
        "--session",
        sessionFile,
        "--name",
        `suba: ${params.name}`,
      ]
      if (!resolvedLaunch.loadContext) args.push("--no-context-files")
      if (!resolvedLaunch.loadSkills) args.push("--no-skills")
      if (resolvedLaunch.model) args.push("--model", resolvedLaunch.model)
      if (resolvedLaunch.thinking) args.push("--thinking", resolvedLaunch.thinking)
      if (resolvedLaunch.systemPrompt === "replace")
        args.push("--system-prompt", promptFile, "--append-system-prompt", controlFile)
      else args.push("--append-system-prompt", promptFile, "--append-system-prompt", controlFile)
      args.push(params.task)
      const scriptPath = join(artifactDir, "launch.sh")
      await writeFile(
        scriptPath,
        launchScript(
          args,
          {
            SUBA_CHILD_ID: id,
            SUBA_ARTIFACT_DIR: artifactDir,
            SUBA_AUTO_COMPLETE: resolvedLaunch.autoComplete ? "1" : "0",
            SUBA_SESSION_FILE: sessionFile,
          },
          artifactDir,
          cwd,
        ),
        { encoding: "utf8", mode: 0o700 },
      )
      await chmod(scriptPath, 0o700)
      let target
      try {
        target = await createTarget(parentPane, shellQuote(scriptPath))
      } catch (error) {
        if (error instanceof PartialTmuxTargetError) {
          rollbackArmed = false
          throw error
        }
        throw new Error(
          `Could not create tmux target: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        )
      }
      rollbackArmed = false
      const record: ChildRecord = {
        id,
        revision: (resume?.revision ?? 0) + 1,
        state: "running",
        sessionFile,
        artifactDir,
        paneId: target.paneId,
        name: params.name,
        cwd,
        worktree,
        profile: resume?.profile ?? profile!.name,
        resolvedLaunch,
        lastEventSequence: resume?.lastEventSequence ?? 0,
        startedAt: Date.now(),
        resultAfterEntry,
        lastRequestContextTokens: resume?.lastRequestContextTokens,
      }
      host.records.set(id, record)
      try {
        host.persist(record)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        process.stderr.write(
          `pi-suba: child ${id} is running in ${target.paneId}, but its registry record could not be persisted: ${message}\n`,
        )
      }
      host.refreshWidget()
      host.watch(id)
      return record
    } catch (error) {
      if (rollbackArmed && worktree) return rollbackWorktree(worktree, error)
      throw error
    }
  }

  pi.registerTool({
    name: "suba",
    label: "Suba",
    description: launchToolDescription(host.profiles),
    promptSnippet: "Launch an asynchronous interactive Pi subagent with suba",
    parameters: launchParametersSchema(host.profiles),
    async execute(_id, params, signal, _update, ctx) {
      const record = await start(params, ctx, undefined, signal)
      return {
        content: [
          {
            type: "text",
            text: `Launched ${record.name} as ${record.id}. Results arrive automatically in another turn. Do not wait with sleep or status checks.`,
          },
        ],
        details: {
          id: record.id,
          name: record.name,
          sessionFile: record.sessionFile,
          tmuxTarget: record.paneId,
          profile: record.profile,
          model: record.resolvedLaunch.model,
          thinking: record.resolvedLaunch.thinking,
          worktreeHandle: record.worktree?.handle,
          worktreePath: record.worktree?.worktreePath,
          status: record.state,
        },
      }
    },
    renderCall(args, theme) {
      const launchArgs = args as typeof args & { profile?: string }
      const profile = host.profiles.get(launchArgs.profile ?? host.config.defaultProfile)
      const model = launchArgs.model ?? profile?.model ?? host.config.model
      const thinking = launchArgs.thinking ?? profile?.thinking ?? host.config.thinking
      const meta = invocationLabel(
        model,
        thinking,
        profile?.name ?? launchArgs.profile ?? host.config.defaultProfile,
      )
      const labels = [meta, args.worktree ? "worktree" : undefined].filter(Boolean).join(" · ")
      const lines = [
        `${theme.fg("accent", "▸")} ${theme.fg("toolTitle", theme.bold(launchArgs.name || "subagent"))}${labels ? theme.fg("dim", `  ${labels}`) : ""}`,
      ]
      if (launchArgs.task) {
        const count = launchArgs.task.split(/\r?\n/).length
        lines.push(
          `${theme.fg("toolOutput", oneLine(launchArgs.task))}${count > 1 ? theme.fg("muted", ` · ${count} lines`) : ""}`,
        )
      }
      return new Text(lines.join("\n"), 0, 0)
    },
    renderResult(result, { expanded }, theme) {
      const details = result.details as LaunchToolDetails | undefined
      if (!details) return new Text(theme.fg("dim", toolResultText(result)), 0, 0)
      const meta = invocationLabel(details.model, details.thinking, details.profile)
      const header = `${theme.fg("accent", "●")} ${theme.fg("toolTitle", theme.bold(details.name))}  ${theme.fg("accent", "running")}`
      const lines = [
        header,
        theme.fg("dim", `  ${[meta, details.tmuxTarget].filter(Boolean).join(" · ")}`),
      ]
      if (expanded) {
        lines.push(theme.fg("dim", `  id ${details.id}`))
        lines.push(theme.fg("dim", `  session ${details.sessionFile}`))
        if (details.worktreeHandle)
          lines.push(
            theme.fg("dim", `  worktree ${details.worktreeHandle} · ${details.worktreePath}`),
          )
      }
      return new Text(lines.filter(Boolean).join("\n"), 0, 0)
    },
  })
  pi.registerTool({
    name: "suba_send",
    label: "Suba Send",
    description:
      "Send actionable guidance to a live subagent by stable child ID, not acknowledgements or reminders to keep waiting. If the child is terminal, the failure includes its state and latest result or error, with suba_resume guidance. To authorize a ready worktree child's integration and cleanup, send /skill:merge followed by a space (not a newline) and these instructions in the same message: After merging, use suba_ask to report success or a blocker, then wait. Do not call suba_done; the parent will verify integration and finish the session. Authorize only one merge at a time; the child must have skills enabled and the merge skill available.",
    parameters: Type.Object({ id: Type.String(), message: Type.String() }),
    async execute(_call, params) {
      await host.watch(params.id)
      const record = host.records.get(params.id)
      if (!record) throw new Error(`Unknown subagent ${params.id}; no message was delivered.`)
      if (!isLive(record) || !record.paneId) {
        const detail = record.error || record.result
        const bounded = detail?.replace(/\s+/g, " ").trim().slice(0, 240)
        const suffix = bounded ? `\nLatest ${record.error ? "failure" : "result"}: ${bounded}` : ""
        throw new Error(
          `${record.name} (${record.id}) is ${record.state}. Your message was not delivered.${suffix}\nUse suba_resume with this child ID if further work is required.`,
        )
      }
      await sendToPane(record.paneId, params.message)
      await host.watch(params.id)
      const latest = host.records.get(params.id)
      if (!latest || !isLive(latest))
        throw new Error(
          `${record.name} (${record.id}) ended while guidance was being submitted. Processing is not confirmed. Use suba_resume with this guidance if it is still needed.`,
        )
      const running =
        latest.state === "awaiting-parent"
          ? { ...latest, revision: latest.revision + 1, state: "running" as const }
          : latest
      if (running !== latest) {
        host.records.set(record.id, running)
        host.persist(running)
        host.refreshWidget()
      }
      return {
        content: [{ type: "text", text: `Sent guidance to ${running.name} (${running.id}).` }],
        details: { id: running.id, name: running.name, paneId: running.paneId },
      }
    },
    renderCall(args, theme) {
      const preview = args.message ? `\n${theme.fg("toolOutput", oneLine(args.message))}` : ""
      return new Text(
        `${theme.fg("accent", "▸")} ${theme.fg("toolTitle", theme.bold(args.id || "subagent"))} ${theme.fg("dim", "guidance")}${preview}`,
        0,
        0,
      )
    },
    renderResult(result, _options, theme) {
      const details = result.details
      return details
        ? new Text(
            `${theme.fg("success", "✓")} ${theme.fg("toolTitle", theme.bold(details.name))} ${theme.fg("dim", "guidance sent")}`,
            0,
            0,
          )
        : new Text(theme.fg("dim", toolResultText(result)), 0, 0)
    },
  })
  pi.registerTool({
    name: "suba_finish",
    label: "Suba Finish",
    description:
      "Record a verified result and close an idle or awaiting-parent child's pane. After a worktree child reports merge success, independently verify integration before calling this tool. Do not finish blocked children. This does not merge or remove worktrees and does not close other panes.",
    parameters: Type.Object({
      id: Type.String(),
      result: Type.String({ description: "Parent-verified completion summary to retain." }),
    }),
    async execute(_call, params) {
      const record = await finishChild(host, params.id, params.result)
      return {
        content: [
          { type: "text", text: `Finished ${record.name} (${record.id}): ${record.result}` },
        ],
        details: { id: record.id, name: record.name, state: record.state },
      }
    },
  })
  pi.registerTool({
    name: "suba_resume",
    label: "Suba Resume",
    description:
      "Resume a completed or exited subagent thread in a split in the parent's current tmux window.",
    parameters: Type.Object(
      {
        id: Type.String(),
        task: Type.String(),
        model: Type.Optional(ModelSchema),
        thinking: Type.Optional(ThinkingSchema),
      },
      { additionalProperties: false },
    ),
    async execute(_call, params, signal, _update, ctx) {
      const previous = host.records.get(params.id)
      if (!previous) throw new Error(`Unknown subagent: ${params.id}`)
      if (isLive(previous)) throw new Error(`Subagent ${params.id} is already live`)
      const record = await start({ ...params, name: previous.name }, ctx, previous, signal)
      return {
        content: [
          { type: "text", text: `Resumed ${record.name} (${record.id}) in ${record.paneId}.` },
        ],
        details: {
          id: record.id,
          name: record.name,
          sessionFile: record.sessionFile,
          tmuxTarget: record.paneId,
          profile: record.profile,
          model: record.resolvedLaunch.model,
          thinking: record.resolvedLaunch.thinking,
          worktreeHandle: record.worktree?.handle,
          worktreePath: record.worktree?.worktreePath,
          status: record.state,
        },
      }
    },
    renderCall(args, theme) {
      const preview = args.task ? `\n${theme.fg("toolOutput", oneLine(args.task))}` : ""
      return new Text(
        `${theme.fg("accent", "▸")} ${theme.fg("toolTitle", theme.bold(args.id || "subagent"))} ${theme.fg("dim", "resume")}${preview}`,
        0,
        0,
      )
    },
    renderResult(result, { expanded }, theme) {
      const details = result.details as LaunchToolDetails | undefined
      if (!details) return new Text(theme.fg("dim", toolResultText(result)), 0, 0)
      const meta = invocationLabel(details.model, details.thinking, details.profile)
      const lines = [
        `${theme.fg("accent", "●")} ${theme.fg("toolTitle", theme.bold(details.name))}  ${theme.fg("accent", "running")}`,
      ]
      if (meta)
        lines.push(
          theme.fg("dim", `  ${meta}${details.tmuxTarget ? ` · ${details.tmuxTarget}` : ""}`),
        )
      if (expanded) {
        lines.push(theme.fg("dim", `  session ${details.sessionFile}`))
        if (details.worktreeHandle)
          lines.push(
            theme.fg("dim", `  worktree ${details.worktreeHandle} · ${details.worktreePath}`),
          )
      }
      return new Text(lines.join("\n"), 0, 0)
    },
  })
  pi.registerTool({
    name: "suba_list",
    label: "Suba List",
    description:
      "List subagent registry and live activity once when status details are needed. Never call repeatedly or combine with sleep to wait for results.",
    parameters: Type.Object({
      status: Type.Optional(StringEnum(["running", "completed", "all"] as const)),
    }),
    async execute(_call, params) {
      const records = [...host.records.values()]
        .filter((record) =>
          params.status === "running"
            ? isLive(record)
            : params.status === "completed"
              ? !isLive(record)
              : true,
        )
        .map((record) => ({
          id: record.id,
          name: record.name,
          profile: record.profile,
          sessionFile: record.sessionFile,
          tmuxTarget: record.paneId,
          state: record.state,
          activity: record.activity,
          lastRequestContextTokens: record.lastRequestContextTokens,
          lastRequestContext: formatRequestContext(record.lastRequestContextTokens),
          model: record.activity?.model ?? record.resolvedLaunch.model,
          thinking: record.activity?.thinking ?? record.resolvedLaunch.thinking,
          elapsedMs: Date.now() - record.startedAt,
          lastResult: record.result,
          report: record.report,
          error: record.error,
          worktree: record.worktree,
          resumable: isResumable(record),
        }))
      return {
        content: [{ type: "text", text: JSON.stringify(records, null, 2) }],
        details: { records },
      }
    },
    renderCall(args, theme) {
      return new Text(
        `${theme.fg("toolTitle", theme.bold("subagents"))}${args.status ? theme.fg("dim", ` · ${args.status}`) : ""}`,
        0,
        0,
      )
    },
    renderResult(result, { expanded }, theme) {
      const records = result.details?.records
      if (!records) return new Text(theme.fg("dim", toolResultText(result)), 0, 0)
      const container = new Container()
      container.addChild(
        new Text(
          `${theme.fg("toolTitle", theme.bold("Subagents"))} ${theme.fg("dim", `· ${records.length}`)}`,
          0,
          0,
        ),
      )
      const visible = expanded ? records : records.slice(0, 5)
      for (const record of visible) {
        const activity =
          record.state === "awaiting-parent"
            ? "needs guidance"
            : record.activity?.activity === "tool"
              ? (record.activity.toolName ?? "tool")
              : record.activity?.activity
        const meta = [
          record.state,
          activity,
          invocationLabel(record.model, record.thinking),
          formatElapsed(record.elapsedMs),
          record.lastRequestContext,
        ]
          .filter(Boolean)
          .join(" · ")
        container.addChild(
          new Text(
            `${statusGlyph(record.state, theme)} ${theme.fg("toolTitle", theme.bold(record.name))} ${theme.fg("dim", `· ${meta}`)}`,
            0,
            0,
          ),
        )
        if (expanded) {
          container.addChild(
            new Text(
              theme.fg(
                "dim",
                `  id ${record.id}${record.tmuxTarget ? ` · pane ${record.tmuxTarget}` : ""}${record.resumable ? " · resumable" : ""}`,
              ),
              0,
              0,
            ),
          )
          if (record.error)
            container.addChild(new Text(theme.fg("error", `  ${record.error}`), 0, 0))
        }
      }
      if (!expanded && records.length > visible.length)
        container.addChild(
          new Text(theme.fg("muted", `… ${records.length - visible.length} more`), 0, 0),
        )
      if (!expanded && records.length)
        container.addChild(
          new Text(theme.fg("muted", keyHint("app.tools.expand", "for details")), 0, 0),
        )
      if (!records.length)
        container.addChild(new Text(theme.fg("muted", "No matching subagents"), 0, 0))
      return container
    },
  })
}
