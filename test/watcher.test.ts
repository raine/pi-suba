import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ChildWatcher } from "../src/parent/watcher.ts";
import type { ChildRecord } from "../src/parent/registry.ts";
import { seedSession } from "../src/shared/sessions.ts";
import { writeEvent } from "../src/shared/protocol.ts";

function makeRecord(dir: string): ChildRecord {
  return { id: "abc", revision: 1, state: "running", sessionFile: join(dir, "session.jsonl"), artifactDir: dir, placement: { type: "split" }, name: "worker", cwd: "/tmp", profile: "default", resolvedLaunch: { profile: "default", tools: "default", loadContext: true, loadSkills: true, systemPrompt: "append", autoComplete: true }, lastEventSequence: 0, startedAt: 1, resultAfterEntry: 1 };
}

describe("parent watcher", () => {
  it("processes completion events once and extracts the run result", async () => {
    const dir = await mkdtemp(join(tmpdir(), "suba-watcher-"));
    const entries = [{ type: "message", id: "reply", message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" } }];
    await seedSession(join(dir, "session.jsonl"), "/tmp", undefined, entries);
    await writeEvent(dir, { version: 1, childId: "abc", sequence: 1, timestamp: 1, type: "completed" });
    let record = makeRecord(dir); const notifications: string[] = [];
    const watcher = new ChildWatcher(500, { list: () => [record], get: () => record, update: (next, notification) => { record = next; if (notification) notifications.push(notification.content); }, activity: (next) => record = next });
    await watcher.check("abc"); await watcher.check("abc");
    expect(record.state).toBe("completed"); expect(record.result).toBe("done"); expect(record.lastEventSequence).toBe(1); expect(notifications).toHaveLength(1);
  });
  it("keeps ping events nonterminal", async () => {
    const dir = await mkdtemp(join(tmpdir(), "suba-ping-")); await seedSession(join(dir, "session.jsonl"), "/tmp");
    await writeEvent(dir, { version: 1, childId: "abc", sequence: 1, timestamp: 1, type: "ping", message: "which API?" });
    let record = makeRecord(dir);
    const watcher = new ChildWatcher(500, { list: () => [record], get: () => record, update: (next) => record = next, activity: (next) => record = next });
    await watcher.check("abc"); expect(record.state).toBe("awaiting-parent");
  });
});
