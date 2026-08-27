import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent"

interface DelegationProfile {
  name: string
  description?: string
}

function profileLines(profiles: Iterable<DelegationProfile>): string[] {
  return [...profiles]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(({ name, description }) => {
      const summary = description?.replace(/\s+/g, " ").trim()
      return summary ? `  ${name}: ${summary}` : `  ${name}`
    })
}

export function subaDelegationPrompt(task: string, profiles: Iterable<DelegationProfile>): string {
  return [
    "Use subagents to accomplish the overall objective below.",
    "Analyze the objective and assign each subagent a focused task based on the independent workstreams you identify.",
    "Use multiple subagents in parallel when targets or investigations can be handled independently; otherwise use one.",
    "Before launching a fresh subagent, ensure it can understand its assignment without the parent conversation.",
    "If needed, materialize relevant context in one or more handoff files, create those files before launching dependent subagents, and name the applicable files in each subagent's task.",
    "Use fork only when required context cannot be captured adequately in the task or handoff files.",
    "Choose each model and thinking level using the configured subagent guidance.",
    "Give each subagent a concise descriptive name and do not poll for results.",
    "Choose profiles only from this list of available subagent profiles:",
    ...profileLines(profiles),
    "",
    "The objective is for the parent agent to coordinate. Derive focused subagent tasks from it.",
    "<objective>",
    task.trim(),
    "</objective>",
  ].join("\n")
}

export async function runSubaCommand(
  pi: ExtensionAPI,
  args: string,
  ctx: ExtensionCommandContext,
  profiles: Iterable<DelegationProfile>,
): Promise<void> {
  let task = args.trim()
  if (!task) {
    if (!ctx.hasUI) {
      ctx.ui.notify("Usage: /suba <task>", "warning")
      return
    }
    task = (await ctx.ui.editor("Subagent task", ""))?.trim() ?? ""
  }
  if (!task) return

  const prompt = subaDelegationPrompt(task, profiles)
  if (ctx.isIdle()) {
    pi.sendUserMessage(prompt)
    return
  }
  pi.sendUserMessage(prompt, { deliverAs: "followUp" })
  ctx.ui.notify("Subagent request queued", "info")
}

export function registerCommands(
  pi: ExtensionAPI,
  profiles: () => Iterable<DelegationProfile>,
): void {
  pi.registerCommand("suba", {
    description: "Delegate work to one or more subagents",
    handler: (args, ctx) => runSubaCommand(pi, args, ctx, profiles()),
  })
}
