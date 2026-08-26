import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { runSubaCommand, subaDelegationPrompt } from "../src/parent/commands.ts";

function context(options: { idle: boolean; editor?: string; hasUI?: boolean }): ExtensionCommandContext {
  return {
    hasUI: options.hasUI ?? true,
    isIdle: () => options.idle,
    ui: {
      editor: vi.fn(async () => options.editor),
      notify: vi.fn(),
    },
  } as never;
}

describe("suba command", () => {
  it("builds parent delegation guidance", () => {
    const prompt = subaDelegationPrompt(" Inspect tmux ");
    expect(prompt).toContain("using the subagent tool");
    expect(prompt).toContain("number of subagents based on the independent workstreams");
    expect(prompt).toContain("multiple subagents in parallel");
    expect(prompt).toContain("configured subagent guidance");
    expect(prompt).not.toContain("to one subagent");
    expect(prompt).toContain("\n\nInspect tmux");
  });

  it("sends an immediate delegation request while idle", async () => {
    const sendUserMessage = vi.fn();
    await runSubaCommand({ sendUserMessage } as never, " Inspect tmux ", context({ idle: true }));
    expect(sendUserMessage).toHaveBeenCalledOnce();
    expect(sendUserMessage.mock.calls[0]?.[0]).toContain("Inspect tmux");
    expect(sendUserMessage.mock.calls[0]?.[1]).toBeUndefined();
  });

  it("opens an editor and queues the request while busy", async () => {
    const sendUserMessage = vi.fn();
    const ctx = context({ idle: false, editor: "Review tests" });
    await runSubaCommand({ sendUserMessage } as unknown as ExtensionAPI, "", ctx);
    expect(ctx.ui.editor).toHaveBeenCalledWith("Subagent task", "");
    expect(sendUserMessage).toHaveBeenCalledWith(expect.stringContaining("Review tests"), { deliverAs: "followUp" });
    expect(ctx.ui.notify).toHaveBeenCalledWith("Subagent request queued", "info");
  });
});
