import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, parseConfig, parsePlacement } from "../src/shared/config.ts";

describe("configuration", () => {
  it("applies package defaults", () => expect(parseConfig({})).toEqual(DEFAULT_CONFIG));
  it("parses supported settings", () => expect(parseConfig({ defaultProfile: "explore", thinking: "high", placement: { type: "window", windowName: "agents" }, activity: { pollMs: 200, staleAfterMs: 1000, maxRows: 3 } })).toMatchObject({ defaultProfile: "explore", thinking: "high", placement: { type: "window", windowName: "agents" }, activity: { pollMs: 200, staleAfterMs: 1000, maxRows: 3 } }));
  it("rejects unsupported keys and bounds", () => {
    expect(() => parseConfig({ surprise: true })).toThrow("unsupported key");
    expect(() => parseConfig({ activity: { pollMs: 10 } })).toThrow("between 100");
    expect(() => parsePlacement({ type: "split", windowName: "bad" })).toThrow("invalid for split");
  });
});
