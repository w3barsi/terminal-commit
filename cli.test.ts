import { describe, expect, test } from "bun:test"
import { parseCommand } from "./cli"

describe("parseCommand", () => {
  test("opens the TUI by default", () => {
    expect(parseCommand([])).toBe("tui")
    expect(parseCommand(["tui"])).toBe("tui")
  })

  test("recognizes the headless command aliases", () => {
    expect(parseCommand(["add"])).toBe("add")
    expect(parseCommand(["staged"])).toBe("staged")
    expect(parseCommand(["group"])).toBe("group")
  })

  test("rejects unknown commands with usage", () => {
    expect(() => parseCommand(["commit"])).toThrow("Usage: gac [command]")
  })
})
