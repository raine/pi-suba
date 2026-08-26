import { afterEach, describe, expect, it } from "vitest";
import { invocation, parseQualifiedModel } from "../src/parent/tools.ts";

const originalExecutable = process.env.SUBA_PI_EXECUTABLE;

afterEach(() => {
  if (originalExecutable === undefined) delete process.env.SUBA_PI_EXECUTABLE;
  else process.env.SUBA_PI_EXECUTABLE = originalExecutable;
});

describe("child launch validation", () => {
  it("uses the deterministic executable override", () => {
    process.env.SUBA_PI_EXECUTABLE = "./test/fixtures/fake-pi";
    expect(invocation()).toBe(`'${process.cwd()}/test/fixtures/fake-pi'`);
  });
  it("requires fully qualified model identifiers", () => {
    expect(parseQualifiedModel("openai-codex/gpt-5.6-sol")).toEqual({ provider: "openai-codex", modelId: "gpt-5.6-sol" });
    expect(() => parseQualifiedModel("gpt-5.3-codex")).toThrow("fully qualified");
    expect(() => parseQualifiedModel("openai-codex/")).toThrow("fully qualified");
  });
});
