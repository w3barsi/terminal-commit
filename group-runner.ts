import { spawn } from "child_process"
import { collectGitContext, formatGitContext } from "./git-context"

const MODEL = "openai-codex/gpt-5.4-mini"
const GROUP_EXTENSION = process.env.GACF_EXTENSION ?? "/home/barsi/.pi/agent/extensions/gacf.ts"
const GROUP_TIMEOUT_MS = 10 * 60_000

export type GroupRunnerOptions = {
  signal?: AbortSignal
  onStatus?: (message: string) => void
  onOutput?: (text: string) => void
  onLog?: (message: string) => void
}

export const runGroup = async (cwd: string, options: GroupRunnerOptions = {}): Promise<void> => {
  options.onStatus?.("Collecting repository context...")
  const context = formatGitContext(await collectGitContext(cwd))
  options.onStatus?.("Starting Pi group commit flow...")

  await new Promise<void>((resolve, reject) => {
    const child = spawn("pi", [
      "--mode",
      "rpc",
      "--no-extensions",
      "--no-session",
      "--model",
      MODEL,
      "--extension",
      GROUP_EXTENSION,
    ], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      signal: options.signal,
    })
    let buffer = ""
    let settled = false

    const timeout = setTimeout(() => fail(new Error("Pi group commit flow timed out")), GROUP_TIMEOUT_MS)

    const cleanup = () => {
      clearTimeout(timeout)
      child.stdin?.end()
      child.kill()
    }

    const fail = (error: unknown) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error instanceof Error ? error : new Error(String(error)))
    }

    const finish = () => {
      if (settled) return
      settled = true
      cleanup()
      resolve()
    }

    child.stdout?.on("data", (data: Buffer) => {
      buffer += data.toString()
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""

      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const event = JSON.parse(line)
          if (event.type === "response" && event.command === "get_commands") {
            const commands = event.success && Array.isArray(event.data?.commands) ? event.data.commands : []
            if (!commands.some((command: Record<string, any>) => command?.name === "gacf")) {
              fail(new Error(`/gacf was not registered from ${GROUP_EXTENSION}`))
              continue
            }
            child.stdin?.write(JSON.stringify({ id: "group", type: "prompt", message: `/gacf ${context}` }) + "\n")
            options.onStatus?.("Pi is grouping and committing changes...")
          }
          if (event.type === "response" && event.command === "prompt" && !event.success) {
            fail(event.error ?? "Pi rejected the group command")
          }
          if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
            options.onOutput?.(event.assistantMessageEvent.delta)
          }
          if (event.type === "tool_execution_start") {
            options.onLog?.(`[tool:start] ${event.toolName ?? event.name ?? "tool"}`)
          }
          if (event.type === "tool_execution_end") {
            options.onLog?.(`[tool:end] ${event.toolName ?? event.name ?? "tool"}`)
          }
          if (event.type === "agent_end") finish()
        } catch (error) {
          if (error instanceof SyntaxError) options.onLog?.(line)
          else fail(error)
        }
      }
    })

    child.stderr?.on("data", (data: Buffer) => {
      const text = data.toString().trim()
      if (text) options.onLog?.(`[stderr] ${text}`)
    })
    child.on("error", fail)
    child.on("exit", (code) => {
      if (!settled) fail(new Error(`Pi exited before group commits completed (code ${code ?? "unknown"})`))
    })

    child.stdin?.write(JSON.stringify({ id: "commands", type: "get_commands" }) + "\n")
  })

  options.onStatus?.("Group commits created")
}
