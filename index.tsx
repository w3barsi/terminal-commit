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
import { createSignal } from "solid-js"
import { spawn, type ChildProcess } from "child_process"

const GAC_EXTENSION = "/home/barsi/.pi/agent/extensions/gac.ts"
const GAC_COMMAND = "gac"
const MAX_LOG_LINES = 500

const App = () => {
  const [status, setStatus] = createSignal("Ready - click the button or press Enter")
  const [hovered, setHovered] = createSignal(false)
  const [running, setRunning] = createSignal(false)
  const [logs, setLogs] = createSignal<string[]>([])

  const renderer = useRenderer()
  let piProcess: ChildProcess | null = null
  let buffer = ""

  const addLog = (line: string | null) => {
    if (!line?.trim()) return
    setLogs((prev) => [...prev, line].slice(-MAX_LOG_LINES))
  }

  const appendLog = (text: string | null) => {
    if (!text) return
    setLogs((prev) => {
      const next = prev.length ? [...prev] : [""]
      next[next.length - 1] = `${next[next.length - 1]}${text}`
      return next.slice(-MAX_LOG_LINES)
    })
  }

  const firstString = (...values: unknown[]) => {
    for (const value of values) {
      if (typeof value === "string" && value.trim()) return value
    }
    return null
  }

  const formatEvent = (event: Record<string, any>): { kind: "line" | "append"; text: string } | null => {
    if (event.type === "extension_ui_request" && event.method === "notify") {
      const message = firstString(event.message, event.params?.message, event.params?.text) ?? "notification"
      setStatus(`Extension: ${message}`)
      return { kind: "line", text: `[notify] ${message}` }
    }

    if (event.type === "response" && event.command === "prompt") {
      if (event.success) {
        setStatus("Command accepted - waiting for /gac...")
        return { kind: "line", text: "[rpc] prompt accepted" }
      }

      setStatus(`Command failed: ${event.error ?? "unknown"}`)
      return { kind: "line", text: `[rpc] error: ${event.error ?? "unknown"}` }
    }

    if (event.type === "response" && event.command === "get_commands" && event.success) {
      const commands = Array.isArray(event.data?.commands) ? event.data.commands : []
      const gacCommand = commands.find((command: Record<string, any>) => command?.name === GAC_COMMAND)
      if (gacCommand) return { kind: "line", text: `[rpc] /${GAC_COMMAND} registered from ${gacCommand.sourceInfo?.path ?? GAC_EXTENSION}` }
      setStatus(`Error: /${GAC_COMMAND} was not registered`)
      return { kind: "line", text: `[rpc] /${GAC_COMMAND} was not registered` }
    }

    if (event.type === "agent_start") return { kind: "line", text: "[agent] start" }
    if (event.type === "agent_end") {
      setStatus("Done - /gac finished")
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

  const runExtension = (restart = false) => {
    if (running() && !restart) return
    if (restart) cleanup()
    setRunning(true)
    setStatus("Spawning pi in RPC mode...")
    setLogs([])
    buffer = ""

    piProcess = spawn("pi", ["--mode", "rpc", "--no-extensions", "--extension", GAC_EXTENSION], {
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
          const formatted = formatEvent(event)
          if (formatted?.kind === "append") appendLog(formatted.text)
          if (formatted?.kind === "line") addLog(formatted.text)
          if (event.type === "agent_end") cleanup()
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

    // Send the /gac command after a short delay to let pi initialize.
    setTimeout(() => {
      if (piProcess && piProcess.stdin?.writable) {
        piProcess.stdin.write(JSON.stringify({ id: "commands", type: "get_commands" }) + "\n")
        piProcess.stdin.write(JSON.stringify({ id: "gac", type: "prompt", message: `/${GAC_COMMAND}` }) + "\n")
        addLog(`[sent] /${GAC_COMMAND} command`)
      }
    }, 500)
  }

  const cleanup = () => {
    if (piProcess) {
      piProcess.stdin?.end()
      piProcess.kill()
      piProcess = null
    }
    setRunning(false)
  }

  useKeyboard((key) => {
    if (key.name === "return" || key.name === "enter") {
      runExtension()
    }
    if (key.name === "r") {
      runExtension(true)
    }
    if (key.name === "escape") {
      cleanup()
      renderer.destroy()
    }
  })

  return (
    <box flexDirection="column" padding={1} gap={1} width="100%" height="100%">
      {/* Big button up top */}
      <box
        border
        borderStyle="rounded"
        padding={2}
        alignItems="center"
        justifyContent="center"
        backgroundColor={hovered() ? "#3D3D3D" : "#2D2D2D"}
        onMouseDown={() => {
          addLog("[mouse] button clicked")
          runExtension()
        }}
        onMouseOver={() => setHovered(true)}
        onMouseOut={() => setHovered(false)}
      >
        <text fg={running() ? "#888" : "#4CAF50"} attributes={TextAttributes.BOLD}>
          {running() ? "Running /gac..." : "Run /gac"}
        </text>
      </box>

      {/* Status */}
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
        <text fg="#666">
          {logs().length === 0
            ? "Events will appear here..."
            : logs().join("\n")}
        </text>
      </scrollbox>

      {/* Footer hint */}
      <text fg="#555" attributes={TextAttributes.DIM}>
        Enter = click  |  R = restart  |  ESC = quit
      </text>
    </box>
  )
}

render(App)
