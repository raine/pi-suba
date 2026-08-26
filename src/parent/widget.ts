import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import type { ChildRecord } from "./registry.ts";

type Theme = ExtensionContext["ui"]["theme"];

export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return seconds < 3600
    ? `${minutes}m${(seconds % 60).toString().padStart(2, "0")}s`
    : `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

export function shortModel(model?: string): string {
  return (model?.split("/").pop() ?? "default")
    .replace(/^claude-/, "")
    .replace(/-(\d{8}|latest)$/, "");
}

export interface WidgetItem {
  id: string;
  name: string;
  state: "running" | "waiting";
  activity: string;
  stale: boolean;
  model: string;
  thinking: string;
  elapsed: string;
}

export interface WidgetProjection {
  activeCount: number;
  items: WidgetItem[];
  overflow: number;
}

function activityLabel(record: ChildRecord): string {
  if (record.state === "awaiting-parent") return "needs guidance";
  if (record.activity?.activity === "tool") return record.activity.toolName ?? "using tool";
  if (record.activity?.activity === "streaming") return "responding";
  if (record.activity?.activity === "model") return "thinking";
  if (record.activity?.state === "starting") return "starting";
  if (record.activity?.state === "waiting") return "waiting";
  return record.state;
}

export function projectWidget(
  records: ChildRecord[],
  now: number,
  staleAfterMs: number,
  maxRows: number,
): WidgetProjection {
  const active = records.filter((record) => ["launching", "running", "awaiting-parent"].includes(record.state));
  const items = active.slice(0, Math.max(0, maxRows)).map((record): WidgetItem => ({
    id: record.id,
    name: record.name,
    state: record.state === "awaiting-parent" ? "waiting" : "running",
    activity: activityLabel(record),
    stale: !!record.activity && now - record.activity.updatedAt > staleAfterMs,
    model: shortModel(record.activity?.model ?? record.resolvedLaunch.model),
    thinking: record.activity?.thinking ?? record.resolvedLaunch.thinking ?? "default",
    elapsed: formatElapsed(now - (record.activity?.activityStartedAt ?? record.startedAt)),
  }));
  return { activeCount: active.length, items, overflow: Math.max(0, active.length - items.length) };
}

export function projectWidgetRows(records: ChildRecord[], now: number, staleAfterMs: number, maxRows: number): string[] {
  const projection = projectWidget(records, now, staleAfterMs, maxRows);
  if (!projection.activeCount) return [];
  const rows = [`Subagents · ${projection.activeCount} active`];
  for (const item of projection.items) {
    const glyph = item.state === "waiting" ? "?" : item.stale ? "!" : "●";
    const stale = item.stale ? " stale" : "";
    rows.push(`${glyph} ${item.name} · ${item.activity}${stale} · ${item.model} · ${item.thinking} · ${item.elapsed}`);
  }
  if (projection.overflow) rows.push(`+${projection.overflow} more`);
  return rows;
}

export function rightAlign(left: string, right: string, width: number): string {
  if (width <= 0) return "";
  const rightWidth = visibleWidth(right);
  if (rightWidth >= width) return truncateToWidth(right, width);
  const leftWidth = Math.max(0, width - rightWidth - 1);
  const fittedLeft = truncateToWidth(left, leftWidth);
  const gap = Math.max(1, width - visibleWidth(fittedLeft) - rightWidth);
  return truncateToWidth(`${fittedLeft}${" ".repeat(gap)}${right}`, width);
}

function borderLine(fill: string, width: number, theme: Theme): string {
  if (width <= 0) return "";
  if (width === 1) return theme.fg("accent", fill[0] ?? "");
  return theme.fg("accent", `${fill[0]}${"─".repeat(Math.max(0, width - 2))}${fill[1]}`);
}

function headerLine(count: number, width: number, theme: Theme): string {
  if (width < 4) return borderLine("╭╮", width, theme);
  const innerWidth = width - 2;
  const title = "─ Subagents ";
  const status = ` ${count} active ─`;
  if (visibleWidth(title) + visibleWidth(status) > innerWidth) {
    return `${theme.fg("accent", "╭")}${truncateToWidth(theme.fg("toolTitle", theme.bold(` Subagents · ${count} `)), innerWidth)}${theme.fg("accent", "╮")}`;
  }
  const fill = "─".repeat(innerWidth - visibleWidth(title) - visibleWidth(status));
  return theme.fg("accent", `╭${title}${fill}${status}╮`);
}

export class ActivityWidget implements Component {
  constructor(
    private readonly getProjection: () => WidgetProjection,
    private readonly theme: Theme,
  ) {}

  render(width: number): string[] {
    const projection = this.getProjection();
    if (!projection.activeCount || width <= 0) return [];
    if (width < 4) return [truncateToWidth(this.theme.fg("accent", `${projection.activeCount}●`), width)];
    const lines = [headerLine(projection.activeCount, width, this.theme)];
    const innerWidth = Math.max(0, width - 2);
    for (const item of projection.items) {
      const glyph = item.state === "waiting"
        ? this.theme.fg("warning", "?")
        : item.stale
          ? this.theme.fg("warning", "!")
          : this.theme.fg("accent", "●");
      const activityTone = item.state === "waiting" || item.stale ? "warning" : "dim";
      const stale = item.stale ? " · stale" : "";
      const left = ` ${glyph} ${this.theme.bold(item.name)} ${this.theme.fg(activityTone, `· ${item.activity}${stale}`)}`;
      const detailParts = innerWidth >= 52 ? [item.model, item.thinking, item.elapsed] : [item.elapsed];
      const right = this.theme.fg("dim", `${detailParts.join(" · ")} `);
      const body = rightAlign(left, right, innerWidth);
      const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(body)));
      lines.push(`${this.theme.fg("accent", "│")}${body}${padding}${this.theme.fg("accent", "│")}`);
    }
    if (projection.overflow) {
      const text = this.theme.fg("dim", ` +${projection.overflow} more`);
      const body = truncateToWidth(text, innerWidth);
      lines.push(`${this.theme.fg("accent", "│")}${body}${" ".repeat(Math.max(0, innerWidth - visibleWidth(body)))}${this.theme.fg("accent", "│")}`);
    }
    lines.push(borderLine("╰╯", width, this.theme));
    return lines;
  }

  invalidate(): void {}
}
