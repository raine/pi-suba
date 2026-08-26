import { describe, expect, it } from "vitest";
import { collapsedCompletedResult, resultBodyLineCount } from "../src/parent/result.ts";

describe("completed result rendering", () => {
  it("counts only child result lines", () => {
    const content = "Subagent research (abc123) completed:\n\nfirst line\nsecond line\n";
    expect(resultBodyLineCount(content)).toBe(2);
    expect(collapsedCompletedResult("research", "abc123", content, "ctrl+o to expand")).toBe(
      "Subagent research (abc123) completed, 2 lines returned. ctrl+o to expand",
    );
  });

  it("handles an empty result", () => {
    expect(resultBodyLineCount("Subagent research completed:\n\n")).toBe(0);
  });
});
