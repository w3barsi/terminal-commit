# Terminal Commit

Terminal Commit is a small OpenTUI app for lazily creating git commits from the terminal.

The intended workflow is to split your terminal into two panes with `tmux`: keep `lazygit` open in one pane for reviewing changes, staging files, inspecting diffs, and watching repository state; keep Terminal Commit open in the other pane for triggering commit automation without leaving the terminal.

The app is intentionally narrow. It gives you a few commit-focused actions as large terminal buttons and streams the underlying Pi agent output into a scrollable log area.

## Workflow

Use `lazygit` to see and control what changed. Use Terminal Commit to ask Pi to do the repetitive commit work.

Typical layout:

```text
┌─────────────────────────────┬─────────────────────────────┐
│ lazygit                     │ terminal-commit             │
│ review diffs, staging, log  │ commit buttons + agent logs │
└─────────────────────────────┴─────────────────────────────┘
```

## Actions

- `Add and Commit` runs `/gac`: stage all changes and create a commit.
- `Commit Only` runs `/gc`: commit what is already staged.
- `Group Add and Commit` runs `/gacf`: split unrelated changes into coherent commits.
- `Push` runs `git push` directly, without Pi or AI.

The status bar tracks the active repository with live counts for staged, changed, untracked, and unpushed commits.

`Add and Commit` is host-controlled: Terminal Commit runs `git add -A`, collects the complete staged diff and recent commit subjects, and asks Pi only for a commit message with all tools disabled. It validates the message and confirms the staged tree has not changed before running `git commit` itself. Oversized diffs abort rather than producing a message from incomplete context.

The other AI actions launch Pi while collecting a bounded repository snapshot in parallel. Their first agent prompt includes that snapshot, avoiding an initial tool round trip just to discover repository state.

## Running In A Repo

Run the wrapper from the repository you want to commit from:

```bash
/home/barsi/dev/terminal-commit/terminal-commit
```

The wrapper keeps the app runtime tied to this project while targeting the directory you launched it from for all `git` and `pi` work.
