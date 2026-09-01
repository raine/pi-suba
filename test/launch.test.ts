import { execFile } from "node:child_process"
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { afterEach, describe, expect, it } from "vitest"
import {
  invocation,
  launchParametersSchema,
  launchScript,
  launchToolDescription,
  parseQualifiedModel,
} from "../src/parent/tools.ts"
import { BUILTIN_DEFAULT_PROFILE, type Profile } from "../src/shared/profiles.ts"

const exec = promisify(execFile)

const originalExecutable = process.env.SUBA_PI_EXECUTABLE

afterEach(() => {
  if (originalExecutable === undefined) delete process.env.SUBA_PI_EXECUTABLE
  else process.env.SUBA_PI_EXECUTABLE = originalExecutable
})

describe("child launch validation", () => {
  it("uses the deterministic executable override", () => {
    process.env.SUBA_PI_EXECUTABLE = "./test/fixtures/fake-pi"
    expect(invocation()).toBe(`'${process.cwd()}/test/fixtures/fake-pi'`)
  })
  it("requires fully qualified model identifiers", () => {
    expect(parseQualifiedModel("openai-codex/gpt-5.6-sol")).toEqual({
      provider: "openai-codex",
      modelId: "gpt-5.6-sol",
    })
    expect(() => parseQualifiedModel("gpt-5.3-codex")).toThrow("fully qualified")
    expect(() => parseQualifiedModel("openai-codex/")).toThrow("fully qualified")
  })
  it("hides profile selection when only the default profile exists", () => {
    const profiles = new Map([["default", BUILTIN_DEFAULT_PROFILE]])
    expect(launchParametersSchema(profiles).properties).not.toHaveProperty("profile")
    expect(launchToolDescription(profiles)).not.toContain("Available profiles")
  })
  it("enumerates profile selection when multiple profiles exist", () => {
    const reviewer: Profile = { ...BUILTIN_DEFAULT_PROFILE, name: "reviewer" }
    const profiles = new Map([
      ["default", BUILTIN_DEFAULT_PROFILE],
      ["reviewer", reviewer],
    ])
    const schema = launchParametersSchema(profiles)
    const properties = schema.properties as Record<string, unknown>
    expect(properties).toHaveProperty("profile")
    expect(properties.profile).toMatchObject({
      enum: ["default", "reviewer"],
    })
    expect(launchToolDescription(profiles)).toContain("Available profiles: default, reviewer")
  })
  it("runs the child process in its requested working directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-suba-launch-"))
    const cwd = join(root, "child cwd")
    const artifactDir = join(root, "artifacts")
    const scriptPath = join(artifactDir, "launch.sh")
    await mkdir(cwd)
    await mkdir(artifactDir)
    process.env.SUBA_PI_EXECUTABLE = process.execPath
    await writeFile(
      scriptPath,
      launchScript(["-e", "process.stdout.write(process.cwd())"], {}, artifactDir, cwd),
      { mode: 0o700 },
    )
    await chmod(scriptPath, 0o700)
    try {
      expect(await realpath((await exec(scriptPath)).stdout)).toBe(await realpath(cwd))
      expect((await readFile(join(artifactDir, "process-exit"), "utf8")).trim()).toBe("0")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
