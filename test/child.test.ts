import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { afterEach, describe, expect, it } from "vitest"
import childExtension from "../src/child/index.ts"
import { readEvents } from "../src/shared/protocol.ts"

type Handler = (event: unknown, ctx: ExtensionContext) => Promise<void> | void
type RegisteredTool = {
  execute: (
    id: string,
    params: Record<string, never>,
    signal: AbortSignal,
    update: () => void,
    ctx: ExtensionContext,
  ) => Promise<{ terminate?: boolean }>
}

const originalChildId = process.env.SUBA_CHILD_ID
const originalArtifactDir = process.env.SUBA_ARTIFACT_DIR
const originalAutoComplete = process.env.SUBA_AUTO_COMPLETE
const temporaryDirectories: string[] = []

afterEach(async () => {
  if (originalChildId === undefined) delete process.env.SUBA_CHILD_ID
  else process.env.SUBA_CHILD_ID = originalChildId
  if (originalArtifactDir === undefined) delete process.env.SUBA_ARTIFACT_DIR
  else process.env.SUBA_ARTIFACT_DIR = originalArtifactDir
  if (originalAutoComplete === undefined) delete process.env.SUBA_AUTO_COMPLETE
  else process.env.SUBA_AUTO_COMPLETE = originalAutoComplete
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  )
})

describe("child completion", () => {
  it("allows completion to retry after an artifact write fails", async () => {
    const artifactDir = await mkdtemp(join(tmpdir(), "pi-suba-child-"))
    temporaryDirectories.push(artifactDir)
    await writeFile(join(artifactDir, "events"), "blocks event directory creation")
    process.env.SUBA_CHILD_ID = "retry"
    process.env.SUBA_ARTIFACT_DIR = artifactDir
    process.env.SUBA_AUTO_COMPLETE = "1"

    const handlers = new Map<string, Handler>()
    const tools = new Map<string, RegisteredTool>()
    const pi = {
      registerTool(tool: RegisteredTool & { name: string }) {
        tools.set(tool.name, tool)
      },
      on(name: string, handler: Handler) {
        handlers.set(name, handler)
      },
    } as unknown as ExtensionAPI
    childExtension(pi)

    let shutdowns = 0
    const ctx = {
      sessionManager: { getBranch: () => [] },
      shutdown: () => {
        shutdowns += 1
      },
    } as unknown as ExtensionContext

    await expect(handlers.get("agent_settled")?.({}, ctx)).rejects.toMatchObject({
      code: "EEXIST",
    })
    expect(shutdowns).toBe(0)

    await rm(join(artifactDir, "events"))
    await mkdir(join(artifactDir, "events"))
    const result = await tools
      .get("suba_done")
      ?.execute("call", {}, new AbortController().signal, () => undefined, ctx)

    expect(result?.terminate).toBe(true)
    expect(shutdowns).toBe(1)
    expect((await readEvents(artifactDir, 0)).map((event) => event.type)).toEqual(["completed"])
  })
})
