import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent"
import { describe, expect, it, vi } from "vitest"
import { runSubaCommand, subaDelegationPrompt } from "../src/parent/commands.ts"

function context(options: { idle: boolean; editor?: string; hasUI?: boolean }): {
  ctx: ExtensionCommandContext
  editor: ReturnType<typeof vi.fn>
  notify: ReturnType<typeof vi.fn>
} {
  const editor = vi.fn(async () => options.editor)
  const notify = vi.fn()
  const ctx = {
    hasUI: options.hasUI ?? true,
    isIdle: () => options.idle,
    ui: { editor, notify },
  } as never
  return { ctx, editor, notify }
}

const profiles = [
  { name: "default" },
  { name: "reviewer", description: "Review code without editing" },
]

describe("suba command", () => {
  it("builds parent delegation guidance", () => {
    const prompt = subaDelegationPrompt(" Inspect tmux ", profiles)
    expect(prompt).toContain("Use subagents to accomplish the overall objective")
    expect(prompt).toContain("assign each subagent a focused task")
    expect(prompt).toContain("multiple subagents in parallel")
    expect(prompt).toContain(
      "ensure it can understand its assignment without the parent conversation",
    )
    expect(prompt).toContain("materialize relevant context in one or more handoff files")
    expect(prompt).toContain("create those files before launching dependent subagents")
    expect(prompt).toContain("name the applicable files in each subagent's task")
    expect(prompt).toContain(
      "required context cannot be captured adequately in the task or handoff files",
    )
    expect(prompt).toContain("configured subagent guidance")
    expect(prompt).toContain("window named after each subagent")
    expect(prompt).toContain("Use shared-window only when grouping children")
    expect(prompt).toContain("Results and guidance requests arrive automatically")
    expect(prompt).toContain("Never use sleep or repeated suba_list calls to wait")
    expect(prompt).toContain(
      "available subagent profiles:\n  default\n  reviewer: Review code without editing",
    )
    expect(prompt).not.toContain("to one subagent")
    expect(prompt).toContain("objective is for the parent agent to coordinate")
    expect(prompt).toContain("\n<objective>\nInspect tmux\n</objective>")
  })

  it("sends an immediate delegation request while idle", async () => {
    const sendUserMessage = vi.fn()
    const { ctx } = context({ idle: true })
    await runSubaCommand({ sendUserMessage } as never, " Inspect tmux ", ctx, profiles)
    expect(sendUserMessage).toHaveBeenCalledOnce()
    expect(sendUserMessage.mock.calls[0]?.[0]).toContain("Inspect tmux")
    expect(sendUserMessage.mock.calls[0]?.[1]).toBeUndefined()
  })

  it("opens an editor and queues the request while busy", async () => {
    const sendUserMessage = vi.fn()
    const { ctx, editor, notify } = context({
      idle: false,
      editor: "Review tests",
    })
    await runSubaCommand({ sendUserMessage } as unknown as ExtensionAPI, "", ctx, profiles)
    expect(editor).toHaveBeenCalledWith("Subagent task", "")
    expect(sendUserMessage).toHaveBeenCalledWith(expect.stringContaining("Review tests"), {
      deliverAs: "followUp",
    })
    expect(notify).toHaveBeenCalledWith("Subagent request queued", "info")
  })
})
