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
import { collectGitContext, formatGitContext } from "./git-context"
import { commitPrepared, prepareGac, prepareGc, validateCommitMessage } from "./gac"

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
type Commit = { id: string; user: string; message: string; date: string }

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
  const [commits, setCommits] = createSignal<Commit[]>([])

  const renderer = useRenderer()
  let piProcess: ChildProcess | null = null
  let gitPushProcess: ChildProcess | null = null
  let commitAbortController: AbortController | null = null
  let buffer = ""
  let operationVersion = 0

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
      const parts = text.split("\n")

      for (const [index, part] of parts.entries()) {
        const last = next[next.length - 1]

        if (index > 0 || last.kind !== "assistant") {
          next.push({ kind: "assistant", text: part })
          continue
        }

        next[next.length - 1] = { kind: "assistant", text: `${last.text}${part}` }
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

  const refreshCommits = () => {
    const logProcess = spawn("git", ["log", "-50", "--date=format-local:%d/%m/%Y %H:%M", "--pretty=format:%h%x1f%an%x1f%s%x1f%ad%x1e"], {
      cwd: TARGET_REPO,
      stdio: ["ignore", "pipe", "ignore"],
    })
    let output = ""

    logProcess.stdout?.on("data", (data: Buffer) => {
      output += data.toString()
    })

    logProcess.on("exit", (code) => {
      if (code !== 0) {
        setCommits([])
        return
      }

      setCommits(output.split("\x1e").flatMap((record) => {
        const [id, user, message, date] = record.trim().split("\x1f")
        return id && user && message && date ? [{ id, user, message, date }] : []
      }))
    })
  }

  const printLastCommitMessage = () => {
    const logProcess = spawn("git", ["log", "-1", "--pretty=%B"], { cwd: TARGET_REPO, stdio: ["ignore", "pipe", "ignore"] })
    let output = ""

    logProcess.stdout?.on("data", (data: Buffer) => {
      output += data.toString()
    })

    logProcess.on("exit", (code) => {
      const message = output.trim()
      if (code !== 0 || !message) return

      addLog("\n=======================================================")
      for (const line of message.split("\n")) {
        addLog(`[commit] ${line}`, "commit")
      }
      addLog("=======================================================")
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

  const runHostCommit = async (commandName: "gac" | "gc") => {
    if (running()) return
    const label = commandName.toUpperCase()
    const operation = ++operationVersion
    const abortController = new AbortController()
    commitAbortController = abortController
    setRunning(true)
    setRunningCommand(commandName)
    setStatus(commandName === "gac" ? "Staging changes and collecting commit context..." : "Collecting staged commit context...")
    setLogs([])
    buffer = ""
    if (commandName === "gac") addLog("[git] git add -A")

    try {
      const prepared = commandName === "gac"
        ? await prepareGac(TARGET_REPO, abortController.signal)
        : await prepareGc(TARGET_REPO, abortController.signal)
      if (operationVersion !== operation) return

      setStatus("Asking Pi for a commit message...")
      addLog("[context] staged snapshot ready")
      const child = spawn("pi", [
        "--mode",
        "rpc",
        "--no-extensions",
        "--no-session",
        "--no-tools",
        "--model",
        "openai-codex/gpt-5.4-mini",
      ], {
        cwd: TARGET_REPO,
        stdio: ["pipe", "pipe", "pipe"],
      })
      piProcess = child
      let assistantResponse = ""
      let assistantStopReason: string | null = null
      let finishing = false
      let piTimeout: ReturnType<typeof setTimeout> | null = null

      const fail = (error: unknown) => {
        if (operationVersion !== operation) return
        if (piTimeout) clearTimeout(piTimeout)
        piTimeout = null
        const message = error instanceof Error ? error.message : String(error)
        setStatus(`${label} failed: ${message}`)
        addLog(`[error] ${message}`, "stderr")
        cleanup()
        refreshGitStatus()
      }

      piTimeout = setTimeout(() => {
        fail("Pi timed out while generating the commit message")
      }, 120_000)

      const finish = async () => {
        if (finishing || operationVersion !== operation) return
        finishing = true
        if (piTimeout) clearTimeout(piTimeout)
        piTimeout = null
        child.stdin?.end()
        child.kill()
        if (piProcess === child) piProcess = null

        try {
          if (assistantStopReason !== "stop") {
            throw new Error(`Pi did not complete the commit message successfully (stop reason: ${assistantStopReason ?? "missing"})`)
          }
          const message = validateCommitMessage(assistantResponse)
          setStatus("Verifying staged changes and committing...")
          addLog(`[commit] ${message}`, "commit")
          const result = await commitPrepared(TARGET_REPO, prepared, message, abortController.signal)
          if (operationVersion !== operation) return
          for (const line of result.stdout.split("\n")) addLog(line)
          for (const line of result.stderr.split("\n")) addLog(line)
          setStatus(`Done - ${label} committed staged changes`)
          refreshGitStatus()
          refreshCommits()
          printLastCommitMessage()
          setRunning(false)
          setRunningCommand(null)
          if (commitAbortController === abortController) commitAbortController = null
        } catch (error) {
          fail(error)
        }
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
              if (event.success) addLog("[rpc] prompt accepted")
              else fail(event.error ?? "Pi rejected the prompt")
            }
            if (event.type === "agent_start") addLog("[agent] generating commit message")
            if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
              appendLog(event.assistantMessageEvent.delta)
            }
            if (event.type === "message_end") {
              const text = getAssistantText(event.message)
              if (text) {
                assistantResponse = text
                assistantStopReason = typeof event.message?.stopReason === "string" ? event.message.stopReason : null
              }
            }
            if (event.type === "agent_settled") void finish()
          } catch {
            addLog(line)
          }
        }
      })

      child.stderr?.on("data", (data: Buffer) => {
        const text = data.toString().trim()
        if (text) addLog(`[stderr] ${text}`)
      })
      child.on("error", fail)
      child.on("exit", (code) => {
        if (!finishing && operationVersion === operation) fail(`Pi exited before returning a message (code ${code ?? "unknown"})`)
      })

      child.stdin?.write(JSON.stringify({ id: `${commandName}-message`, type: "prompt", message: prepared.prompt }) + "\n")
      addLog("[sent] staged context sent to Pi with tools disabled")
    } catch (error) {
      if (operationVersion !== operation) return
      const message = error instanceof Error ? error.message : String(error)
      setStatus(`${label} failed: ${message}`)
      addLog(`[error] ${message}`, "stderr")
      setRunning(false)
      setRunningCommand(null)
      if (commitAbortController === abortController) commitAbortController = null
      refreshGitStatus()
    }
  }

  const runExtension = (commandConfig = COMMANDS[0], restart = false) => {
    if (commandConfig.name === "gac" || commandConfig.name === "gc") {
      void runHostCommit(commandConfig.name)
      return
    }
    if (running() && !restart) return
    if (restart) cleanup()
    setRunning(true)
    setRunningCommand(commandConfig.name)
    setStatus("Spawning pi in RPC mode...")
    setLogs([])
    buffer = ""

    const child = spawn("pi", [
      "--mode",
      "rpc",
      "--no-extensions",
      "--no-session",
      "--model",
      "openai-codex/gpt-5.4-mini",
      "--extension",
      commandConfig.extension,
    ], {
      cwd: TARGET_REPO,
      stdio: ["pipe", "pipe", "pipe"],
    })
    piProcess = child
    let commandReady = false
    let repositoryContext: string | null = null
    let promptSent = false

    const sendPromptWhenReady = () => {
      if (!commandReady || !repositoryContext || promptSent || piProcess !== child || !child.stdin?.writable) return

      promptSent = true
      child.stdin.write(JSON.stringify({
        id: commandConfig.name,
        type: "prompt",
        message: `/${commandConfig.name} ${repositoryContext}`,
      }) + "\n")
      setStatus(`Context ready - running /${commandConfig.name}...`)
      addLog(`[sent] /${commandConfig.name} command with repository context`)
    }

    void collectGitContext(TARGET_REPO)
      .then((sections) => formatGitContext(sections))
      .catch((error: unknown) => formatGitContext([{
        title: "Repository context",
        command: "git context collection",
        output: "",
        error: error instanceof Error ? error.message : String(error),
        truncated: false,
      }]))
      .then((context) => {
        if (piProcess !== child) return
        repositoryContext = context
        addLog("[context] repository snapshot ready")
        sendPromptWhenReady()
      })

    child.stdout?.on("data", (data: Buffer) => {
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
          if (event.type === "response" && event.command === "get_commands") {
            const commands = event.success && Array.isArray(event.data?.commands) ? event.data.commands : []
            commandReady = commands.some((command: Record<string, any>) => command?.name === commandConfig.name)
            if (commandReady) {
              sendPromptWhenReady()
            } else {
              setStatus(`Error: /${commandConfig.name} was not registered`)
              cleanup()
            }
          }
          if (event.type === "agent_end") {
            cleanup()
            refreshGitStatus()
            refreshCommits()
            printLastCommitMessage()
          }
        } catch {
          // raw non-JSON line
          addLog(line)
        }
      }
    })

    child.stderr?.on("data", (data: Buffer) => {
      const text = data.toString().trim()
      if (text) {
        setStatus(`Error: ${text}`)
        addLog(`[stderr] ${text}`)
      }
    })

    child.on("error", (err) => {
      setStatus(`Failed to spawn pi: ${err.message}`)
      addLog(`[spawn] error: ${err.message}`)
      cleanup()
    })

    child.on("exit", (code) => {
      addLog(`[exit] code ${code ?? "?"}`)
      cleanup()
    })

    child.stdin?.write(JSON.stringify({ id: "commands", type: "get_commands" }) + "\n")
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
    operationVersion++
    commitAbortController?.abort()
    commitAbortController = null
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
    refreshCommits()
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
          logs().map((line) => {
            const kind = line.text.trimStart().startsWith("[commit]") ? "commit" : line.kind
            return <text fg={LOG_COLORS[kind]}>{line.text}</text>
          })
        )}
      </scrollbox>

      {/* Commit history */}
      <scrollbox
        height={8}
        border
        borderStyle="single"
        paddingLeft={1}
        paddingRight={1}
        verticalScrollbarOptions={{
          showArrows: true,
          trackOptions: { foregroundColor: "#555", backgroundColor: "#202020" },
        }}
      >
        {commits().length === 0 ? (
          <text fg="#666">No commits found</text>
        ) : (
          commits().map((commit) => (
            <box flexDirection="row" justifyContent="space-between" width="100%">
              <box flexDirection="row">
                <text fg="#7AA2F7">{commit.id}</text>
                <text>{"  "}</text>
                <text fg="#8BD5CA">{commit.user}</text>
                <text>{`  ${commit.message}`}</text>
              </box>
              <text fg="#777">{commit.date}</text>
            </box>
          ))
        )}
      </scrollbox>

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
