import { join } from "node:path";
import type { ThinkingLevel } from "../shared/protocol.ts";
import { atomicWriteJson, type ChildActivity } from "../shared/protocol.ts";

export class ActivityRecorder {
  private sequence = 0;
  private snapshot: ChildActivity;
  constructor(private readonly childId: string, private readonly artifactDir: string) {
    this.snapshot = { version: 1, childId, sequence: 0, updatedAt: Date.now(), state: "starting" };
  }
  async update(patch: Partial<Omit<ChildActivity, "version" | "childId" | "sequence" | "updatedAt">>): Promise<void> {
    this.sequence += 1;
    this.snapshot = { ...this.snapshot, ...patch, version: 1, childId: this.childId, sequence: this.sequence, updatedAt: Date.now() };
    await atomicWriteJson(join(this.artifactDir, "activity.json"), this.snapshot);
  }
  starting(): Promise<void> { return this.update({ state: "starting", activity: undefined, toolName: undefined, activityStartedAt: Date.now() }); }
  model(): Promise<void> { return this.update({ state: "working", activity: "model", toolName: undefined, activityStartedAt: Date.now() }); }
  streaming(): Promise<void> { return this.update({ state: "working", activity: "streaming", toolName: undefined, activityStartedAt: this.snapshot.activity === "streaming" ? this.snapshot.activityStartedAt : Date.now() }); }
  tool(name: string): Promise<void> { return this.update({ state: "working", activity: "tool", toolName: name, activityStartedAt: Date.now() }); }
  waiting(): Promise<void> { return this.update({ state: "waiting", activity: undefined, toolName: undefined, activityStartedAt: Date.now() }); }
  done(): Promise<void> { return this.update({ state: "done", activity: undefined, toolName: undefined, activityStartedAt: Date.now() }); }
  selected(provider: string, model: string): Promise<void> { return this.update({ provider, model }); }
  thinking(thinking: ThinkingLevel): Promise<void> { return this.update({ thinking }); }
}
