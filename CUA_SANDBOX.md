# Cua sandbox support

This project uses the shared `cua-sandbox` lifecycle and project helpers under
`scripts/cua-*`. Run commands from the repository root.

## Host prerequisites

```sh
command -v cua-sandbox
cua-sandbox list
docker info
```

The persistent image contains Node, npm, git, jq, ripgrep, shellcheck, tmux,
Kitty, and Pi 0.84.3. Run `cua-sandbox setup` after the shared Dockerfile or Cua
components change.

## Start and provision

Start a unique session in a long-lived shell:

```sh
session=pi-suba-full-flow
cua-sandbox start "$session"
```

From another shell:

```sh
cua-sandbox status "$session"
scripts/cua-deploy "$session"
scripts/cua-fixtures "$session"
scripts/cua-auth "$session" copy
scripts/cua-launch "$session" fake
```

`cua-auth copy` copies the host Pi auth store and verifies OpenAI Codex OAuth
inside the disposable container. It never prints credential values. Use a
private Cua session and clear credentials before handoff or cleanup.

The sandbox accepts only `openai-codex/*` models and defaults to
`openai-codex/gpt-5.6-luna`. Override it with `SUBA_TEST_MODEL` or the optional
third `cua-launch` argument when another OpenAI Codex OAuth model is needed.

Fake mode uses the OAuth model for the parent Pi and `test/fixtures/fake-pi` for
children. This makes lifecycle, tmux, registry, message delivery, failure, and
resume behavior deterministic. Real mode uses the OAuth model for both parent
and child:

```sh
scripts/cua-launch "$session" real
```

## Drive and inspect

Use CuaBot through the named session:

```sh
screenshot_dir="/tmp/cua-sandbox-$session-screenshots"
mkdir -p "$screenshot_dir"
cua-sandbox cua "$session" --screenshot "$screenshot_dir/01-parent-ready.jpg"
cua-sandbox cua "$session" --type 'prompt text'
cua-sandbox cua "$session" --key Enter
```

Wait on artifact or tmux state instead of fixed sleeps. Inspect bounded state:

```sh
scripts/cua-assert "$session"
scripts/cua-assert "$session" CHILD_ID
```

Scenario prompts and expected behavior live in
`test/fixtures/cua-scenarios.md`.

Useful control commands:

```sh
container="$(cua-sandbox container "$session")"
docker exec -u user "$container" tmux list-panes -a -F \
  '#{session_name} #{window_id} #{pane_id} #{pane_width}x#{pane_height}'
docker exec -u user "$container" tmux kill-pane -t '%CHILD_PANE'
docker exec -u user "$container" tmux resize-window -t pi-suba-cua -x 70 -y 30
```

## Configuration failures

Switch fixtures and relaunch Pi:

```sh
scripts/cua-config "$session" invalid-config
scripts/cua-config "$session" invalid-profile
scripts/cua-config "$session" valid
```

Only one invalid variant should be active at a time. `valid` restores the
canonical fixture set.

## Test coverage

The Cua run covers:

- Fresh, forked, and resumed persistent sessions
- Split, dedicated-window, and shared-window placement
- Stable pane IDs, rebalancing, focus-independent targeting, and pane closure
- Single-line and multiline guidance
- Automatic completion, explicit completion, ping, structured failure, process
  failure, and interruption
- Registry replay after parent restart
- Profile precedence, tool policies, context, skills, and prompt modes
- Extension isolation and nested-subagent prevention
- Activity model, streaming, tool, waiting, done, stale, narrow, and overflow
  states
- Malformed configuration, profiles, activity, and event artifacts
- Real Pi companion completion, ping, continuation, model changes, and resume

Use fake mode for deterministic orchestration and real mode for child companion
and model interaction smoke tests.

## Reset and cleanup

Reset retains deployment and credentials:

```sh
scripts/cua-reset "$session"
scripts/cua-fixtures "$session"
```

Full project cleanup removes copied credentials:

```sh
scripts/cua-clean "$session"
cua-sandbox stop "$session"
cua-sandbox list
```

Keep host screenshots after cleanup and report every retained path.
