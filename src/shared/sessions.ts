import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

interface Entry { type: string; id?: string; message?: { role?: string; content?: unknown; stopReason?: string; errorMessage?: string }; [key: string]: unknown }

export async function seedSession(path: string, cwd: string, parentSession?: string, entries: Entry[] = []): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const header = { type: "session", version: 3, id: randomUUID(), timestamp: new Date().toISOString(), cwd, ...(parentSession ? { parentSession } : {}) };
  await writeFile(path, [header, ...entries].map((entry) => JSON.stringify(entry)).join("\n") + "\n", { encoding: "utf8", mode: 0o600 });
}

export function forkEntries(entries: Entry[]): Entry[] {
  const active = [...entries];
  for (let index = active.length - 1; index >= 0; index--) {
    if (active[index]?.type === "message" && active[index]?.message?.role === "user") return active.slice(0, index);
  }
  return active;
}

export async function countSessionEntries(path: string): Promise<number> {
  const raw = await readFile(path, "utf8");
  return raw.split("\n").filter(Boolean).length;
}

export async function extractResult(path: string, afterEntry = 0): Promise<{ text?: string; error?: string }> {
  const lines = (await readFile(path, "utf8")).split("\n").filter(Boolean).slice(afterEntry);
  const entries = lines.map((line) => JSON.parse(line) as Entry);
  for (let index = entries.length - 1; index >= 0; index--) {
    const message = entries[index]?.message;
    if (entries[index]?.type !== "message" || message?.role !== "assistant") continue;
    if (message.stopReason === "error") return { error: message.errorMessage || "provider request failed" };
    const content = Array.isArray(message.content) ? message.content : [];
    const text = content.filter((part): part is { type: "text"; text: string } => !!part && typeof part === "object" && (part as { type?: string }).type === "text" && typeof (part as { text?: unknown }).text === "string").map((part) => part.text).join("\n").trim();
    if (text) return { text };
  }
  return {};
}
