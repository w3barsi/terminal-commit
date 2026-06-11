/** @jsxImportSource @opentui/solid */

import "@opentui/solid/preload"

/**
 * Prototype: OpenTUI + SolidJS launcher for a pi extension.
 *
 * Question: Does a terminal-native button that spawns pi in RPC mode
 * feel like the right way to trigger a pi extension without opening
 * pi's interactive TUI?
 *
 * Run: bun install && bun index.tsx
 */

import { TextAttributes } from "@opentui/core"
import { render, useKeyboard, useRenderer } from "@opentui/solid"
import { createSignal, onCleanup, onMount } from "solid-js"
import { spawn, type ChildProcess } from "child_process"

const COMMANDS = [
  { name: "gac", label: "Add and Commit", extension: "/home/barsi/.pi/agent/extensions/gac.ts" },
  { name: "gc", label: "Commit Only", extension: "/home/barsi/.pi/agent/extensions/gc.ts" },
  { name: "gacf", label: "Group Add and Commit", extension: "/home/barsi/.pi/agent/extensions/gacf.ts" },
]
const PUSH_COMMAND = { name: "push", label: " Push", command: "git push" }
const MAX_LOG_LINES = 500
const TARGET_REPO = process.env.TERMINAL_COMMIT_REPO ?? process.cwd()

type LogKind = "sent" | "rpc" | "tool" | "stderr" | "exit" | "assistant" | "mouse" | "commit" | "raw"
type LogLine = { kind: LogKind; text: string }

const LOG_COLORS: Record<LogKind, string> = {
  sent: "#7AA2F7",
  rpc: "#8BD5CA",
  tool: "#EBCB8B",
  stderr: "#FF6961",
  exit: "#777777",
  assistant: "#CCCCCC",
  mouse: "#B48EAD",
  commit: "#4CAF50",
  raw: "#888888",
}

const App = () => {
  const [status, setStatus] = createSignal("Ready - click a button or press Enter")
  const [hovered, setHovered] = createSignal<string | null>(null)
  const [running, setRunning] = createSignal(false)
  const [runningCommand, setRunningCommand] = createSignal<string | null>(null)
  const [logs, setLogs] = createSignal<LogLine[]>([])
  const [gitStatus, setGitStatus] = createSignal({ staged: 0, unstaged: 0, untracked: 0, unpushed: 0 })

  const renderer = useRenderer()
  let piProcess: ChildProcess | null = null
  let gitPushProcess: ChildProcess | null = null
  let buffer = ""

  const getLogKind = (line: string): LogKind => {
    if (line.startsWith("[sent]")) return "sent"
    if (line.startsWith("[rpc]")) return "rpc"
    if (line.startsWith("[tool:")) return "tool"
    if (line.startsWith("[stderr]") || line.startsWith("[spawn]")) return "stderr"
    if (line.startsWith("[exit]")) return "exit"
    if (line.startsWith("[mouse]")) return "mouse"
    if (line.startsWith("[commit]")) return "commit"
    if (line.startsWith("[agent]") || line.startsWith("[notify]")) return "rpc"
    return "raw"
  }

  const addLog = (line: string | null, kind?: LogKind) => {
    if (!line?.trim()) return
    setLogs((prev) => [...prev, { kind: kind ?? getLogKind(line), text: line }].slice(-MAX_LOG_LINES))
  }

  const appendLog = (text: string | null) => {
    if (!text) return
    setLogs((prev) => {
      const next = prev.length ? [...prev] : [{ kind: "assistant" as const, text: "" }]
      const last = next[next.length - 1]
      if (last.kind === "assistant") {
        next[next.length - 1] = { kind: "assistant", text: `${last.text}${text}` }
      } else {
        next.push({ kind: "assistant", text })
      }
      return next.slice(-MAX_LOG_LINES)
    })
  }

  const firstString = (...values: unknown[]) => {
    for (const value of values) {
      if (typeof value === "string" && value.trim()) return value
    }
    return null
  }

  const refreshGitStatus = () => {
    const gitProcess = spawn("git", ["status", "--short"], { cwd: TARGET_REPO, stdio: ["ignore", "pipe", "pipe"] })
    let output = ""

    gitProcess.stdout?.on("data", (data: Buffer) => {
      output += data.toString()
    })

    gitProcess.on("exit", (code) => {
      if (code !== 0) {
        setGitStatus({ staged: 0, unstaged: 0, untracked: 0, unpushed: 0 })
        return
      }

      let staged = 0
      let unstaged = 0
      let untracked = 0

      for (const line of output.split("\n")) {
        if (!line) continue
        if (line.startsWith("??")) {
          untracked++
          continue
        }
        if (line[0] !== " ") staged++
        if (line[1] !== " ") unstaged++
      }

      const aheadProcess = spawn("git", ["rev-list", "--count", "@{upstream}..HEAD"], { cwd: TARGET_REPO, stdio: ["ignore", "pipe", "ignore"] })
      let aheadOutput = ""

      aheadProcess.stdout?.on("data", (data: Buffer) => {
        aheadOutput += data.toString()
      })

      aheadProcess.on("exit", (aheadCode) => {
        const unpushed = aheadCode === 0 ? Number.parseInt(aheadOutput.trim(), 10) || 0 : 0
        setGitStatus({ staged, unstaged, untracked, unpushed })
      })
    })
  }

  const formatEvent = (event: Record<string, any>, commandConfig: (typeof COMMANDS)[number]): { kind: "line" | "append"; text: string } | null => {
    if (event.type === "extension_ui_request" && event.method === "notify") {
      const message = firstString(event.message, event.params?.message, event.params?.text) ?? "notification"
      setStatus(`Extension: ${message}`)
      return { kind: "line", text: `[notify] ${message}` }
    }

    if (event.type === "response" && event.command === "prompt") {
      if (event.success) {
        setStatus(`Command accepted - waiting for /${commandConfig.name}...`)
        return { kind: "line", text: "[rpc] prompt accepted" }
      }

      setStatus(`Command failed: ${event.error ?? "unknown"}`)
      return { kind: "line", text: `[rpc] error: ${event.error ?? "unknown"}` }
    }

    if (event.type === "response" && event.command === "get_commands" && event.success) {
      const commands = Array.isArray(event.data?.commands) ? event.data.commands : []
      const registeredCommand = commands.find((command: Record<string, any>) => command?.name === commandConfig.name)
      if (registeredCommand) {
        return { kind: "line", text: `[rpc] /${commandConfig.name} registered from ${registeredCommand.sourceInfo?.path ?? commandConfig.extension}` }
      }
      setStatus(`Error: /${commandConfig.name} was not registered`)
      return { kind: "line", text: `[rpc] /${commandConfig.name} was not registered` }
    }

    if (event.type === "agent_start") return { kind: "line", text: "[agent] start" }
    if (event.type === "agent_end") {
      setStatus(`Done - /${commandConfig.name} finished`)
      return { kind: "line", text: "[agent] end" }
    }
    if (event.type === "tool_execution_start") {
      return { kind: "line", text: `[tool:start] ${event.toolName ?? event.name ?? "tool"}` }
    }
    if (event.type === "tool_execution_end") {
      return { kind: "line", text: `[tool:end] ${event.toolName ?? event.name ?? "tool"}` }
    }

    const text = firstString(
      event.assistantMessageEvent?.delta,
      event.assistantMessageEvent?.text,
      event.message?.content,
      event.message?.text,
      event.content,
      event.text,
      event.delta,
      event.result?.message,
    )
    if (text) return { kind: "append", text }

    return null
  }

  const runExtension = (commandConfig = COMMANDS[0], restart = false) => {
    if (running() && !restart) return
    if (restart) cleanup()
    setRunning(true)
    setRunningCommand(commandConfig.name)
    setStatus("Spawning pi in RPC mode...")
    setLogs([])
    buffer = ""

    piProcess = spawn("pi", ["--mode", "rpc", "--no-extensions", "--no-session", "--extension", commandConfig.extension], {
      cwd: TARGET_REPO,
      stdio: ["pipe", "pipe", "pipe"],
    })

    piProcess.stdout?.on("data", (data: Buffer) => {
      buffer += data.toString()
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""

      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const event = JSON.parse(line)
          const formatted = formatEvent(event, commandConfig)
          if (formatted?.kind === "append") appendLog(formatted.text)
          if (formatted?.kind === "line") addLog(formatted.text)
          if (event.type === "agent_end") {
            cleanup()
            refreshGitStatus()
          }
        } catch {
          // raw non-JSON line
          addLog(line)
        }
      }
    })

    piProcess.stderr?.on("data", (data: Buffer) => {
      const text = data.toString().trim()
      if (text) {
        setStatus(`Error: ${text}`)
        addLog(`[stderr] ${text}`)
      }
    })

    piProcess.on("error", (err) => {
      setStatus(`Failed to spawn pi: ${err.message}`)
      addLog(`[spawn] error: ${err.message}`)
      cleanup()
    })

    piProcess.on("exit", (code) => {
      addLog(`[exit] code ${code ?? "?"}`)
      cleanup()
    })

    // Send the slash command after a short delay to let pi initialize.
    setTimeout(() => {
      if (piProcess && piProcess.stdin?.writable) {
        piProcess.stdin.write(JSON.stringify({ id: "commands", type: "get_commands" }) + "\n")
        piProcess.stdin.write(JSON.stringify({ id: commandConfig.name, type: "prompt", message: `/${commandConfig.name}` }) + "\n")
        addLog(`[sent] /${commandConfig.name} command`)
      }
    }, 500)
  }

  const runGitPush = () => {
    if (running()) return
    setRunning(true)
    setRunningCommand(PUSH_COMMAND.name)
    setStatus("Running git push...")
    setLogs([])

    gitPushProcess = spawn("git", ["push"], { cwd: TARGET_REPO, stdio: ["ignore", "pipe", "pipe"] })
    addLog("[sent] git push")

    gitPushProcess.stdout?.on("data", (data: Buffer) => {
      for (const line of data.toString().split("\n")) addLog(line)
    })

    gitPushProcess.stderr?.on("data", (data: Buffer) => {
      for (const line of data.toString().split("\n")) addLog(line)
    })

    gitPushProcess.on("error", (err) => {
      setStatus(`Failed to run git push: ${err.message}`)
      addLog(`[spawn] error: ${err.message}`)
      cleanup()
    })

    gitPushProcess.on("exit", (code) => {
      setStatus(code === 0 ? "Done - git push finished" : `git push failed with code ${code ?? "?"}`)
      addLog(`[exit] git push code ${code ?? "?"}`)
      refreshGitStatus()
      cleanup()
    })
  }

  const cleanup = () => {
    if (piProcess) {
      piProcess.stdin?.end()
      piProcess.kill()
      piProcess = null
    }
    if (gitPushProcess) {
      gitPushProcess.kill()
      gitPushProcess = null
    }
    setRunning(false)
    setRunningCommand(null)
  }

  useKeyboard((key) => {
    if (key.name === "return" || key.name === "enter") {
      runExtension(COMMANDS[0])
    }
    if (key.name === "escape") {
      cleanup()
      renderer.destroy()
    }
  })

  onMount(() => {
    refreshGitStatus()
    const interval = setInterval(refreshGitStatus, 1000)
    onCleanup(() => clearInterval(interval))
  })

  return (
    <box flexDirection="column" padding={1} gap={0} width="100%" height="100%">
      {/* Git Status */}
      <text fg="#AAAAAA">{status()}</text>
      {/* Event log */}
      <scrollbox
        flexGrow={1}
        border
        borderStyle="single"
        padding={1}
        stickyScroll
        stickyStart="bottom"
        verticalScrollbarOptions={{
          showArrows: true,
          trackOptions: { foregroundColor: "#555", backgroundColor: "#202020" },
        }}
      >
        {logs().length === 0 ? (
          <text fg="#666">Events will appear here...</text>
        ) : (
          logs().map((line) => <text fg={LOG_COLORS[line.kind]}>{line.text}</text>)
        )}
      </scrollbox>

      {/* Footer hint */}

      <box flexDirection="column" gap={0} width="100%" height={10}>
        <box flexDirection="row" gap={0} width="100%" height={5}>
          <box
            flexGrow={9}
            border
            borderStyle="rounded"
            padding={1}
            alignItems="center"
            justifyContent="center"
            backgroundColor={hovered() === COMMANDS[0].name ? "#00000005" : "#2D2D2D00"}
            onMouseDown={() => {
              if (running() && runningCommand() !== COMMANDS[0].name) return
              addLog(`[mouse] /${COMMANDS[0].name} button clicked`)
              runExtension(COMMANDS[0])
            }}
            onMouseOver={() => setHovered(COMMANDS[0].name)}
            onMouseOut={() => setHovered(null)}
          >
            <text fg={runningCommand() === COMMANDS[0].name ? "#888" : running() ? "#555" : "#4CAF50"} attributes={TextAttributes.BOLD}>
              {runningCommand() === COMMANDS[0].name ? `Running /${COMMANDS[0].name}...` : COMMANDS[0].label}
            </text>
          </box>
          <box
            flexGrow={1}
            border
            borderStyle="rounded"
            padding={1}
            alignItems="center"
            justifyContent="center"
            backgroundColor={hovered() === PUSH_COMMAND.name ? "#00000005" : "#2D2D2D00"}
            onMouseDown={() => {
              if (running() && runningCommand() !== PUSH_COMMAND.name) return
              addLog("[mouse] git push button clicked")
              runGitPush()
            }}
            onMouseOver={() => setHovered(PUSH_COMMAND.name)}
            onMouseOut={() => setHovered(null)}
          >
            <text fg={runningCommand() === PUSH_COMMAND.name ? "#888" : running() ? "#555" : "#4CAF50"} attributes={TextAttributes.BOLD}>
              {PUSH_COMMAND.label}
            </text>
          </box>
        </box>

        <box flexDirection="row" gap={0} width="100%" height={5}>
          {[COMMANDS[1], COMMANDS[2]].map((commandConfig) => {
            const isActive = runningCommand() === commandConfig.name
            const isDisabled = running() && !isActive

            return (
              <box
                flexGrow={1}
                border
                borderStyle="rounded"
                padding={1}
                alignItems="center"
                justifyContent="center"
                backgroundColor={hovered() === commandConfig.name ? "#00000005" : "#2D2D2D00"}
                onMouseDown={() => {
                  if (isDisabled) return
                  addLog(`[mouse] /${commandConfig.name} button clicked`)
                  runExtension(commandConfig)
                }}
                onMouseOver={() => setHovered(commandConfig.name)}
                onMouseOut={() => setHovered(null)}
              >
                <text fg={isDisabled ? "#555" : isActive ? "#888" : "#4CAF50"} attributes={TextAttributes.BOLD}>
                  {isActive ? `Running /${commandConfig.name}...` : commandConfig.label}
                </text>
              </box>
            )
          })}
        </box>
      </box>

      {/* Status */}
      <box flexDirection="row" justifyContent="space-between" width="100%">
        <box flexDirection="row" gap={1}>
          <text fg="#8BD5CA">staged {gitStatus().staged}</text>
          <text fg="#ff6961">changed {gitStatus().unstaged}</text>
          <text fg="#B48EAD">untracked {gitStatus().untracked}</text>
          <text fg="#EBCB8B">unpushed {gitStatus().unpushed}</text>
        </box>
        {/* <text fg="#8BD5CA"> */}
        {/*   Git S:{gitStatus().staged} C:{gitStatus().unstaged} U:{gitStatus().untracked} */}
        {/* </text> */}
        <text fg="#555" attributes={TextAttributes.DIM}>
          Enter = click  |  ESC = quit
        </text>
      </box>
    </box>
  )
}

render(App)
