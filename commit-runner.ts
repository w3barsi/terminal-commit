import { spawn } from "child_process"
import { commitPrepared, prepareGac, prepareGc, validateCommitMessage } from "./gac"
import { MODEL } from "./model"

const PI_TIMEOUT_MS = 120_000

export type CommitMode = "add" | "staged"

export type CommitRunnerOptions = {
  signal?: AbortSignal
  onStatus?: (message: string) => void
  onLog?: (message: string) => void
  onAssistantDelta?: (text: string) => void
}

const getAssistantText = (message: Record<string, any> | undefined) => {
  if (message?.role !== "assistant") return null
  if (typeof message.content === "string") return message.content
  if (!Array.isArray(message.content)) return null

  const text = message.content
    .filter((part: Record<string, any>) => part?.type === "text" && typeof part.text === "string")
    .map((part: Record<string, any>) => part.text)
    .join("")
  return text || null
}

const generateCommitMessage = (
  cwd: string,
  prompt: string,
  options: CommitRunnerOptions,
): Promise<string> => new Promise((resolve, reject) => {
  const child = spawn("pi", [
    "--mode",
    "rpc",
    "--no-extensions",
    "--no-session",
    "--no-tools",
    "--model",
    MODEL,
  ], {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    signal: options.signal,
  })
  let buffer = ""
  let assistantResponse = ""
  let assistantStopReason: string | null = null
  let settled = false

  const timeout = setTimeout(() => {
    fail(new Error("Pi timed out while generating the commit message"))
  }, PI_TIMEOUT_MS)

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
    if (assistantStopReason !== "stop") {
      reject(new Error(`Pi did not complete the commit message successfully (stop reason: ${assistantStopReason ?? "missing"})`))
      return
    }
    resolve(validateCommitMessage(assistantResponse))
  }

  child.stdout?.on("data", (data: Buffer) => {
    buffer += data.toString()
    const lines = buffer.split("\n")
    buffer = lines.pop() ?? ""

    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const event = JSON.parse(line)
        if (event.type === "response" && event.command === "prompt") {
          if (event.success) options.onLog?.("[rpc] prompt accepted")
          else fail(event.error ?? "Pi rejected the prompt")
        }
        if (event.type === "agent_start") options.onLog?.("[agent] generating commit message")
        if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
          options.onAssistantDelta?.(event.assistantMessageEvent.delta)
        }
        if (event.type === "message_end") {
          const text = getAssistantText(event.message)
          if (text) {
            assistantResponse = text
            assistantStopReason = typeof event.message?.stopReason === "string" ? event.message.stopReason : null
          }
        }
        if (event.type === "agent_settled") finish()
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
    if (!settled) fail(new Error(`Pi exited before returning a message (code ${code ?? "unknown"})`))
  })

  child.stdin?.write(JSON.stringify({ id: `${Date.now()}-commit-message`, type: "prompt", message: prompt }) + "\n")
  options.onLog?.("[sent] staged context sent to Pi with tools disabled")
})

export const runCommit = async (cwd: string, mode: CommitMode, options: CommitRunnerOptions = {}) => {
  options.onStatus?.(mode === "add" ? "Staging changes and collecting commit context..." : "Collecting staged commit context...")
  if (mode === "add") options.onLog?.("[git] git add -A")

  const prepared = mode === "add"
    ? await prepareGac(cwd, options.signal)
    : await prepareGc(cwd, options.signal)

  options.onStatus?.("Asking Pi for a commit message...")
  options.onLog?.("[context] staged snapshot ready")
  const message = await generateCommitMessage(cwd, prepared.prompt, options)

  options.onStatus?.("Verifying staged changes and committing...")
  options.onLog?.(`[commit] ${message}`)
  const result = await commitPrepared(cwd, prepared, message, options.signal)
  options.onStatus?.("Commit created")

  return { ...result, message }
}
