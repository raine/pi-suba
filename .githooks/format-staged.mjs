#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

const FORMAT_EXTS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".mts",
  ".cts",
  ".json",
  ".jsonc",
])

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim()
}

const repoRoot = git("rev-parse", "--show-toplevel")
process.chdir(repoRoot)

const stagedRaw = execFileSync(
  "git",
  ["diff", "--cached", "--name-only", "-z", "--diff-filter=ACMR"],
  { encoding: "utf8" },
)
const allStaged = stagedRaw.split("\0").filter(Boolean)
const targets = allStaged.filter((path) => {
  const dot = path.lastIndexOf(".")
  return dot >= 0 && FORMAT_EXTS.has(path.slice(dot))
})

if (targets.length === 0) process.exit(0)

const tmp = mkdtempSync(join(tmpdir(), "format-staged-"))
process.on("exit", () => rmSync(tmp, { recursive: true, force: true }))

const tmpTree = join(tmp, "tree")
const tmpIndex = join(tmp, "index")
mkdirSync(tmpTree, { recursive: true })
copyFileSync(git("rev-parse", "--git-path", "index"), tmpIndex)

const originals = new Map()
const lsOut = execFileSync("git", ["ls-files", "-s", "--", ...targets], {
  encoding: "utf8",
})
for (const line of lsOut.split("\n").filter(Boolean)) {
  const tab = line.indexOf("\t")
  const [mode, sha] = line.slice(0, tab).split(" ")
  const path = line.slice(tab + 1)
  if (mode && sha) originals.set(path, { mode, sha })
}

const checkout = spawnSync("git", ["checkout-index", "-z", "--stdin", "-f"], {
  input: `${targets.join("\0")}\0`,
  env: { ...process.env, GIT_INDEX_FILE: tmpIndex, GIT_WORK_TREE: tmpTree },
  stdio: ["pipe", "inherit", "inherit"],
})
if (checkout.status !== 0) {
  console.error("[format-staged] git checkout-index failed")
  process.exit(1)
}

for (const name of [".gitignore", ".oxfmtrc.json", ".oxfmtrc.jsonc"]) {
  const src = join(repoRoot, name)
  if (existsSync(src)) copyFileSync(src, join(tmpTree, name))
}

const oxfmtBin = join(
  repoRoot,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "oxfmt.cmd" : "oxfmt",
)
const tmpPaths = targets.map((path) => join(tmpTree, path))
const fmt = spawnSync(oxfmtBin, ["--write", ...tmpPaths], {
  cwd: tmpTree,
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, FORCE_COLOR: "1" },
})
if (fmt.status !== 0) {
  process.stdout.write(fmt.stdout)
  process.stderr.write(fmt.stderr)
  console.error("[format-staged] oxfmt failed")
  process.exit(1)
}

let changed = 0
let synced = 0
for (const path of targets) {
  const orig = originals.get(path)
  if (!orig) continue

  const tmpPath = join(tmpTree, path)
  const newSha = execFileSync("git", ["hash-object", "-w", "--path", path, tmpPath], {
    encoding: "utf8",
  }).trim()
  if (newSha === orig.sha) continue

  execFileSync("git", ["update-index", "--cacheinfo", `${orig.mode},${newSha},${path}`])
  changed++

  let wtSha
  try {
    wtSha = execFileSync("git", ["hash-object", "--", path], {
      encoding: "utf8",
    }).trim()
  } catch {
    continue
  }
  if (wtSha !== orig.sha) continue

  const workTreePath = join(repoRoot, path)
  mkdirSync(dirname(workTreePath), { recursive: true })
  copyFileSync(tmpPath, workTreePath)
  synced++
}

if (changed > 0) {
  const detail = synced === changed ? "" : ` (${changed - synced} kept due to unstaged edits)`
  console.log(`[format-staged] formatted ${changed} staged file(s)${detail}`)
}
