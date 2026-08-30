---
title: Changelog
description: Release notes for pi-suba.
---

## v0.1.2 (2026-08-30)

- Subagents survive interrupted turns and continue after compaction instead of reporting a failure.
- Subagent completion can be retried after a temporary write failure, so results still reach the
  parent.
- Subagents use the configured tmux placement unless a specific layout is requested.
- Shared subagent grids preserve the full-height workmux sidebar.
- Long-running subagents no longer show false stale warnings during quiet operations.

## v0.1.1 (2026-08-29)

- Multiple split-placement subagents share the available vertical space evenly.

## v0.1.0 (2026-08-28)

- Initial release of `pi-suba`, with visible tmux subagents, asynchronous parent notifications,
  configurable child profiles and models, and split or dedicated-window placement.
