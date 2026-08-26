import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { countSessionEntries, extractResult, forkEntries, seedSession } from "../src/shared/sessions.ts";

const assistant = (text: string, stopReason = "stop", errorMessage?: string) => ({ type: "message", id: Math.random().toString(), message: { role: "assistant", content: [{ type: "text", text }], stopReason, errorMessage } });

describe("sessions", () => {
  it("seeds lineage and excludes the triggering user turn from forks", async () => {
    const entries = [{ type: "message", id: "a", message: { role: "user", content: "old" } }, assistant("answer"), { type: "message", id: "b", message: { role: "user", content: "spawn" } }, assistant("tool")];
    expect(forkEntries(entries)).toEqual(entries.slice(0, 2));
    const dir = await mkdtemp(join(tmpdir(), "suba-session-")); const path = join(dir, "session.jsonl");
    await seedSession(path, "/work", "/parent.jsonl", forkEntries(entries));
    expect(await countSessionEntries(path)).toBe(3);
    expect(JSON.parse((await readFile(path, "utf8")).split("\n")[0]).parentSession).toBe("/parent.jsonl");
  });
  it("extracts only appended results and provider errors", async () => {
    const dir = await mkdtemp(join(tmpdir(), "suba-result-")); const path = join(dir, "session.jsonl");
    await seedSession(path, "/work", undefined, [assistant("old"), assistant("new")]);
    expect(await extractResult(path, 2)).toEqual({ text: "new" });
    await seedSession(path, "/work", undefined, [assistant("", "error", "overloaded")]);
    expect(await extractResult(path)).toEqual({ error: "overloaded" });
  });
});
