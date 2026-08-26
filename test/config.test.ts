import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, parseConfig, parsePlacement, resolveChildExtensionSource } from "../src/shared/config.ts";

describe("configuration", () => {
  it("applies package defaults", () => expect(parseConfig({})).toEqual(DEFAULT_CONFIG));
  it("parses supported settings", () => expect(parseConfig({ defaultProfile: "explore", thinking: "high", placement: { type: "window", windowName: "agents" }, childExtensions: ["../../code/pi-cc-tools-local"], activity: { pollMs: 200, staleAfterMs: 1000, maxRows: 3 } })).toMatchObject({ defaultProfile: "explore", thinking: "high", placement: { type: "window", windowName: "agents" }, childExtensions: ["../../code/pi-cc-tools-local"], activity: { pollMs: 200, staleAfterMs: 1000, maxRows: 3 } }));
  it("resolves configured local sources from the Pi agent directory", () => {
    expect(resolveChildExtensionSource("../../code/pi-cc-tools-local", "/Users/example/.pi/agent")).toBe("/Users/example/code/pi-cc-tools-local");
    expect(resolveChildExtensionSource("npm:example")).toBe("npm:example");
  });
  it("rejects unsupported keys and bounds", () => {
    expect(() => parseConfig({ surprise: true })).toThrow("unsupported key");
    expect(() => parseConfig({ activity: { pollMs: 10 } })).toThrow("between 100");
    expect(() => parseConfig({ childExtensions: ["same", "same"] })).toThrow("duplicates");
    expect(() => parsePlacement({ type: "split", windowName: "bad" })).toThrow("invalid for split");
  });
});
