import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTarget, paneExists, sendToPane, type TmuxExec } from "../src/shared/tmux.ts";
const exec = promisify(execFile); const socket = `pi-suba-test-${process.pid}`;
const run: TmuxExec = async (args, input) => {
  if (input === undefined) return (await exec("tmux", ["-L", socket, ...args])).stdout.trim();
  const child = execFile("tmux", ["-L", socket, ...args]); child.stdin?.end(input);
  return await new Promise((resolve, reject) => { let out = "", err = ""; child.stdout?.on("data", (d) => out += d); child.stderr?.on("data", (d) => err += d); child.on("close", (code) => code === 0 ? resolve(out.trim()) : reject(new Error(err))); });
};

describe.skipIf(!process.env.PATH)("tmux integration", () => {
  let parentPane = "";
  beforeAll(async () => { try { await exec("tmux", ["-V"]); } catch { return; } await run(["new-session", "-d", "-s", "test", "-P", "-F", "#{pane_id}", "sleep 60"]).then((value) => parentPane = value); });
  afterAll(async () => { try { await run(["kill-server"]); } catch {} });
  it("creates stable panes and sends literal and multiline input", async () => {
    if (!parentPane) return;
    const target = await createTarget({ type: "split" }, parentPane, "cat > /tmp/pi-suba-tmux-input", "child", "suba", run);
    expect(target.paneId).toMatch(/^%/); expect(await paneExists(target.paneId, run)).toBe(true);
    await sendToPane(target.paneId, "one line", run);
  });
  it("creates and tiles a shared window", async () => {
    if (!parentPane) return;
    const first = await createTarget({ type: "shared-window", windowName: "agents" }, parentPane, "sleep 60", "one", "suba", run);
    const second = await createTarget({ type: "shared-window", windowName: "agents" }, parentPane, "sleep 60", "two", "suba", run);
    expect(first.paneId).not.toBe(second.paneId);
  });
});
