import { randomBytes } from "node:crypto";
import { accessSync, constants, existsSync } from "node:fs";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { resolveChildExtensionSource, type SubaConfig } from "../shared/config.ts";
import type { Profile } from "../shared/profiles.ts";
import { TOOL_POLICIES } from "../shared/profiles.ts";
import { THINKING_LEVELS, type Placement, type ThinkingLevel } from "../shared/protocol.ts";
import { countSessionEntries, forkEntries, seedSession } from "../shared/sessions.ts";
import { createTarget, sendToPane, tmuxExec } from "../shared/tmux.ts";
import type { ChildRecord, ResolvedLaunch } from "./registry.ts";
import { isLive } from "./registry.ts";

const PlacementSchema = Type.Object({ type: StringEnum(["split", "window", "shared-window"] as const), windowName: Type.Optional(Type.String()) });
const ThinkingSchema = StringEnum(THINKING_LEVELS);
const shellQuote = (value: string) => `'${value.replaceAll("'", `'\"'\"'`)}'`;
const CONTROL_PROMPT = `You are a delegated Pi subagent. Complete the assigned task independently. Use caller_ping only when parent guidance is required. Use subagent_done to finish immediately. Automatic completion ends a settled run when enabled.`;

export interface ManagerHost {
  config: SubaConfig;
  profiles: Map<string, Profile>;
  records: Map<string, ChildRecord>;
  persist(record: ChildRecord): void;
  refreshWidget(): void;
  watch(id: string): void;
}

function resolveLaunch(config: SubaConfig, profile: Profile, overrides: { model?: string; thinking?: ThinkingLevel; autoComplete?: boolean }): ResolvedLaunch {
  return {
    profile: profile.name, tools: profile.tools, loadContext: profile.loadContext, loadSkills: profile.loadSkills,
    systemPrompt: profile.systemPrompt,
    autoComplete: overrides.autoComplete ?? profile.autoComplete ?? config.autoComplete,
    model: overrides.model ?? profile.model ?? config.model,
    thinking: overrides.thinking ?? profile.thinking ?? config.thinking,
  };
}
function uniqueId(records: Map<string, ChildRecord>): string { let id: string; do id = randomBytes(4).toString("hex"); while (records.has(id)); return id; }
export function invocation(): string {
  const override = process.env.SUBA_PI_EXECUTABLE?.trim();
  if (override) return shellQuote(resolve(override));
  const script = process.argv[1];
  if (script && !script.startsWith("/$bunfs/root/") && existsSync(script) && script !== process.execPath) {
    return `${shellQuote(process.execPath)} ${shellQuote(script)}`;
  }
  const executable = process.execPath.split("/").pop()?.toLowerCase();
  return /^(node|bun)(\.exe)?$/.test(executable ?? "") ? "pi" : shellQuote(process.execPath);
}
function launchScript(args: string[], env: Record<string, string>, artifactDir: string): string {
  const exports = Object.entries(env).map(([key, value]) => `export ${key}=${shellQuote(value)}`).join("\n");
  return `#!/bin/sh\n${exports}\n${invocation()} ${args.map(shellQuote).join(" ")}\nexit_code=$?\nprintf '%s\\n' "$exit_code" > ${shellQuote(join(artifactDir, "process-exit.tmp"))}\nmv ${shellQuote(join(artifactDir, "process-exit.tmp"))} ${shellQuote(join(artifactDir, "process-exit"))}\nexit "$exit_code"\n`;
}

export function registerTools(pi: ExtensionAPI, host: ManagerHost): void {
  const start = async (params: { name: string; task: string; profile?: string; context?: "fresh" | "fork"; model?: string; thinking?: ThinkingLevel; cwd?: string; placement?: Placement; autoComplete?: boolean }, ctx: ExtensionContext, resume?: ChildRecord): Promise<ChildRecord> => {
    const parentPane = process.env.TMUX_PANE;
    if (!parentPane) throw new Error("pi-suba requires the parent Pi session to run inside tmux (TMUX_PANE is unset)");
    try { await tmuxExec(["-V"]); } catch { throw new Error("pi-suba requires tmux on PATH"); }
    if (process.env.SUBA_PI_EXECUTABLE?.trim()) {
      try { accessSync(resolve(process.env.SUBA_PI_EXECUTABLE), constants.X_OK); }
      catch { throw new Error(`SUBA_PI_EXECUTABLE is not executable: ${process.env.SUBA_PI_EXECUTABLE}`); }
    }
    const profile = resume ? host.profiles.get(resume.profile) : host.profiles.get(params.profile ?? host.config.defaultProfile);
    if (!profile && !resume) throw new Error(`Unknown subagent profile: ${params.profile ?? host.config.defaultProfile}`);
    const id = resume?.id ?? uniqueId(host.records);
    const cwd = resume?.cwd ?? resolve(ctx.cwd, params.cwd ?? ".");
    const artifactRoot = process.env.SUBA_ARTIFACT_ROOT?.trim()
      ? resolve(process.env.SUBA_ARTIFACT_ROOT)
      : join(homedir(), ".pi", "suba");
    const artifactDir = resume?.artifactDir ?? join(artifactRoot, ctx.sessionManager.getSessionId(), id);
    const sessionFile = resume?.sessionFile ?? join(artifactDir, "session.jsonl");
    await mkdir(join(artifactDir, "events"), { recursive: true });
    let resultAfterEntry = 0;
    let resolvedLaunch: ResolvedLaunch;
    if (resume) {
      resolvedLaunch = { ...resume.resolvedLaunch, model: params.model ?? resume.resolvedLaunch.model, thinking: params.thinking ?? resume.resolvedLaunch.thinking };
      resultAfterEntry = await countSessionEntries(sessionFile);
      await rm(join(artifactDir, "process-exit"), { force: true });
    } else {
      resolvedLaunch = resolveLaunch(host.config, profile!, params);
      const parentSession = ctx.sessionManager.getSessionFile();
      const entries = params.context === "fork" ? forkEntries(ctx.sessionManager.getBranch() as unknown as never[]) : [];
      await seedSession(sessionFile, cwd, parentSession, entries);
      resultAfterEntry = await countSessionEntries(sessionFile);
      await writeFile(join(artifactDir, "profile.md"), profile!.body, { encoding: "utf8", mode: 0o600 });
    }
    const profileBody = await import("node:fs/promises").then((fs) => fs.readFile(join(artifactDir, "profile.md"), "utf8"));
    const promptFile = join(artifactDir, "system-prompt.md");
    const controlFile = join(artifactDir, "control-prompt.md");
    await writeFile(promptFile, `${profileBody}\n`, { encoding: "utf8", mode: 0o600 });
    await writeFile(controlFile, `${CONTROL_PROMPT}\n`, { encoding: "utf8", mode: 0o600 });
    const childExtension = fileURLToPath(new URL("../child/index.ts", import.meta.url));
    const configuredExtensions = host.config.childExtensions.flatMap((source) => ["-e", resolveChildExtensionSource(source)]);
    const args = ["--no-extensions", ...configuredExtensions, "-e", childExtension, "--tools", [...TOOL_POLICIES[resolvedLaunch.tools], "subagent_done", "caller_ping"].join(","), "--session", sessionFile, "--name", `suba: ${params.name}`];
    if (!resolvedLaunch.loadContext) args.push("--no-context-files");
    if (!resolvedLaunch.loadSkills) args.push("--no-skills");
    if (resolvedLaunch.model) args.push("--model", resolvedLaunch.model);
    if (resolvedLaunch.thinking) args.push("--thinking", resolvedLaunch.thinking);
    if (resolvedLaunch.systemPrompt === "replace") args.push("--system-prompt", promptFile, "--append-system-prompt", controlFile);
    else args.push("--append-system-prompt", promptFile, "--append-system-prompt", controlFile);
    args.push(params.task);
    const scriptPath = join(artifactDir, "launch.sh");
    await writeFile(scriptPath, launchScript(args, { SUBA_CHILD_ID: id, SUBA_ARTIFACT_DIR: artifactDir, SUBA_AUTO_COMPLETE: resolvedLaunch.autoComplete ? "1" : "0", SUBA_SESSION_FILE: sessionFile }, artifactDir), { encoding: "utf8", mode: 0o700 });
    await chmod(scriptPath, 0o700);
    const placement = params.placement ?? resume?.placement ?? host.config.placement;
    let target;
    try { target = await createTarget(placement, parentPane, shellQuote(scriptPath), params.name, host.config.sharedWindowName); }
    catch (error) { throw new Error(`Could not create tmux target: ${error instanceof Error ? error.message : String(error)}`); }
    const record: ChildRecord = {
      id, revision: (resume?.revision ?? 0) + 1, state: "running", sessionFile, artifactDir,
      paneId: target.paneId, windowId: target.windowId, placement, name: params.name,
      cwd, profile: resume?.profile ?? profile!.name, resolvedLaunch, lastEventSequence: resume?.lastEventSequence ?? 0,
      startedAt: Date.now(), resultAfterEntry,
    };
    host.records.set(id, record); host.persist(record); host.refreshWidget(); host.watch(id);
    return record;
  };

  pi.registerTool({
    name: "subagent", label: "Subagent", description: "Launch an interactive Pi subagent in tmux and return immediately. Results and help requests arrive automatically. Do not poll.",
    parameters: Type.Object({ name: Type.String(), task: Type.String(), profile: Type.Optional(Type.String()), context: Type.Optional(StringEnum(["fresh", "fork"] as const)), model: Type.Optional(Type.String()), thinking: Type.Optional(ThinkingSchema), cwd: Type.Optional(Type.String()), placement: Type.Optional(PlacementSchema), autoComplete: Type.Optional(Type.Boolean()) }),
    async execute(_id, params, _signal, _update, ctx) { const record = await start(params, ctx); return { content: [{ type: "text", text: `Launched ${record.name} as ${record.id}. Results arrive automatically; do not poll.` }], details: { id: record.id, sessionFile: record.sessionFile, tmuxTarget: record.paneId, profile: record.profile, status: record.state } }; },
  });
  pi.registerTool({
    name: "subagent_send", label: "Send to Subagent", description: "Send guidance to a live subagent by stable child ID.", parameters: Type.Object({ id: Type.String(), message: Type.String() }),
    async execute(_call, params) { const record = host.records.get(params.id); if (!record || !isLive(record) || !record.paneId) throw new Error(`Subagent ${params.id} is not live`); await sendToPane(record.paneId, params.message); const running = record.state === "awaiting-parent" ? { ...record, revision: record.revision + 1, state: "running" as const } : record; if (running !== record) { host.records.set(record.id, running); host.persist(running); host.refreshWidget(); } return { content: [{ type: "text", text: `Sent guidance to ${running.name} (${running.id}).` }], details: { id: running.id, paneId: running.paneId } }; },
  });
  pi.registerTool({
    name: "subagent_resume", label: "Resume Subagent", description: "Resume a completed or exited subagent thread in a new tmux target.",
    parameters: Type.Object({ id: Type.String(), task: Type.String(), placement: Type.Optional(PlacementSchema), model: Type.Optional(Type.String()), thinking: Type.Optional(ThinkingSchema) }),
    async execute(_call, params, _signal, _update, ctx) { const previous = host.records.get(params.id); if (!previous) throw new Error(`Unknown subagent: ${params.id}`); if (isLive(previous)) throw new Error(`Subagent ${params.id} is already live`); const record = await start({ ...params, name: previous.name }, ctx, previous); return { content: [{ type: "text", text: `Resumed ${record.name} (${record.id}) in ${record.paneId}.` }], details: { id: record.id, sessionFile: record.sessionFile, tmuxTarget: record.paneId, status: record.state } }; },
  });
  pi.registerTool({
    name: "subagents_list", label: "List Subagents", description: "List subagent registry and live activity. Use only when status details are needed, not to poll for results.", parameters: Type.Object({ status: Type.Optional(StringEnum(["running", "completed", "all"] as const)) }),
    async execute(_call, params) { const records = [...host.records.values()].filter((record) => params.status === "running" ? isLive(record) : params.status === "completed" ? !isLive(record) : true).map((record) => ({ id: record.id, name: record.name, profile: record.profile, sessionFile: record.sessionFile, tmuxTarget: record.paneId, state: record.state, activity: record.activity, model: record.activity?.model ?? record.resolvedLaunch.model, thinking: record.activity?.thinking ?? record.resolvedLaunch.thinking, elapsedMs: Date.now() - record.startedAt, lastResult: record.result, resumable: !isLive(record) })); return { content: [{ type: "text", text: JSON.stringify(records, null, 2) }], details: { records } }; },
  });
}
