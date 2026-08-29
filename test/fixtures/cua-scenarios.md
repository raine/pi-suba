# pi-suba Cua scenarios

Use fake child mode unless a scenario says real mode. Replace `<id>` with the
stable child ID shown by the parent.

## Deterministic orchestration

### Fresh split completion

```text
Call suba exactly once with name "fresh", task "[fake:complete] fresh split", context "fresh", and split placement. Do not call suba_list.
```

### Fork completion

First establish a unique conversation fact, then send:

```text
Call suba exactly once with name "fork", task "[fake:complete] fork context", context "fork", and split placement.
```

Inspect the child session to confirm that conversation entries before the
triggering user turn exist and the triggering turn does not.

### Dedicated and shared windows

```text
Launch one subagent named "window-one" with task "[fake:stay] dedicated" in a window named "suba-one". Launch two more named "shared-one" and "shared-two" with task "[fake:stay] shared" in the shared window named "suba-cua". Return after all three launches.
```

### Ping and single-line guidance

```text
Launch a subagent named "ping" with task "[fake:ping] request guidance". When its help request arrives, wait for my next instruction.
```

Then:

```text
Call suba_send for <id> with the message "continue with option alpha".
```

### Multiline guidance

```text
Call suba_send for <id> with this exact multiline message:
first instruction
second instruction
third instruction
```

### Structured failure

```text
Launch a subagent named "event-failure" with task "[fake:fail-event]" and return immediately.
```

### Process failure

```text
Launch a subagent named "process-failure" with task "[fake:exit-nonzero]" and return immediately.
```

### Manual interruption

```text
Launch a subagent named "interrupt" with task "[fake:stay] close my pane" and return immediately.
```

Close its stable pane from the host, then verify that the parent reports an
interrupted child.

### Resume boundary

```text
Launch a subagent named "resume" with task "[fake:complete] first result" and wait for its result.
```

Then:

```text
Call suba_resume for <id> with task "[fake:complete] appended result".
```

The resumed result must contain the appended result and exclude the first one.

### Activity overflow

Launch four `[fake:stay]` children. The widget must show three rows and `+1 more`.
Resize the tmux window to narrow widths and verify bounded rows.

### Parent registry restoration

Leave a `[fake:stay]` child running, exit parent Pi without killing tmux, and
launch parent Pi against the same session file. The child ID, pane, activity,
and watcher must be restored.

## Profile and validation flows

Use `read-only`, `isolated`, `replace`, and `persistent` profiles to inspect the
recorded launch arguments. Verify tool allowlists, context and skill flags,
prompt mode, and automatic completion settings.

Activate invalid configuration variants with `scripts/cua-config`, then relaunch
Pi and verify bounded actionable errors. Restore `valid` before continuing.

## Real Pi companion smoke

Use real mode for these flows:

1. Launch a child that reads `fixture.txt` and reports it.
2. Launch an `isolated` child and ask for the context and skill markers. They
   must remain unavailable.
3. Confirm the extension sentinel records only `parent`.
4. Launch a `persistent` child, interact in its pane, and call
   `suba_done`.
5. Ask a child to call `suba_ping`, send guidance, and verify the same pane and
   session continue.
6. Change the child model and thinking level interactively and inspect
   `activity.json`.
7. Resume a completed real child and verify only appended assistant output is
   returned.
