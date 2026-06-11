# Terminal Commit

OpenTUI + Solid terminal launcher for Pi git commit extensions.

## What It Does

This app shows a terminal UI with three buttons:

- `Add and Commit` runs Pi extension `/gac`
- `Commit Only` runs Pi extension `/gc`
- `Group Add and Commit` runs Pi extension `/gacf`

Each button starts `pi` in RPC mode, loads only the matching extension, sends the slash command, and streams Pi's RPC output into the log panel.

The footer also shows live Git status for the current project:

```text
Git S:<staged> C:<changed> U:<untracked>
```

## Run

```bash
bun install
bun index.tsx
```

For restart-on-save development:

```bash
bun run dev
```

## Controls

- Click a button to run that command.
- `Enter` runs `/gac`.
- `Esc` exits.

## Requirements

- Bun
- `pi` available in `PATH`
- Git project in the current working directory
- Pi extensions at:
  - `/home/barsi/.pi/agent/extensions/gac.ts`
  - `/home/barsi/.pi/agent/extensions/gc.ts`
  - `/home/barsi/.pi/agent/extensions/gacf.ts`

## Notes

The app runs Pi with `--no-extensions --extension <path>` so each button dispatches deterministically to the intended extension command instead of any auto-loaded command with the same name.
