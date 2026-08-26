import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ThinkingLevel } from "../shared/protocol.ts";
import { ActivityRecorder } from "./activity.ts";
import { EventWriter } from "./events.ts";

type Lifecycle = "running" | "awaiting-parent" | "completing" | "terminated";

export default function (pi: ExtensionAPI) {
  const childId = process.env.SUBA_CHILD_ID;
  const artifactDir = process.env.SUBA_ARTIFACT_DIR;
  if (!childId || !artifactDir) throw new Error("pi-suba child extension requires SUBA_CHILD_ID and SUBA_ARTIFACT_DIR");
  const automatic = process.env.SUBA_AUTO_COMPLETE !== "0";
  const activity = new ActivityRecorder(childId, artifactDir);
  const events = new EventWriter(childId, artifactDir);
  let lifecycle: Lifecycle = "running";

  const latestAssistantError = (ctx: ExtensionContext): string | undefined => {
    const branch = ctx.sessionManager.getBranch() as Array<{ type?: string; message?: { role?: string; stopReason?: string; errorMessage?: string } }>;
    for (let index = branch.length - 1; index >= 0; index--) {
      const message = branch[index]?.message;
      if (branch[index]?.type === "message" && message?.role === "assistant") return message.stopReason === "error" ? message.errorMessage || "provider request failed" : undefined;
    }
    return undefined;
  };
  const finish = async (ctx: ExtensionContext, explicit = false): Promise<boolean> => {
    if (lifecycle !== "running") return false;
    lifecycle = "completing";
    const error = explicit ? undefined : latestAssistantError(ctx);
    if (error) await events.failed(error); else await events.completed();
    await activity.done();
    lifecycle = "terminated";
    ctx.shutdown();
    return true;
  };

  pi.registerTool({
    name: "subagent_done", label: "Subagent Done", description: "Finish this delegated task immediately. The latest assistant text becomes the parent result.", parameters: Type.Object({}),
    async execute(_id, _params, _signal, _update, ctx) { await finish(ctx, true); return { content: [{ type: "text", text: "Subagent completion recorded. Shutting down." }], details: {}, terminate: true }; },
  });
  pi.registerTool({
    name: "caller_ping", label: "Caller Ping", description: "Ask the parent agent for guidance without closing this Pi session. The current run stops until guidance arrives.", parameters: Type.Object({ message: Type.String({ description: "Question or requested parent action" }) }),
    async execute(_id, params) {
      if (lifecycle !== "running") throw new Error(`caller_ping is unavailable while lifecycle is ${lifecycle}`);
      lifecycle = "awaiting-parent"; await events.ping(params.message); await activity.waiting();
      return { content: [{ type: "text", text: "Parent guidance requested. Waiting for input." }], details: {}, terminate: true };
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    await events.initialize(); await activity.starting();
    if (ctx.model) await activity.selected(ctx.model.provider, ctx.model.id);
    await activity.thinking(ctx.thinkingLevel as ThinkingLevel);
  });
  pi.on("input", async () => { if (lifecycle === "awaiting-parent") { lifecycle = "running"; await activity.model(); } });
  pi.on("agent_start", () => activity.model());
  pi.on("turn_start", () => activity.model());
  pi.on("before_provider_request", () => activity.model());
  pi.on("message_update", () => activity.streaming());
  pi.on("tool_execution_start", (event) => activity.tool(event.toolName));
  pi.on("tool_execution_update", (event) => activity.tool(event.toolName));
  pi.on("tool_execution_end", () => activity.model());
  pi.on("model_select", (event) => activity.selected(event.model.provider, event.model.id));
  pi.on("thinking_level_select", (event) => activity.thinking(event.level as ThinkingLevel));
  pi.on("agent_settled", async (_event, ctx) => { if (automatic && lifecycle === "running") await finish(ctx); });
  pi.on("session_shutdown", async () => { if (lifecycle !== "terminated" && lifecycle !== "awaiting-parent") await activity.done(); });
}
