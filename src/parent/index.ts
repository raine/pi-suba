import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { loadConfig, type SubaConfig } from "../shared/config.ts";
import { loadProfiles, type Profile } from "../shared/profiles.ts";
import { tmuxExec } from "../shared/tmux.ts";
import { registerTools, type ManagerHost } from "./tools.ts";
import { isLive, restoreRegistry, type ChildRecord } from "./registry.ts";
import { ChildWatcher } from "./watcher.ts";
import { ActivityWidget, projectWidgetRows } from "./widget.ts";

export default async function (pi: ExtensionAPI) {
  let config: SubaConfig = await loadConfig();
  let profiles: Map<string, Profile> = await loadProfiles();
  const records = new Map<string, ChildRecord>();
  let latestCtx: ExtensionContext | undefined;
  let renderTimer: NodeJS.Timeout | undefined;
  const refreshWidget = () => {
    if (!latestCtx?.hasUI) return;
    const rows = projectWidgetRows([...records.values()], Date.now(), config.activity.staleAfterMs, config.activity.maxRows);
    if (!rows.length) {
      latestCtx.ui.setWidget("suba-activity", undefined);
      if (renderTimer) clearInterval(renderTimer); renderTimer = undefined;
      return;
    }
    latestCtx.ui.setWidget("suba-activity", (tui) => new ActivityWidget(() => projectWidgetRows([...records.values()], Date.now(), config.activity.staleAfterMs, config.activity.maxRows)));
    if (!renderTimer) renderTimer = setInterval(() => refreshWidget(), 1000);
  };
  const host = { config, profiles, records, persist: (record: ChildRecord) => pi.appendEntry("suba-child", record), refreshWidget, watch: (id: string) => void watcher.check(id) } satisfies ManagerHost;
  const callbacks = {
    list: () => [...records.values()],
    get: (id: string) => records.get(id),
    update: (record: ChildRecord, notify?: { type: "result" | "ping"; content: string }) => {
      records.set(record.id, record); pi.appendEntry("suba-child", record); refreshWidget();
      if (!isLive(record) && record.windowId && record.placement.type === "shared-window") void tmuxExec(["select-layout", "-t", record.windowId, "tiled"]).catch(() => undefined);
      if (notify) pi.sendMessage({ customType: "suba-result", content: notify.content, display: true, details: { id: record.id, name: record.name, state: record.state, sessionFile: record.sessionFile, elapsed: Date.now() - record.startedAt } }, { deliverAs: "steer", triggerTurn: true });
    },
    activity: (record: ChildRecord) => { records.set(record.id, record); refreshWidget(); },
  };
  const watcher = new ChildWatcher(config.activity.pollMs, callbacks);
  registerTools(pi, host);
  pi.registerMessageRenderer("suba-result", (message, _options, theme) => {
    const state = (message.details as { state?: string } | undefined)?.state;
    const color = state === "completed" ? "success" : state === "awaiting-parent" ? "warning" : "error";
    return new Text(theme.fg(color, typeof message.content === "string" ? message.content : JSON.stringify(message.content)), 1, 0);
  });
  pi.on("session_start", async (_event, ctx) => {
    latestCtx = ctx; config = await loadConfig(); profiles = await loadProfiles(); host.config = config; host.profiles = profiles;
    records.clear(); for (const [id, record] of restoreRegistry(ctx.sessionManager.getEntries())) records.set(id, record);
    for (const record of records.values()) if (isLive(record)) void watcher.check(record.id);
    watcher.start(); refreshWidget();
  });
  pi.on("session_shutdown", () => { watcher.stop(); if (renderTimer) clearInterval(renderTimer); renderTimer = undefined; latestCtx?.ui.setWidget("suba-activity", undefined); latestCtx = undefined; });
}
