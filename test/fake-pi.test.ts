import { spawn } from "node:child_process"
import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { readEvents } from "../src/shared/protocol.ts"
import { extractResult, seedSession } from "../src/shared/sessions.ts"

async function runFake(
  task: string,
  input?: string,
): Promise<{ artifactDir: string; code: number }> {
  const artifactDir = await mkdtemp(join(tmpdir(), "suba-fake-pi-"))
  const sessionFile = join(artifactDir, "session.jsonl")
  await seedSession(sessionFile, process.cwd())
  const child = spawn(
    resolve("test/fixtures/fake-pi"),
    ["--session", sessionFile, "--model", "fake/model", task],
    {
      env: {
        ...process.env,
        SUBA_CHILD_ID: "fixture",
        SUBA_ARTIFACT_DIR: artifactDir,
        SUBA_SESSION_FILE: sessionFile,
        SUBA_AUTO_COMPLETE: "1",
      },
      stdio: ["pipe", "ignore", "pipe"],
    },
  )
  if (input !== undefined) child.stdin.end(input)
  else child.stdin.end()
  const code = await new Promise<number>((resolveCode, reject) => {
    child.on("error", reject)
    child.on("close", (value) => resolveCode(value ?? -1))
  })
  return { artifactDir, code }
}

describe("fake Pi fixture", () => {
  it("records launch arguments and completes", async () => {
    const { artifactDir, code } = await runFake("[fake:complete] inspect files")
    expect(code).toBe(0)
    expect((await readEvents(artifactDir, 0)).at(-1)?.type).toBe("completed")
    expect((await extractResult(join(artifactDir, "session.jsonl"))).text).toContain(
      "inspect files",
    )
    const launch = JSON.parse(await readFile(join(artifactDir, "launch-arguments.json"), "utf8"))
    expect(launch.model).toBe("fake/model")
  })
  it("waits for parent guidance", async () => {
    const { artifactDir } = await runFake("[fake:ping] ask parent", "first line\nsecond line\n")
    expect((await readEvents(artifactDir, 0)).map((event) => event.type)).toEqual([
      "ping",
      "completed",
    ])
    expect(await readFile(join(artifactDir, "received-guidance.txt"), "utf8")).toContain(
      "second line",
    )
  })
  it("supports structured and process failures", async () => {
    const failed = await runFake("[fake:fail-event]")
    expect((await readEvents(failed.artifactDir, 0)).at(-1)?.type).toBe("failed")
    const exited = await runFake("[fake:exit-nonzero]")
    expect(exited.code).toBe(23)
    expect(await readEvents(exited.artifactDir, 0)).toEqual([])
  })
})
