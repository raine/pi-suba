import { validateToolArguments } from "@earendil-works/pi-ai"
import { execFile } from "node:child_process"
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { afterEach, describe, expect, it } from "vitest"
import {
  childControlPrompt,
  childTools,
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
  it.each([false, true])("rejects placement overrides with multiple profiles %s", (multiple) => {
    const profiles = new Map([["default", BUILTIN_DEFAULT_PROFILE]])
    if (multiple) profiles.set("review", { ...BUILTIN_DEFAULT_PROFILE, name: "review" })
    const tool = { name: "suba", description: "", parameters: launchParametersSchema(profiles) }
    for (const type of ["split", "window", "shared-window"]) {
      expect(() =>
        validateToolArguments(tool, {
          type: "toolCall",
          id: "call",
          name: "suba",
          arguments: { name: "child", task: "work", placement: { type } },
        }),
      ).toThrow("Validation failed")
    }
  })
  it("uses the deterministic executable override", () => {
    process.env.SUBA_PI_EXECUTABLE = "./test/fixtures/fake-pi"
    expect(invocation()).toBe(`'${process.cwd()}/test/fixtures/fake-pi'`)
  })
  it("keeps worktree children waiting for parent-verified completion", () => {
    const prompt = childControlPrompt(true)
    expect(prompt).toContain("request merge approval with suba_ask and wait")
    expect(prompt).toContain("When the parent sends /skill:merge")
    expect(prompt).toContain("use suba_ask to report success or a blocker, then wait")
    expect(prompt).toContain("Do not call suba_done for this workflow")
    expect(prompt).toContain("uses suba_finish to record completion")
    expect(childControlPrompt(false)).not.toContain("/skill:merge")
  })
  it("enables configured extension tools alongside the profile policy", () => {
    expect(childTools(["read", "bash"], ["process", "read"])).toEqual([
      "read",
      "bash",
      "process",
      "suba_done",
      "suba_notify",
      "suba_ask",
    ])
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
  it("guides parallel worktree launches through serialized merge approval", () => {
    const profiles = new Map([["default", BUILTIN_DEFAULT_PROFILE]])
    const description = launchToolDescription(profiles)
    expect(description).toContain("Use worktree: true")
    expect(description).toContain("omit it for read-only tasks")
    expect(description).toContain("skills enabled and the merge skill available")
    expect(description).toContain("autoComplete: false")
    expect(description).toContain("suba_ask rather than finish with suba_done")
    expect(description).toContain("one at a time by sending /skill:merge via suba_send")
    expect(description).toContain("instructions appended after a space, not a newline")
    expect(description).toContain("use suba_ask to report success or a blocker, then wait")
    expect(description).toContain("verify integration and call suba_finish")
    expect(description).toContain("Leave blocked children open")
    expect(launchParametersSchema(profiles).properties.worktree).toMatchObject({
      description: expect.stringContaining("/skill:merge"),
    })
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
