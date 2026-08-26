import { afterEach, describe, expect, it } from "vitest";
import { invocation } from "../src/parent/tools.ts";

const originalExecutable = process.env.SUBA_PI_EXECUTABLE;

afterEach(() => {
  if (originalExecutable === undefined) delete process.env.SUBA_PI_EXECUTABLE;
  else process.env.SUBA_PI_EXECUTABLE = originalExecutable;
});

describe("child executable resolution", () => {
  it("uses the deterministic executable override", () => {
    process.env.SUBA_PI_EXECUTABLE = "./test/fixtures/fake-pi";
    expect(invocation()).toBe(`'${process.cwd()}/test/fixtures/fake-pi'`);
  });
});
