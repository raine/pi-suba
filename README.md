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

Global configuration lives at `~/.pi/suba.json`. Profiles live at
`~/.pi/suba/profiles/*.md`.

```json
{
  "defaultProfile": "default",
  "model": "anthropic/claude-sonnet-4-6",
  "thinking": "minimal",
  "placement": { "type": "split" },
  "autoComplete": true,
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

## Development

```sh
npm install
npm test
npm run check
```

Cua sandbox helpers provide deterministic desktop testing with fake child Pi
processes and optional real-model smoke coverage. See `CUA_SANDBOX.md`.
