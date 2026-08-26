import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

export function subaDelegationPrompt(task: string): string {
  return [
    "Delegate the following task to one subagent using the subagent tool.",
    "Choose the model and thinking level using the configured subagent guidance.",
    "Give the subagent a concise descriptive name and do not poll for results.",
    "",
    task.trim(),
  ].join("\n");
}

export async function runSubaCommand(
  pi: ExtensionAPI,
  args: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  let task = args.trim();
  if (!task) {
    if (!ctx.hasUI) {
      ctx.ui.notify("Usage: /suba <task>", "warning");
      return;
    }
    task = (await ctx.ui.editor("Subagent task", ""))?.trim() ?? "";
  }
  if (!task) return;

  const prompt = subaDelegationPrompt(task);
  if (ctx.isIdle()) {
    pi.sendUserMessage(prompt);
    return;
  }
  pi.sendUserMessage(prompt, { deliverAs: "followUp" });
  ctx.ui.notify("Subagent request queued", "info");
}

export function registerCommands(pi: ExtensionAPI): void {
  pi.registerCommand("suba", {
    description: "Delegate a task to a subagent",
    handler: (args, ctx) => runSubaCommand(pi, args, ctx),
  });
}
