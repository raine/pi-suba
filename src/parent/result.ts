import { getMarkdownTheme, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Container, Markdown, Spacer, Text, type Component } from "@earendil-works/pi-tui";
import type { RegistryState } from "./registry.ts";
import { formatElapsed, shortModel } from "./widget.ts";

type Theme = ExtensionContext["ui"]["theme"];

export interface SubagentMessageDetails {
  id?: string;
  name?: string;
  state?: RegistryState;
  sessionFile?: string;
  paneId?: string;
  profile?: string;
  model?: string;
  thinking?: string;
  elapsed?: number;
  error?: string;
}

export function resultBody(content: string): string {
  const separator = content.indexOf("\n\n");
  if (separator >= 0) return content.slice(separator + 2).trimEnd();
  const prefix = content.match(/^Subagent\s+.+?\s+(?:failed|was interrupted[^:]*):?\s*/s);
  return (prefix ? content.slice(prefix[0].length) : content).trim();
}

export function resultBodyLines(content: string): string[] {
  const lines = resultBody(content).split(/\r?\n/).map((line) => line.trimEnd());
  while (lines.length && !lines[0]?.trim()) lines.shift();
  while (lines.length && !lines.at(-1)?.trim()) lines.pop();
  return lines;
}

export function resultPreview(content: string, maxLines = 2): { lines: string[]; hidden: number } {
  const meaningful = resultBodyLines(content).filter((line) => line.trim());
  const lines = meaningful.slice(0, Math.max(0, maxLines));
  return { lines, hidden: Math.max(0, meaningful.length - lines.length) };
}

export function resultBodyLineCount(content: string): number {
  return resultBodyLines(content).length;
}

export function collapsedCompletedResult(name: string, id: string, content: string, expansionHint: string): string {
  const count = resultBodyLineCount(content);
  const lines = `${count} ${count === 1 ? "line" : "lines"} returned`;
  return `Subagent ${name} (${id}) completed, ${lines}. ${expansionHint}`;
}

function presentation(state: RegistryState | undefined): {
  glyph: string;
  label: string;
  tone: "success" | "warning" | "error";
  background: "toolSuccessBg" | "toolPendingBg" | "toolErrorBg";
} {
  if (state === "completed") return { glyph: "✓", label: "completed", tone: "success", background: "toolSuccessBg" };
  if (state === "awaiting-parent") return { glyph: "?", label: "needs guidance", tone: "warning", background: "toolPendingBg" };
  if (state === "interrupted") return { glyph: "■", label: "interrupted", tone: "warning", background: "toolPendingBg" };
  if (state === "orphaned") return { glyph: "✗", label: "orphaned", tone: "error", background: "toolErrorBg" };
  return { glyph: "✗", label: "failed", tone: "error", background: "toolErrorBg" };
}

function invocationDetails(details: SubagentMessageDetails): string[] {
  const values: string[] = [];
  if (details.model) values.push(shortModel(details.model));
  if (details.thinking) values.push(details.thinking);
  if (details.profile) values.push(details.profile);
  return values;
}

function expandedMetadata(details: SubagentMessageDetails, theme: Theme): Component | undefined {
  const lines: string[] = [];
  const invocation = [
    details.model ? `model ${details.model}` : undefined,
    details.thinking ? `thinking ${details.thinking}` : undefined,
    details.profile ? `profile ${details.profile}` : undefined,
  ].filter((value): value is string => !!value);
  if (invocation.length) lines.push(invocation.join(" · "));
  const identity = [
    details.id ? `id ${details.id}` : undefined,
    details.paneId ? `pane ${details.paneId}` : undefined,
  ].filter((value): value is string => !!value);
  if (identity.length) lines.push(identity.join(" · "));
  if (details.sessionFile) lines.push(`session ${details.sessionFile}`);
  return lines.length ? new Text(theme.fg("dim", lines.join("\n")), 0, 0) : undefined;
}

export function renderSubagentMessage(
  content: string,
  details: SubagentMessageDetails,
  expanded: boolean,
  expansionHint: string,
  theme: Theme,
): Component {
  const state = presentation(details.state);
  const container = new Container();
  const elapsed = details.elapsed === undefined ? undefined : formatElapsed(details.elapsed);
  const status = [state.label, elapsed].filter(Boolean).join(" · ");
  const header = `${theme.fg(state.tone, state.glyph)} ${theme.fg("toolTitle", theme.bold(details.name ?? "subagent"))}  ${theme.fg(state.tone, status)}`;
  container.addChild(new Text(header, 0, 0));

  const invocation = invocationDetails(details);
  if (invocation.length) container.addChild(new Text(theme.fg("dim", `  ${invocation.join(" · ")}`), 0, 0));

  const body = resultBody(content) || details.error || (details.state === "completed" ? "(no assistant text)" : content);
  if (expanded) {
    container.addChild(new Spacer(1));
    container.addChild(new Markdown(body, 0, 0, getMarkdownTheme()));
    const metadata = expandedMetadata(details, theme);
    if (metadata) {
      container.addChild(new Spacer(1));
      container.addChild(metadata);
    }
  } else {
    const preview = resultPreview(body, details.state === "awaiting-parent" ? 3 : 2);
    if (preview.lines.length) {
      container.addChild(new Spacer(1));
      container.addChild(new Text(preview.lines.map((line) => theme.fg("toolOutput", line)).join("\n"), 0, 0));
    }
    if (preview.hidden) container.addChild(new Text(theme.fg("muted", `… ${preview.hidden} more ${preview.hidden === 1 ? "line" : "lines"}`), 0, 0));
    container.addChild(new Text(theme.fg("muted", expansionHint), 0, 0));
  }

  const box = new Box(1, 0, (text) => theme.bg(state.background, text));
  box.addChild(container);
  return box;
}
