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
const MAX_LOG_LINES = 500

const App = () => {
  const [status, setStatus] = createSignal("Ready - click the button or press Enter")
  const [hovered, setHovered] = createSignal(false)
  const [running, setRunning] = createSignal(false)
  const [logs, setLogs] = createSignal<string[]>([])

  const renderer = useRenderer()
  let piProcess: ChildProcess | null = null
  let buffer = ""

  const addLog = (line: string) => {
    setLogs((prev) => [...prev, line].slice(-MAX_LOG_LINES))
  }

  const formatEvent = (event: Record<string, any>) => {
    if (event.type === "extension_ui_request" && event.method === "notify") {
      const message = event.message ?? event.params?.message ?? "notification"
      setStatus(`Extension: ${message}`)
      return `[notify] ${message}`
    }

    if (event.type === "response" && event.command === "prompt") {
      if (event.success) {
        setStatus("Command accepted - waiting for /gac...")
        return "[rpc] prompt accepted"
      }

      setStatus(`Command failed: ${event.error ?? "unknown"}`)
      return `[rpc] error: ${event.error ?? "unknown"}`
    }

    if (event.type === "agent_start") return "[agent] start"
    if (event.type === "agent_end") {
      setStatus("Done - /gac finished")
      return "[agent] end"
    }
    if (event.type === "tool_execution_start") return `[tool:start] ${event.toolName ?? event.name ?? "tool"}`
    if (event.type === "tool_execution_end") return `[tool:end] ${event.toolName ?? event.name ?? "tool"}`

    const textDelta = event.assistantMessageEvent?.delta ?? event.delta
    if (event.type === "message_update" && typeof textDelta === "string") return textDelta

    return JSON.stringify(event)
  }

  const runExtension = () => {
    if (running()) return
    setRunning(true)
    setStatus("Spawning pi in RPC mode...")
    setLogs([])
    buffer = ""

    piProcess = spawn("pi", ["--mode", "rpc", "--extension", GAC_EXTENSION], {
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
          addLog(formatEvent(event))
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
        piProcess.stdin.write(JSON.stringify({ type: "prompt", message: "/gac" }) + "\n")
        addLog("[sent] /gac command")
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
      <box flexGrow={1} border borderStyle="single" padding={1}>
        <text fg="#666">
          {logs().length === 0
            ? "Events will appear here..."
            : logs().join("\n")}
        </text>
      </box>

      {/* Footer hint */}
      <text fg="#555" attributes={TextAttributes.DIM}>
        Enter = click  |  ESC = quit
      </text>
    </box>
  )
}

render(App)
