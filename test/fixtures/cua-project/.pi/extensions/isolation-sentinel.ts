import { appendFileSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

export default function (pi: ExtensionAPI) {
  pi.on("session_start", () => {
    const marker = process.env.SUBA_ISOLATION_MARKER
    if (!marker) return
    mkdirSync(dirname(marker), { recursive: true })
    appendFileSync(marker, `${process.env.SUBA_CHILD_ID ? "child" : "parent"}\n`, "utf8")
  })
}
