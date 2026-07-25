# Prototype: OpenTUI + SolidJS Pi Extension Launcher

## Question
Does a terminal-native button that spawns pi in RPC mode feel like the right way to trigger a pi extension without opening pi's interactive TUI?

## What this is
A standalone terminal app built with OpenTUI + SolidJS. Its commit buttons collect Git context, spawn Pi in RPC mode to generate commit messages, and stream RPC events back into the TUI.

## How to run
```bash
bun install
bun index.tsx
```

Requires:
- Bun installed
- `pi` in your PATH
- Zig installed (OpenTUI compiles its native Zig core on first run)

## Architecture
- `index.tsx` — OpenTUI + SolidJS app. Handles input, coordinates Git operations, spawns Pi, and renders streamed JSONL/RPC events.
- `gac.ts` — Host-controlled GAC/GC pipeline. It snapshots staged changes, builds the model prompt, validates the returned message, checks repository state, and commits.
- `/home/barsi/.pi/agent/extensions/gacf.ts` — The remaining extension-driven flow for grouping changes into multiple commits.

## Key findings
- OpenTUI's `Box` has built-in `onMouseDown`, `onMouseOver`, `onMouseOut` — mouse clicking works natively.
- Mouse is enabled by default (`useMouse: true`) in the renderer.
- The SolidJS binding maps these props directly to the core `BoxRenderable`.
- Pi's RPC mode (`--mode rpc`) speaks JSONL over stdin/stdout. Extension commands execute immediately without launching the full TUI.

## What to keep / what to throw away
- **Keep:** The RPC child-process pattern — spawning pi headless and streaming events back is the cleanest way to run a pi extension without opening the UI.
- **Keep:** Loading the exact extension path with `--extension` makes the launcher deterministic.
- **Throw away:** The TUI shell is prototype code. If this pattern wins, the real launcher can be rebuilt properly.

## Next decision
Do you want to evolve this into a real launcher, or keep it as a one-off trigger? If real, the extension should probably be installed to `~/.pi/agent/extensions/` or `.pi/extensions/` instead of `-e`.
