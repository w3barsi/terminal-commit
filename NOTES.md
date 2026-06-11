# Prototype: OpenTUI + SolidJS Pi Extension Launcher

## Question
Does a terminal-native button that spawns pi in RPC mode feel like the right way to trigger a pi extension without opening pi's interactive TUI?

## What this is
A standalone terminal app built with OpenTUI + SolidJS. It shows a big clickable button at the top. Clicking it (or pressing Enter) spawns `pi --mode rpc --extension /home/barsi/.pi/agent/extensions/gac.ts`, sends the `/gac` command, and streams the RPC events back into the TUI.

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
- `index.tsx` — OpenTUI + SolidJS app. Renders a button, handles mouse/keyboard, spawns pi as a child process, loads the GAC extension, sends `/gac`, and renders streamed JSONL/RPC events.
- `/home/barsi/.pi/agent/extensions/gac.ts` — The pi extension that registers `/gac` and asks the agent to stage all changes and commit them.

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
