import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { loadInstructions } from "../src/shared/instructions.ts"

const paths: string[] = []
afterEach(async () => {
  await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe("parent instructions", () => {
  it("loads trimmed Markdown", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-suba-instructions-"))
    paths.push(dir)
    const path = join(dir, "instructions.md")
    await writeFile(path, "\n# Model selection\n\nUse the configured OAuth models.\n")
    expect(await loadInstructions(path)).toBe(
      "# Model selection\n\nUse the configured OAuth models.",
    )
  })

  it("allows a missing instructions file", async () => {
    expect(await loadInstructions(join(tmpdir(), `missing-pi-suba-${Date.now()}.md`))).toBe("")
  })
})
