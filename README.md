# pi-suba

`pi-suba` is my spin on subagents in [Pi](https://pi.dev): delegated Pi sessions running visibly
in tmux.

Each subagent opens in a tmux pane or window, so you can watch it work, inspect its output, and type
into its session. Launches return immediately. Results and help requests arrive asynchronously in
the parent session.

## Why pi-suba?

- **Visible:** every child is a real Pi TUI, not a hidden background process.
- **Non-blocking:** the parent can keep working while children run.
- **Interactive:** the parent or user can send guidance to a live child.
- **Asynchronous:** completion, failure, and help requests start a new parent turn automatically.
- **Flexible:** choose models, thinking levels, tool access, context, prompts, extensions, and tmux
  placement per child.
- **Resumable:** continue a completed or interrupted child's existing session.

## Requirements

- [Pi](https://pi.dev)
- `tmux` on `PATH`
- A parent Pi session running inside tmux

## Install

```sh
pi install npm:pi-suba
```

Start Pi inside tmux:

```sh
tmux new -s pi
pi
```

## Quick start

Ask the parent to delegate an objective:

```text
/suba investigate the flaky login tests and fix the root cause
```

The parent identifies focused workstreams, launches one or more children, and continues without
waiting. Each child appears in tmux. When a child finishes or asks for guidance, its message appears
in the parent conversation and starts a new turn.

Running `/suba` without arguments opens a multiline task editor. If the parent is busy, the request
is queued as a follow-up.

## How configuration fits together

`pi-suba` works without any configuration files. Add them only when you want to customize how the
parent delegates or how children launch:

| Resource | Controls |
| --- | --- |
| `config.json` | Global launch defaults, placement, extensions, and activity display |
| `instructions.md` | When and how the parent should delegate |
| `profiles/*.md` | Reusable child models, tools, context loading, and system prompts |
| `suba` arguments | Overrides for one child launch |
| `artifacts/` | Generated child sessions and runtime state |

The parent uses `instructions.md` to decide whether delegation fits the task. A launch selects a
profile, then applies any explicit tool arguments. Where the same model, thinking, or completion
setting appears in multiple places, the launch value wins over the profile, and the profile wins
over `config.json`.

A typical setup starts with `instructions.md`. Add `config.json` when you want shared defaults, and
add profiles when distinct kinds of children need different capabilities.

## How it works

1. The parent calls `suba` with a name and a focused task.
2. `pi-suba` creates a child session and launches Pi in tmux.
3. The child reports activity and lifecycle events through files under `~/.pi/suba/artifacts/`.
4. A parent-side watcher updates the activity widget and delivers results.
5. The child completes automatically when settled, unless automatic completion is disabled.

The parent tool call returns as soon as tmux accepts the launch. Results are pushed to the parent,
so the parent should never sleep or repeatedly poll for completion.

## Delegation and context

Children use fresh context by default. A fresh child receives the task, but not the parent
conversation. Make the assignment self-contained or name handoff files that contain the required
context.

Use `context: "fork"` only when the task depends on conversation history that cannot be captured
cleanly in the assignment or handoff files. Forking copies the parent branch up to, but not
including, the latest user message.

For work with shared context:

1. Write the context to a handoff file.
2. Create the file before launching dependent children.
3. Name the file and explain its purpose in each child's task.

## Parent tools

| Tool          | Purpose                                               |
| ------------- | ----------------------------------------------------- |
| `suba`        | Launch a child and return immediately                 |
| `suba_send`   | Send guidance to a live child by ID                   |
| `suba_resume` | Continue a completed or exited child's session        |
| `suba_list`   | Take a one-time snapshot of child status and activity |

The `suba` tool accepts:

| Parameter      | Description                                                  |
| -------------- | ------------------------------------------------------------ |
| `name`         | Short label for the child                                    |
| `task`         | Focused, self-contained assignment                           |
| `profile`      | Child profile name, exposed when multiple profiles exist     |
| `context`      | `fresh` or `fork`                                            |
| `model`        | Fully qualified `provider/model` identifier                  |
| `thinking`     | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max` |
| `cwd`          | Working directory, resolved relative to the parent directory |
| `placement`    | `split`, `window`, or `shared-window`                        |
| `autoComplete` | Per-launch automatic completion override                     |

Explicit models must exist in Pi's model registry and belong to the active model scope.

## Child tools

Every child receives two control tools in addition to its profile's tools:

| Tool        | Purpose                                                 |
| ----------- | ------------------------------------------------------- |
| `suba_done` | Finish immediately and return the latest assistant text |
| `suba_ping` | Ask the parent for guidance without closing the session |

When a child calls `suba_ping`, it enters an awaiting-parent state. The parent receives the question
and can answer with `suba_send`. You can also focus the child's tmux pane and type directly into it.

## Configuration

Subagent resources live under `~/.pi/suba/`:

```text
~/.pi/suba/
├── config.json
├── instructions.md
├── profiles/
└── artifacts/
```

All files are optional. Configuration and profiles have built-in defaults. Without
`instructions.md`, the extension adds no standing delegation policy to the parent prompt.

### `config.json`

```json
{
  "defaultProfile": "default",
  "model": "openai-codex/gpt-5.6-sol",
  "thinking": "medium",
  "placement": { "type": "split" },
  "autoComplete": true,
  "childExtensions": ["npm:some-pi-package"],
  "activity": {
    "pollMs": 500,
    "maxRows": 8
  },
  "sharedWindowName": "suba"
}
```

| Setting                 | Built-in default      | Purpose                                     |
| ----------------------- | --------------------- | ------------------------------------------- |
| `defaultProfile`        | `"default"`           | Profile used when a launch omits one        |
| `model`                 | Pi default            | Default child model                         |
| `thinking`              | Pi default            | Default child thinking level                |
| `placement`             | `{ "type": "split" }` | Default tmux placement                      |
| `autoComplete`          | `true`                | Finish a child when its agent settles       |
| `childExtensions`       | `[]`                  | Additional extensions loaded in every child |
| `activity.pollMs`       | `500`                 | Parent watcher interval in milliseconds     |
| `activity.maxRows`      | `8`                   | Maximum rows in the activity widget         |
| `sharedWindowName`      | `"suba"`              | Default shared-window name                  |

Model, thinking, and automatic completion settings resolve in this order:

1. Launch override
2. Profile
3. Global configuration
4. Pi default, where applicable

Children start with automatic extension discovery disabled. `childExtensions` lists the packages or
files loaded explicitly in every child. It accepts npm package sources, absolute paths, `~/` paths,
and relative paths. Relative paths resolve from `~/.pi/agent`, matching relative package sources in
Pi settings.

Configuration and profiles are read when the parent session starts.

### `instructions.md`

`~/.pi/suba/instructions.md` is appended to the parent system prompt. It is user policy rather than
required extension configuration. Use it to describe when delegation is appropriate, which context
style to prefer, and how the parent should select profiles or models.

This is a reasonable starting point:

```markdown
# Subagent delegation

Use subagents when the user explicitly requests delegation or when a task has a clearly independent
workstream that the parent will not also perform.

Do not launch a child merely to duplicate the parent's analysis. Prefer fresh context and make each
task self-contained. Use fork only when the required context cannot be captured in the task or in
handoff files.

# Subagent model selection

Use the configured model and thinking defaults unless a different available model is a better fit
for the delegated task.
```

Replace the model-selection paragraph with concrete model and thinking guidance when you want the
parent to route different kinds of work differently.

## Profiles

Profiles are Markdown files under `~/.pi/suba/profiles/`. Frontmatter controls how the child
launches, and the Markdown body becomes part of its system prompt.

```markdown
---
name: explore
description: Read-only investigation
model: anthropic/claude-haiku-4-5
thinking: low
tools: read-only
load-context: false
load-skills: false
system-prompt: append
auto-complete: true
---

Investigate the delegated task without modifying files. Report concrete findings with relevant file
paths.
```

Supported fields:

| Field           | Default        | Description                          |
| --------------- | -------------- | ------------------------------------ |
| `name`          | File name      | Profile identifier                   |
| `description`   | None           | Summary shown to the parent          |
| `model`         | Global setting | Fully qualified child model          |
| `thinking`      | Global setting | Child thinking level                 |
| `tools`         | `default`      | Tool policy                          |
| `load-context`  | `true`         | Load Pi context files                |
| `load-skills`   | `true`         | Load Pi skills                       |
| `system-prompt` | `append`       | Append or replace Pi's system prompt |
| `auto-complete` | Global setting | Profile completion behavior          |

Two tool policies are available:

| Policy      | Child tools                     |
| ----------- | ------------------------------- |
| `default`   | `read`, `bash`, `edit`, `write` |
| `read-only` | `read`, `bash`                  |

Both policies also include `suba_done` and `suba_ping`. `read-only` limits Pi's direct tool
selection, but `bash` can still modify the filesystem. It is not a security boundary.

A built-in `default` profile is always available. It uses the default tool policy, loads context
files and skills, and adds no profile prompt. Create `profiles/default.md` to customize it.

## Tmux placement

Launches use the configured placement by default. Per-launch placement is an explicit override for user-requested layouts.

| Placement       | Behavior                                                     |
| --------------- | ------------------------------------------------------------ |
| `split`         | Open beside the parent, then stack additional children below |
| `window`        | Open a dedicated tmux window named after the child           |
| `shared-window` | Tile multiple children in one named tmux window              |

Example per-launch placement values:

```json
{ "type": "split" }
```

```json
{ "type": "window" }
```

```json
{ "type": "shared-window", "windowName": "review" }
```

## Activity, completion, and resume

While children are live, the parent TUI shows an activity widget above the editor. It includes each
child's state, current model or tool activity, thinking level, and elapsed time.

Completed reports appear as compact previews. Expand the message with Pi's normal tool-output
control to read the full report and metadata.

With automatic completion enabled, a child finishes when its agent settles. Set `autoComplete` or
profile `auto-complete` to `false` to keep it interactive until it calls `suba_done`, exits, or
receives more input.

If a child closes before recording completion, it is marked interrupted. Use `suba_resume` with its
stable child ID to continue the same session with a new task.

## Artifacts and environment variables

Each child stores its session, prompt files, activity, lifecycle events, launch script, and process
status under:

```text
~/.pi/suba/artifacts/<parent-session-id>/<child-id>/
```

The parent registry is persisted in the parent Pi session, so reopening that session restores known
child records and resumes watching live children.

| Variable             | Purpose                                                |
| -------------------- | ------------------------------------------------------ |
| `SUBA_ARTIFACT_ROOT` | Override the artifact directory                        |
| `SUBA_PI_EXECUTABLE` | Select the executable used to launch child Pi sessions |

## Development

```sh
npm install
npm test
npm run check
```

`npm run check` runs type checking, tests, and linting. Use `npm run format` to format source files.

Cua sandbox helpers provide deterministic desktop testing with fake child Pi processes and optional
real-model smoke coverage. See [`CUA_SANDBOX.md`](CUA_SANDBOX.md).

## Release

Releases require an upstream Git branch, npm authentication, and the `npm-release` command from
[`rust-release-tools`](https://github.com/raine/rust-release-tools).

```sh
just release          # patch release
just release minor
just release major
just release current  # release the current package version
```

See [`CHANGELOG.md`](CHANGELOG.md) for release history.

## License

[MIT](LICENSE)
