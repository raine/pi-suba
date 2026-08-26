# pi-suba

`pi-suba` launches delegated Pi sessions in visible tmux panes. Parent tool calls
return as soon as tmux accepts the launch. Child completion and help requests
arrive asynchronously in the parent session.

## Install

```sh
pi install /absolute/path/to/pi-suba
```

Run the parent Pi session inside tmux. The package registers these parent tools:

- `subagent`
- `subagent_send`
- `subagent_resume`
- `subagents_list`

Subagent resources live together under `~/.pi/suba/`:

- `config.json` contains machine-readable settings.
- `instructions.md` contains parent-agent instructions.
- `profiles/*.md` contains child profiles.

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
configured defaults above.

```markdown
# Subagent model selection

Use `openai-codex/gpt-5.6-luna` with low thinking for quick, narrow work.
Use `openai-codex/gpt-5.6-sol` with medium thinking for routine work.
Use `openai-codex/gpt-5.6-sol` with xhigh thinking for complex work.
```

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
