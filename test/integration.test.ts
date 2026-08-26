import { execFile } from "node:child_process"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
import { afterAll, describe, expect, it } from "vitest"
import { readActivity, readEvents } from "../src/shared/protocol.ts"
import { extractResult, seedSession } from "../src/shared/sessions.ts"
const exec = promisify(execFile)
const model = process.env.SUBA_TEST_MODEL
const timeout = Number(process.env.SUBA_TEST_TIMEOUT ?? 120_000)
const socket = `pi-suba-real-${process.pid}`
const quote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`

async function waitForCompletion(artifactDir: string): Promise<void> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const events = await readEvents(artifactDir, 0)
    if (events.some((event) => event.type === "completed" || event.type === "failed")) return
    await new Promise((resolveWait) => setTimeout(resolveWait, 500))
  }
  throw new Error(
    `Pi child did not complete within ${timeout}ms. Check model authentication and SUBA_TEST_MODEL.`,
  )
}

describe.skipIf(!model)("real Pi integration", () => {
  afterAll(async () => {
    try {
      await exec("tmux", ["-L", socket, "kill-server"])
    } catch {}
  })
  it(
    "runs a persistent interactive child through automatic completion",
    async () => {
      await exec("tmux", ["-V"])
      const artifactDir = await mkdtemp(join(tmpdir(), "pi-suba-real-"))
      const sessionFile = join(artifactDir, "session.jsonl")
      await seedSession(sessionFile, process.cwd())
      const childExtension = resolve("src/child/index.ts")
      const command = [
        `SUBA_CHILD_ID=realtest`,
        `SUBA_ARTIFACT_DIR=${quote(artifactDir)}`,
        `SUBA_AUTO_COMPLETE=1`,
        "pi",
        "--no-extensions",
        "-e",
        quote(childExtension),
        "--tools",
        "suba_done,suba_ping",
        "--no-context-files",
        "--no-skills",
        "--session",
        quote(sessionFile),
        "--model",
        quote(model!),
        quote("Reply with exactly: pi-suba integration ok"),
      ].join(" ")
      await exec("tmux", ["-L", socket, "new-session", "-d", "-s", "real", command])
      await waitForCompletion(artifactDir)
      const events = await readEvents(artifactDir, 0)
      expect(events.at(-1)?.type).toBe("completed")
      expect((await extractResult(sessionFile)).text?.toLowerCase()).toContain(
        "pi-suba integration ok",
      )
      const activity = await readActivity(join(artifactDir, "activity.json"), "realtest")
      expect(activity.state).toBe("done")
      expect(activity.model).toBeTruthy()
      expect(
        (await readFile(sessionFile, "utf8")).split("\n").filter(Boolean).length,
      ).toBeGreaterThan(1)
      await rm(artifactDir, { recursive: true, force: true })
    },
    timeout + 10_000,
  )
})
