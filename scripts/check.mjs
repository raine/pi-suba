#!/usr/bin/env node
import { spawn } from "node:child_process"
import { createInterface } from "node:readline"

const JOBS = [
  {
    label: "types",
    color: "\x1b[38;5;81m",
    cmd: "npm",
    args: ["exec", "tsgo", "--", "--noEmit"],
  },
  {
    label: "test",
    color: "\x1b[38;5;114m",
    cmd: "npm",
    args: ["exec", "vitest", "--", "run"],
  },
  {
    label: "lint",
    color: "\x1b[38;5;213m",
    cmd: "npm",
    args: ["exec", "oxlint", "--", "--type-aware", "--deny-warnings"],
  },
]

function parseMode(argv) {
  const args = argv.slice(2)
  const arg = args.shift() ?? ""
  if (args.length > 0) {
    throw new Error("usage: check.mjs [--verbose|--quiet]")
  }
  if (arg === "" || arg === "--quiet") return "quiet"
  if (arg === "-v" || arg === "--verbose") return "verbose"
  throw new Error("usage: check.mjs [--verbose|--quiet]")
}

const isTTY = process.stdout.isTTY ?? false
const ansi = (code) => (isTTY ? code : "")
const RESET = ansi("\x1b[0m")
const BOLD = ansi("\x1b[1m")
const DIM = ansi("\x1b[2m")
const GREEN = ansi("\x1b[32m")
const RED = ansi("\x1b[31m")

function prefix(job) {
  return `${ansi(job.color)}${BOLD}${job.label}${RESET}${DIM} |${RESET} `
}

const live = new Set()
let shutdownReason = null

function killTree(child, signal = "SIGTERM") {
  if (child.proc.pid === undefined) return
  try {
    process.kill(-child.proc.pid, signal)
  } catch {}
}

function shutdown(reason, signal = "SIGTERM") {
  if (shutdownReason !== null) return
  shutdownReason = reason
  for (const child of live) killTree(child, signal)
}

process.on("SIGINT", () => shutdown("user-signal", "SIGINT"))
process.on("SIGTERM", () => shutdown("user-signal", "SIGTERM"))

function capture(stream, onLine) {
  const rl = createInterface({ input: stream, terminal: false })
  rl.on("line", onLine)
}

function spawnJob(job, mode) {
  const proc = spawn(job.cmd, job.args, {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...(isTTY ? { FORCE_COLOR: "1" } : {}) },
  })

  const buf = []
  const onLine = (line) => {
    if (mode === "verbose") process.stdout.write(`${prefix(job)}${line}\n`)
    else buf.push(line)
  }

  if (proc.stdout === null || proc.stderr === null) {
    throw new Error(`spawn for ${job.label} produced null stdio pipes`)
  }
  capture(proc.stdout, onLine)
  capture(proc.stderr, onLine)

  const done = new Promise((resolve) => {
    proc.once("close", (code, signal) => {
      resolve({
        label: job.label,
        code: code ?? (signal === null ? 1 : 128 + 15),
        killed: signal !== null,
      })
    })
    proc.once("error", (err) => {
      buf.push(`spawn error: ${err.message}`)
      resolve({ label: job.label, code: 127, killed: false })
    })
  })

  return { job, proc, buf, done }
}

function reportOutcome(child, outcome, mode) {
  if (outcome.code === 0) {
    process.stdout.write(`${GREEN}${BOLD}PASS${RESET} ${outcome.label}\n`)
    return true
  }

  process.stdout.write(
    `${RED}${BOLD}FAIL${RESET} ${outcome.label} ${DIM}(exit ${outcome.code})${RESET}\n`,
  )

  if (mode === "quiet") {
    const p = prefix(child.job)
    for (const line of child.buf) process.stdout.write(`${p}${line}\n`)
  }

  return false
}

async function main() {
  const mode = parseMode(process.argv)
  let fail = false

  for (const job of JOBS) live.add(spawnJob(job, mode))
  const pending = new Set(live)

  while (pending.size > 0) {
    const { child, outcome } = await Promise.race(
      [...pending].map(async (candidate) => ({
        child: candidate,
        outcome: await candidate.done,
      })),
    )
    pending.delete(child)
    live.delete(child)

    if (outcome.killed && shutdownReason !== null) continue

    if (reportOutcome(child, outcome, mode)) continue

    fail = true
    shutdown("fail-fast")
  }

  return shutdownReason === "user-signal" ? 130 : fail ? 1 : 0
}

main().then(
  (code) => {
    process.exitCode = code
  },
  (err) => {
    shutdown("fail-fast")
    console.error(err)
    process.exitCode = 1
  },
)
