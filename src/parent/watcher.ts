import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { readActivity, readEvents, type ChildEvent } from "../shared/protocol.ts"
import { extractResult } from "../shared/sessions.ts"
import { paneExists } from "../shared/tmux.ts"
import type { ChildRecord } from "./registry.ts"

export interface WatcherCallbacks {
  list(): ChildRecord[]
  get(id: string): ChildRecord | undefined
  update(record: ChildRecord, notify?: { type: "result" | "ping"; content: string }): void
  activity(record: ChildRecord): void
}

export class ChildWatcher {
  private timer?: NodeJS.Timeout
  private ticking = false
  constructor(
    private readonly pollMs: number,
    private readonly callbacks: WatcherCallbacks,
  ) {}
  start(): void {
    if (!this.timer) this.timer = setInterval(() => void this.tick(), this.pollMs)
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }
  async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      for (const record of this.callbacks.list()) await this.check(record.id)
    } finally {
      this.ticking = false
    }
  }
  async check(id: string): Promise<void> {
    let record = this.callbacks.get(id)
    if (!record || !["launching", "running", "awaiting-parent"].includes(record.state)) return
    try {
      const activity = await readActivity(join(record.artifactDir, "activity.json"), id)
      if (!record.activity || activity.sequence > record.activity.sequence) {
        record = { ...record, activity, activityError: undefined }
        this.callbacks.activity(record)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        record = {
          ...record,
          activityError: error instanceof Error ? error.message : String(error),
        }
        this.callbacks.activity(record)
      }
    }
    let events: ChildEvent[]
    try {
      events = await readEvents(record.artifactDir, record.lastEventSequence)
    } catch (error) {
      this.callbacks.activity({
        ...record,
        activityError: error instanceof Error ? error.message : String(error),
      })
      return
    }
    for (const event of events) {
      if (event.childId !== id || event.sequence !== record.lastEventSequence + 1) {
        this.callbacks.activity({
          ...record,
          activityError: `invalid event sequence ${event.sequence}`,
        })
        return
      }
      record = {
        ...record,
        revision: record.revision + 1,
        lastEventSequence: event.sequence,
      }
      if (event.type === "ping") {
        record.state = "awaiting-parent"
        this.callbacks.update(record, {
          type: "ping",
          content: `Subagent ${record.name} (${id}) needs guidance:\n\n${event.message}`,
        })
      } else if (event.type === "failed") {
        record.state = "failed"
        record.error = event.error
        this.callbacks.update(record, {
          type: "result",
          content: `Subagent ${record.name} (${id}) failed: ${event.error}`,
        })
        return
      } else {
        const result = await extractResult(record.sessionFile, record.resultAfterEntry)
        record.state = result.error ? "failed" : "completed"
        record.error = result.error
        record.result = result.text
        const content = result.error
          ? `Subagent ${record.name} (${id}) failed: ${result.error}`
          : `Subagent ${record.name} (${id}) completed:\n\n${result.text ?? "(no assistant text)"}`
        this.callbacks.update(record, { type: "result", content })
        return
      }
    }
    record = this.callbacks.get(id) ?? record
    if (!["launching", "running", "awaiting-parent"].includes(record.state)) return
    const exitPath = join(record.artifactDir, "process-exit")
    try {
      const exitCode = Number.parseInt((await readFile(exitPath, "utf8")).trim(), 10)
      const result = await extractResult(record.sessionFile, record.resultAfterEntry)
      const failed = exitCode !== 0 || !!result.error
      const next = {
        ...record,
        revision: record.revision + 1,
        state: failed ? ("failed" as const) : ("completed" as const),
        result: result.text,
        error: result.error ?? (exitCode ? `Pi exited with status ${exitCode}` : undefined),
      }
      this.callbacks.update(next, {
        type: "result",
        content: failed
          ? `Subagent ${record.name} (${id}) failed: ${next.error}`
          : `Subagent ${record.name} (${id}) completed:\n\n${next.result ?? "(no assistant text)"}`,
      })
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    if (record.paneId && !(await paneExists(record.paneId))) {
      const next = {
        ...record,
        revision: record.revision + 1,
        state: "interrupted" as const,
        error: "tmux pane closed before completion",
      }
      this.callbacks.update(next, {
        type: "result",
        content: `Subagent ${record.name} (${id}) was interrupted because its tmux pane closed.`,
      })
    }
  }
}
