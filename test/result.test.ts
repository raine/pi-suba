import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { collapsedCompletedResult, renderSubagentMessage, resultBody, resultBodyLineCount, resultPreview } from "../src/parent/result.ts";

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

  it("extracts guidance and failure bodies", () => {
    expect(resultBody("Subagent research (abc123) needs guidance:\n\nWhich branch?"))
      .toBe("Which branch?");
    expect(resultBody("Subagent research (abc123) failed: provider unavailable"))
      .toBe("provider unavailable");
  });

  it("builds a bounded meaningful preview", () => {
    const content = "Subagent research completed:\n\n# Finding\n\nfirst detail\nsecond detail";
    expect(resultPreview(content, 2)).toEqual({
      lines: ["# Finding", "first detail"],
      hidden: 1,
    });
  });

  it("renders a compact width-safe completion card", () => {
    const theme = {
      fg: (_color: string, text: string) => text,
      bg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    } as never;
    const card = renderSubagentMessage(
      "Subagent research completed:\n\nfirst detail\nsecond detail\nthird detail",
      { name: "research", state: "completed", model: "openai-codex/gpt-5.6-luna", thinking: "low", elapsed: 2500 },
      false,
      "ctrl+o to expand",
      theme,
    );
    const lines = card.render(48);
    expect(lines.join("\n")).toContain("✓ research  completed · 2s");
    expect(lines.join("\n")).toContain("… 1 more line");
    expect(lines.every((line) => visibleWidth(line) <= 48)).toBe(true);
  });
});
