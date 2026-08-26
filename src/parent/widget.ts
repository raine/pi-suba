import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import type { ChildRecord } from "./registry.ts";

export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return seconds < 3600 ? `${minutes}m${(seconds % 60).toString().padStart(2, "0")}s` : `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}
function shortModel(model?: string): string { return (model?.split("/").pop() ?? "default").replace(/^claude-/, "").replace(/-(\d{8}|latest)$/, ""); }

export function projectWidgetRows(records: ChildRecord[], now: number, staleAfterMs: number, maxRows: number): string[] {
  const visible = records.filter((record) => ["launching", "running", "awaiting-parent"].includes(record.state));
  if (!visible.length) return [];
  const rows = [`Subagents · ${visible.length} running`];
  for (const record of visible.slice(0, maxRows)) {
    const stale = !!record.activity && now - record.activity.updatedAt > staleAfterMs;
    const scope = record.state === "awaiting-parent" ? "waiting" : record.activity?.activity === "tool" ? record.activity.toolName ?? "tool" : record.activity?.activity ?? record.activity?.state ?? record.state;
    rows.push(`${record.state === "awaiting-parent" ? "○" : "●"} ${record.name}  ${shortModel(record.activity?.model ?? record.resolvedLaunch.model)} · ${record.activity?.thinking ?? record.resolvedLaunch.thinking ?? "default"}  ${scope}${stale ? " stale" : ""}  ${formatElapsed(now - (record.activity?.activityStartedAt ?? record.startedAt))}`);
  }
  if (visible.length > maxRows) rows.push(`+${visible.length - maxRows} more`);
  return rows;
}

export class ActivityWidget implements Component {
  constructor(private readonly getRows: () => string[]) {}
  render(width: number): string[] {
    return this.getRows().map((line) => visibleWidth(line) <= width ? line : truncateToWidth(line, width));
  }
  invalidate(): void {}
}
