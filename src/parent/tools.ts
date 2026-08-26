import { randomBytes } from "node:crypto";
import { accessSync, constants, existsSync } from "node:fs";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { StringEnum } from "@earendil-works/pi-ai";
import { keyHint, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { resolveChildExtensionSource, type SubaConfig } from "../shared/config.ts";
import type { Profile } from "../shared/profiles.ts";
import { TOOL_POLICIES } from "../shared/profiles.ts";
import { THINKING_LEVELS, type Placement, type ThinkingLevel } from "../shared/protocol.ts";
import { countSessionEntries, forkEntries, seedSession } from "../shared/sessions.ts";
import { createTarget, sendToPane, tmuxExec } from "../shared/tmux.ts";
import type { ChildRecord, RegistryState, ResolvedLaunch } from "./registry.ts";
import { isLive } from "./registry.ts";
import { formatElapsed, shortModel } from "./widget.ts";

const PlacementSchema = Type.Object({ type: StringEnum(["split", "window", "shared-window"] as const), windowName: Type.Optional(Type.String()) });
const ThinkingSchema = StringEnum(THINKING_LEVELS, { description: "Thinking level paired with an explicit model choice. Omit it to use the configured default." });
const ModelSchema = Type.String({ description: "Fully qualified provider/model identifier. Omit it to use the configured default." });
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
export function parseQualifiedModel(value: string): { provider: string; modelId: string } {
  const separator = value.indexOf("/");
  if (separator <= 0 || separator === value.length - 1 || /\s/.test(value)) {
    throw new Error(`Subagent model must use a fully qualified provider/model identifier: ${value}`);
  }
  return { provider: value.slice(0, separator), modelId: value.slice(separator + 1) };
}
function validateModel(model: string, ctx: ExtensionContext): void {
  const parsed = parseQualifiedModel(model);
  if (!ctx.modelRegistry.find(parsed.provider, parsed.modelId)) throw new Error(`Subagent model is unavailable: ${model}`);
  if (ctx.scopedModels.length > 0 && !ctx.scopedModels.some((entry) => entry.model.provider === parsed.provider && entry.model.id === parsed.modelId)) {
    throw new Error(`Subagent model is outside the enabled model scope: ${model}`);
  }
}
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

type Theme = ExtensionContext["ui"]["theme"];

interface LaunchToolDetails {
  id: string;
  name: string;
  sessionFile: string;
  tmuxTarget?: string;
  profile: string;
  model?: string;
  thinking?: ThinkingLevel;
  placement?: string;
  status: RegistryState;
}

function oneLine(value: string, limit = 110): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= limit ? normalized : `${normalized.slice(0, Math.max(0, limit - 1))}…`;
}

function invocationLabel(model?: string, thinking?: string, profile?: string): string {
  return [model ? shortModel(model) : undefined, thinking, profile].filter(Boolean).join(" · ");
}

function statusGlyph(state: RegistryState, theme: Theme): string {
  if (state === "completed") return theme.fg("success", "✓");
  if (state === "failed" || state === "orphaned") return theme.fg("error", "✗");
  if (state === "awaiting-parent") return theme.fg("warning", "?");
  if (state === "interrupted") return theme.fg("warning", "■");
  return theme.fg("accent", "●");
}

function toolResultText(result: { content: Array<{ type: string; text?: string }> }): string {
  const content = result.content[0];
  return content?.type === "text" ? content.text ?? "" : "";
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
    const resolvedLaunch = resume
      ? { ...resume.resolvedLaunch, model: params.model ?? resume.resolvedLaunch.model, thinking: params.thinking ?? resume.resolvedLaunch.thinking }
      : resolveLaunch(host.config, profile!, params);
    if (resolvedLaunch.model) validateModel(resolvedLaunch.model, ctx);
    const id = resume?.id ?? uniqueId(host.records);
    const cwd = resume?.cwd ?? resolve(ctx.cwd, params.cwd ?? ".");
    const artifactRoot = process.env.SUBA_ARTIFACT_ROOT?.trim()
      ? resolve(process.env.SUBA_ARTIFACT_ROOT)
      : join(homedir(), ".pi", "suba", "artifacts");
    const artifactDir = resume?.artifactDir ?? join(artifactRoot, ctx.sessionManager.getSessionId(), id);
    const sessionFile = resume?.sessionFile ?? join(artifactDir, "session.jsonl");
    await mkdir(join(artifactDir, "events"), { recursive: true });
    let resultAfterEntry = 0;
    if (resume) {
      resultAfterEntry = await countSessionEntries(sessionFile);
      await rm(join(artifactDir, "process-exit"), { force: true });
    } else {
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
    promptSnippet: "Launch an asynchronous interactive Pi subagent in tmux",
    parameters: Type.Object({ name: Type.String(), task: Type.String(), profile: Type.Optional(Type.String()), context: Type.Optional(StringEnum(["fresh", "fork"] as const)), model: Type.Optional(ModelSchema), thinking: Type.Optional(ThinkingSchema), cwd: Type.Optional(Type.String()), placement: Type.Optional(PlacementSchema), autoComplete: Type.Optional(Type.Boolean()) }),
    async execute(_id, params, _signal, _update, ctx) {
      const record = await start(params, ctx);
      return {
        content: [{ type: "text", text: `Launched ${record.name} as ${record.id}. Results arrive automatically; do not poll.` }],
        details: {
          id: record.id,
          name: record.name,
          sessionFile: record.sessionFile,
          tmuxTarget: record.paneId,
          profile: record.profile,
          model: record.resolvedLaunch.model,
          thinking: record.resolvedLaunch.thinking,
          placement: record.placement.type,
          status: record.state,
        },
      };
    },
    renderCall(args, theme) {
      const profile = host.profiles.get(args.profile ?? host.config.defaultProfile);
      const model = args.model ?? profile?.model ?? host.config.model;
      const thinking = args.thinking ?? profile?.thinking ?? host.config.thinking;
      const meta = invocationLabel(model, thinking, profile?.name ?? args.profile ?? host.config.defaultProfile);
      const lines = [`${theme.fg("accent", "▸")} ${theme.fg("toolTitle", theme.bold(args.name || "subagent"))}${meta ? theme.fg("dim", `  ${meta}`) : ""}`];
      if (args.task) {
        const count = args.task.split(/\r?\n/).length;
        lines.push(`${theme.fg("toolOutput", oneLine(args.task))}${count > 1 ? theme.fg("muted", ` · ${count} lines`) : ""}`);
      }
      return new Text(lines.join("\n"), 0, 0);
    },
    renderResult(result, { expanded }, theme) {
      const details = result.details as LaunchToolDetails | undefined;
      if (!details) return new Text(theme.fg("dim", toolResultText(result)), 0, 0);
      const meta = invocationLabel(details.model, details.thinking, details.profile);
      const header = `${theme.fg("accent", "●")} ${theme.fg("toolTitle", theme.bold(details.name))}  ${theme.fg("accent", "running")}`;
      const lines = [header, theme.fg("dim", `  ${[meta, details.tmuxTarget].filter(Boolean).join(" · ")}`)];
      if (expanded) {
        lines.push(theme.fg("dim", `  id ${details.id} · ${details.placement}`));
        lines.push(theme.fg("dim", `  session ${details.sessionFile}`));
      }
      return new Text(lines.filter(Boolean).join("\n"), 0, 0);
    },
  });
  pi.registerTool({
    name: "subagent_send", label: "Send to Subagent", description: "Send guidance to a live subagent by stable child ID.", parameters: Type.Object({ id: Type.String(), message: Type.String() }),
    async execute(_call, params) {
      const record = host.records.get(params.id);
      if (!record || !isLive(record) || !record.paneId) throw new Error(`Subagent ${params.id} is not live`);
      await sendToPane(record.paneId, params.message);
      const running = record.state === "awaiting-parent" ? { ...record, revision: record.revision + 1, state: "running" as const } : record;
      if (running !== record) {
        host.records.set(record.id, running);
        host.persist(running);
        host.refreshWidget();
      }
      return {
        content: [{ type: "text", text: `Sent guidance to ${running.name} (${running.id}).` }],
        details: { id: running.id, name: running.name, paneId: running.paneId },
      };
    },
    renderCall(args, theme) {
      const preview = args.message ? `\n${theme.fg("toolOutput", oneLine(args.message))}` : "";
      return new Text(`${theme.fg("accent", "▸")} ${theme.fg("toolTitle", theme.bold(args.id || "subagent"))} ${theme.fg("dim", "guidance")}${preview}`, 0, 0);
    },
    renderResult(result, _options, theme) {
      const details = result.details;
      return details
        ? new Text(`${theme.fg("success", "✓")} ${theme.fg("toolTitle", theme.bold(details.name))} ${theme.fg("dim", "guidance sent")}`, 0, 0)
        : new Text(theme.fg("dim", toolResultText(result)), 0, 0);
    },
  });
  pi.registerTool({
    name: "subagent_resume", label: "Resume Subagent", description: "Resume a completed or exited subagent thread in a new tmux target.",
    parameters: Type.Object({ id: Type.String(), task: Type.String(), placement: Type.Optional(PlacementSchema), model: Type.Optional(ModelSchema), thinking: Type.Optional(ThinkingSchema) }),
    async execute(_call, params, _signal, _update, ctx) {
      const previous = host.records.get(params.id);
      if (!previous) throw new Error(`Unknown subagent: ${params.id}`);
      if (isLive(previous)) throw new Error(`Subagent ${params.id} is already live`);
      const record = await start({ ...params, name: previous.name }, ctx, previous);
      return {
        content: [{ type: "text", text: `Resumed ${record.name} (${record.id}) in ${record.paneId}.` }],
        details: {
          id: record.id,
          name: record.name,
          sessionFile: record.sessionFile,
          tmuxTarget: record.paneId,
          profile: record.profile,
          model: record.resolvedLaunch.model,
          thinking: record.resolvedLaunch.thinking,
          status: record.state,
        },
      };
    },
    renderCall(args, theme) {
      const preview = args.task ? `\n${theme.fg("toolOutput", oneLine(args.task))}` : "";
      return new Text(`${theme.fg("accent", "▸")} ${theme.fg("toolTitle", theme.bold(args.id || "subagent"))} ${theme.fg("dim", "resume")}${preview}`, 0, 0);
    },
    renderResult(result, { expanded }, theme) {
      const details = result.details as LaunchToolDetails | undefined;
      if (!details) return new Text(theme.fg("dim", toolResultText(result)), 0, 0);
      const meta = invocationLabel(details.model, details.thinking, details.profile);
      const lines = [`${theme.fg("accent", "●")} ${theme.fg("toolTitle", theme.bold(details.name))}  ${theme.fg("accent", "running")}`];
      if (meta) lines.push(theme.fg("dim", `  ${meta}${details.tmuxTarget ? ` · ${details.tmuxTarget}` : ""}`));
      if (expanded) lines.push(theme.fg("dim", `  session ${details.sessionFile}`));
      return new Text(lines.join("\n"), 0, 0);
    },
  });
  pi.registerTool({
    name: "subagents_list", label: "List Subagents", description: "List subagent registry and live activity. Use only when status details are needed, not to poll for results.", parameters: Type.Object({ status: Type.Optional(StringEnum(["running", "completed", "all"] as const)) }),
    async execute(_call, params) {
      const records = [...host.records.values()]
        .filter((record) => params.status === "running" ? isLive(record) : params.status === "completed" ? !isLive(record) : true)
        .map((record) => ({
          id: record.id,
          name: record.name,
          profile: record.profile,
          sessionFile: record.sessionFile,
          tmuxTarget: record.paneId,
          state: record.state,
          activity: record.activity,
          model: record.activity?.model ?? record.resolvedLaunch.model,
          thinking: record.activity?.thinking ?? record.resolvedLaunch.thinking,
          elapsedMs: Date.now() - record.startedAt,
          lastResult: record.result,
          error: record.error,
          resumable: !isLive(record),
        }));
      return { content: [{ type: "text", text: JSON.stringify(records, null, 2) }], details: { records } };
    },
    renderCall(args, theme) {
      return new Text(`${theme.fg("toolTitle", theme.bold("subagents"))}${args.status ? theme.fg("dim", ` · ${args.status}`) : ""}`, 0, 0);
    },
    renderResult(result, { expanded }, theme) {
      const records = result.details?.records;
      if (!records) return new Text(theme.fg("dim", toolResultText(result)), 0, 0);
      const container = new Container();
      container.addChild(new Text(`${theme.fg("toolTitle", theme.bold("Subagents"))} ${theme.fg("dim", `· ${records.length}`)}`, 0, 0));
      const visible = expanded ? records : records.slice(0, 5);
      for (const record of visible) {
        const activity = record.state === "awaiting-parent"
          ? "needs guidance"
          : record.activity?.activity === "tool"
            ? record.activity.toolName ?? "tool"
            : record.activity?.activity;
        const meta = [record.state, activity, invocationLabel(record.model, record.thinking), formatElapsed(record.elapsedMs)].filter(Boolean).join(" · ");
        container.addChild(new Text(`${statusGlyph(record.state, theme)} ${theme.fg("toolTitle", theme.bold(record.name))} ${theme.fg("dim", `· ${meta}`)}`, 0, 0));
        if (expanded) {
          container.addChild(new Text(theme.fg("dim", `  id ${record.id}${record.tmuxTarget ? ` · pane ${record.tmuxTarget}` : ""}${record.resumable ? " · resumable" : ""}`), 0, 0));
          if (record.error) container.addChild(new Text(theme.fg("error", `  ${record.error}`), 0, 0));
        }
      }
      if (!expanded && records.length > visible.length) container.addChild(new Text(theme.fg("muted", `… ${records.length - visible.length} more`), 0, 0));
      if (!expanded && records.length) container.addChild(new Text(theme.fg("muted", keyHint("app.tools.expand", "for details")), 0, 0));
      if (!records.length) container.addChild(new Text(theme.fg("muted", "No matching subagents"), 0, 0));
      return container;
    },
  });
}
