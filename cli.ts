import { runCommit, type CommitMode } from "./commit-runner"
import { runGroup } from "./group-runner"

export type CliCommand = "tui" | CommitMode | "group" | "help"

export const USAGE = `Usage: gac [command]

Commands:
  add       Stage all changes and create one commit
  staged    Commit the currently staged changes
  group     Split all changes into coherent commits using /gacf
  tui       Open the terminal UI (default)
  help      Show this help`

export const parseCommand = (args: string[]): CliCommand => {
  const command = args[0]
  if (!command || command === "tui") return "tui"
  if (command === "add" || command === "staged" || command === "group") return command
  if (command === "help" || command === "--help" || command === "-h") return "help"
  throw new Error(`Unknown command: ${command}\n\n${USAGE}`)
}

export const runCli = async (args: string[], cwd = process.env.TERMINAL_COMMIT_REPO ?? process.cwd()) => {
  const command = parseCommand(args)
  if (command === "help" || command === "tui") {
    process.stdout.write(`${USAGE}\n`)
    return
  }

  const abortController = new AbortController()
  const abort = () => abortController.abort()
  process.once("SIGINT", abort)
  process.once("SIGTERM", abort)

  try {
    if (command === "group") {
      await runGroup(cwd, {
        signal: abortController.signal,
        onStatus: (message) => process.stderr.write(`${message}\n`),
        onOutput: (text) => process.stdout.write(text),
        onLog: (message) => process.stderr.write(`${message}\n`),
      })
      if (process.stdout.isTTY) process.stdout.write("\n")
      return
    }

    const result = await runCommit(cwd, command, {
      signal: abortController.signal,
      onStatus: (message) => process.stderr.write(`${message}\n`),
      onLog: (message) => process.stderr.write(`${message}\n`),
    })
    process.stdout.write(`${result.message}\n`)
  } finally {
    process.off("SIGINT", abort)
    process.off("SIGTERM", abort)
  }
}

if (import.meta.main) {
  runCli(process.argv.slice(2)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`gac: ${message}\n`)
    process.exitCode = 1
  })
}
