# Prototype: OpenTUI + SolidJS Pi Extension Launcher

## Question
Does a terminal-native button that spawns pi in RPC mode feel like the right way to trigger a pi extension without opening pi's interactive TUI?

## What this is
A standalone terminal app built with OpenTUI + SolidJS. It shows a big clickable button at the top. Clicking it (or pressing Enter) spawns `pi --mode rpc` with a sample extension loaded, sends the `/hello` command, and streams the RPC events back into the TUI.

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
- `index.tsx` — OpenTUI + SolidJS app. Renders a button, handles mouse/keyboard, spawns pi as a child process.
- `pi-extension.ts` — A pi extension that registers `/hello`. When triggered, it calls `ctx.ui.notify()` which in RPC mode emits an `extension_ui_request` event that the parent TUI parses and displays.

## Key findings
- OpenTUI's `Box` has built-in `onMouseDown`, `onMouseOver`, `onMouseOut` — mouse clicking works natively.
- Mouse is enabled by default (`useMouse: true`) in the renderer.
- The SolidJS binding maps these props directly to the core `BoxRenderable`.
- Pi's RPC mode (`--mode rpc`) speaks JSONL over stdin/stdout. Extension commands execute immediately without launching the full TUI.

## What to keep / what to throw away
- **Keep:** The RPC child-process pattern — spawning pi headless and streaming events back is the cleanest way to run a pi extension without opening the UI.
- **Throw away:** The `pi-extension.ts` is a toy example. The real extension would be the one you actually want to trigger.
- **Throw away:** The TUI shell is throwaway prototype code. If this pattern wins, the real launcher can be rebuilt properly.

## Next decision
Do you want to evolve this into a real launcher, or keep it as a one-off trigger? If real, the extension should probably be installed to `~/.pi/agent/extensions/` or `.pi/extensions/` instead of `-e`.
