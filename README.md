# pi-suba

`pi-suba` launches delegated Pi sessions in visible tmux panes. Parent tool calls
return as soon as tmux accepts the launch. Child completion and help requests
arrive asynchronously in the parent session.

## Install

```sh
pi install npm:pi-suba
```

Run the parent Pi session inside tmux. The package registers these parent tools:

- `suba`
- `suba_send`
- `suba_resume`
- `suba_list`

The `/suba <task>` command asks the parent agent to delegate one task using the
model-selection guidance in `instructions.md`. Running `/suba` without arguments
opens a multiline task editor. Requests entered while the parent is busy are
queued as follow-up messages.

Subagent resources live together under `~/.pi/suba/`:

- `config.json` contains machine-readable settings.
- `instructions.md` contains parent-agent instructions.
- `profiles/*.md` contains child profiles.
- `artifacts/` contains parent-session and child-run state.

```json
{
  "defaultProfile": "default",
  "model": "openai-codex/gpt-5.6-sol",
  "thinking": "medium",
  "placement": { "type": "split" },
  "autoComplete": true,
  "childExtensions": [
    "../../code/pi-cc-tools-local",
    "../../code/pi-extensions/packages/pi-codex-compaction"
  ],
  "activity": { "pollMs": 500, "staleAfterMs": 15000, "maxRows": 8 },
  "sharedWindowName": "suba"
}
```

A profile is Markdown with frontmatter:

```markdown
---
name: explore
description: Read-only exploration
model: anthropic/claude-haiku-4-5
thinking: low
tools: read-only
load-context: false
load-skills: false
system-prompt: append
auto-complete: true
---

Investigate the delegated task without modifying files.
```

Supported tool policies are `default` (`read,bash,edit,write`) and `read-only`
(`read,bash`). Child control tools are included automatically.

`instructions.md` is appended to the parent system prompt. It supports ordinary
Markdown for model-selection policy and other delegation guidance. Explicit
model selections must use a fully qualified `provider/model` identifier and must
be in the current model scope. Omitting `model` and `thinking` uses the
configured defaults above. Child context is fresh when `context` is omitted.
A fresh child receives no parent conversation. Before launching one, ensure its
task is self-contained. When relevant context belongs in handoff files, create
them before launching dependent children and name the applicable files in each
child's task. Different children can use shared or different handoffs. Use
`context: "fork"` only when required context cannot be captured adequately in
the task or handoff files.

```markdown
# Subagent model selection

Use `openai-codex/gpt-5.6-luna` with low thinking when the task requires little
reasoning. Task size alone does not require a stronger model.

Use `openai-codex/gpt-5.6-sol` with medium thinking for routine work.
Use `openai-codex/gpt-5.6-sol` with xhigh thinking for complex work.
```

Completed child reports remain available to the parent model while the TUI shows
a compact bounded preview. Expand tool output to inspect the full report.

`childExtensions` lists Pi packages or extension files loaded explicitly in every
child while automatic extension discovery remains disabled. Relative local paths
use `~/.pi/agent` as their base, matching relative package sources in
`~/.pi/agent/settings.json`. Absolute paths, `~/` paths, and package sources such
as `npm:package-name` are also accepted.

## Development

```sh
npm install
npm test
npm run check
```

Cua sandbox helpers provide deterministic desktop testing with fake child Pi
processes and optional real-model smoke coverage. See `CUA_SANDBOX.md`.

## Release

Releases require an upstream Git branch, npm authentication, and the
`npm-release` command from
[`rust-release-tools`](https://github.com/raine/rust-release-tools).

```sh
just release          # patch release
just release minor
just release major
just release current  # release the version already in package.json
```

The release command updates the package version and changelog, validates the
package, creates and pushes the release commit, publishes to npm, and creates
and pushes the version tag. npm may prompt for a two-factor authentication code.
