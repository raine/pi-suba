import { keyHint, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent"
import { loadConfig, type SubaConfig } from "../shared/config.ts"
import { loadInstructions } from "../shared/instructions.ts"
import { loadProfiles, type Profile } from "../shared/profiles.ts"
import { tmuxExec } from "../shared/tmux.ts"
import { registerCommands } from "./commands.ts"
import { registerTools, type ManagerHost } from "./tools.ts"
import { isLive, restoreRegistry, type ChildRecord } from "./registry.ts"
import { renderSubagentMessage, type SubagentMessageDetails } from "./result.ts"
import { ChildWatcher } from "./watcher.ts"
import { ActivityWidget, projectWidget } from "./widget.ts"

export default async function (pi: ExtensionAPI) {
  let config: SubaConfig = await loadConfig()
  let instructions = await loadInstructions()
  let profiles: Map<string, Profile> = await loadProfiles()
  const records = new Map<string, ChildRecord>()
  let latestCtx: ExtensionContext | undefined
  let renderTimer: NodeJS.Timeout | undefined
  const refreshWidget = () => {
    if (!latestCtx?.hasUI) return
    const projection = projectWidget([...records.values()], Date.now(), config.activity.maxRows)
    if (!projection.activeCount) {
      latestCtx.ui.setWidget("suba-activity", undefined)
      if (renderTimer) clearInterval(renderTimer)
      renderTimer = undefined
      return
    }
    latestCtx.ui.setWidget(
      "suba-activity",
      (_tui, theme) =>
        new ActivityWidget(
          () => projectWidget([...records.values()], Date.now(), config.activity.maxRows),
          theme,
        ),
      { placement: "aboveEditor" },
    )
    if (!renderTimer) renderTimer = setInterval(() => refreshWidget(), 1000)
  }
  const host = {
    config,
    profiles,
    records,
    persist: (record: ChildRecord) => pi.appendEntry("suba-child", record),
    refreshWidget,
    watch: (id: string) => void watcher.check(id),
  } satisfies ManagerHost
  const callbacks = {
    list: () => [...records.values()],
    get: (id: string) => records.get(id),
    update: (record: ChildRecord, notify?: { type: "result" | "ping"; content: string }) => {
      records.set(record.id, record)
      pi.appendEntry("suba-child", record)
      refreshWidget()
      if (!isLive(record) && record.windowId && record.placement.type === "shared-window")
        void tmuxExec(["select-layout", "-t", record.windowId, "tiled"]).catch(() => undefined)
      if (notify)
        pi.sendMessage(
          {
            customType: "suba-result",
            content: notify.content,
            display: true,
            details: {
              id: record.id,
              name: record.name,
              state: record.state,
              sessionFile: record.sessionFile,
              paneId: record.paneId,
              profile: record.profile,
              model: record.activity?.model ?? record.resolvedLaunch.model,
              thinking: record.activity?.thinking ?? record.resolvedLaunch.thinking,
              elapsed: Date.now() - record.startedAt,
              error: record.error,
            } satisfies SubagentMessageDetails,
          },
          { deliverAs: "steer", triggerTurn: true },
        )
    },
    activity: (record: ChildRecord) => {
      records.set(record.id, record)
      refreshWidget()
    },
  }
  const watcher = new ChildWatcher(config.activity.pollMs, callbacks)
  registerTools(pi, host)
  registerCommands(pi, () => host.profiles.values())
  pi.registerMessageRenderer("suba-result", (message, options, theme) => {
    const details = (message.details ?? {}) as SubagentMessageDetails
    const content =
      typeof message.content === "string" ? message.content : JSON.stringify(message.content)
    return renderSubagentMessage(
      content,
      details,
      options.expanded,
      keyHint("app.tools.expand", "to expand"),
      theme,
    )
  })
  pi.on("before_agent_start", (event) => {
    if (!instructions) return
    return { systemPrompt: `${event.systemPrompt}\n\n${instructions}` }
  })
  pi.on("session_start", async (_event, ctx) => {
    latestCtx = ctx
    config = await loadConfig()
    instructions = await loadInstructions()
    profiles = await loadProfiles()
    host.config = config
    host.profiles = profiles
    records.clear()
    for (const [id, record] of restoreRegistry(ctx.sessionManager.getEntries()))
      records.set(id, record)
    for (const record of records.values()) if (isLive(record)) void watcher.check(record.id)
    watcher.start()
    refreshWidget()
  })
  pi.on("session_shutdown", () => {
    watcher.stop()
    if (renderTimer) clearInterval(renderTimer)
    renderTimer = undefined
    latestCtx?.ui.setWidget("suba-activity", undefined)
    latestCtx = undefined
  })
}
