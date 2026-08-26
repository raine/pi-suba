import { readdir } from "node:fs/promises"
import { join } from "node:path"
import { writeEvent, type ChildEvent } from "../shared/protocol.ts"

export class EventWriter {
  private sequence = 0
  constructor(
    private readonly childId: string,
    private readonly artifactDir: string,
  ) {}
  async initialize(): Promise<void> {
    try {
      const names = await readdir(join(this.artifactDir, "events"))
      this.sequence = Math.max(
        0,
        ...names.map((name) => Number.parseInt(name.slice(0, 6), 10)).filter(Number.isFinite),
      )
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
  }
  private async emit(
    event:
      | { type: "ping"; message: string }
      | { type: "completed" }
      | { type: "failed"; error: string },
  ): Promise<void> {
    this.sequence += 1
    await writeEvent(this.artifactDir, {
      ...event,
      version: 1,
      childId: this.childId,
      sequence: this.sequence,
      timestamp: Date.now(),
    } as ChildEvent)
  }
  ping(message: string): Promise<void> {
    return this.emit({ type: "ping", message })
  }
  completed(): Promise<void> {
    return this.emit({ type: "completed" })
  }
  failed(error: string): Promise<void> {
    return this.emit({ type: "failed", error })
  }
}
