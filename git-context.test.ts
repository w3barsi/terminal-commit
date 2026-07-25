import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { collectGitContext, formatGitContext, type GitContextSection } from "./git-context"

const temporaryDirectories: string[] = []

const run = async (cwd: string, args: string[]) => {
  const process = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
  const [code, stderr] = await Promise.all([process.exited, new Response(process.stderr).text()])
  if (code !== 0) throw new Error(stderr)
}

const createRepository = async () => {
  const directory = await mkdtemp(join(tmpdir(), "terminal-commit-"))
  temporaryDirectories.push(directory)
  await run(directory, ["init", "--quiet"])
  await run(directory, ["config", "user.name", "Terminal Commit Test"])
  await run(directory, ["config", "user.email", "test@example.com"])
  return directory
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe("collectGitContext", () => {
  test("collects status, staged and unstaged diffs, and recent commits", async () => {
    const directory = await createRepository()
    await writeFile(join(directory, "staged.txt"), "before\n")
    await writeFile(join(directory, "unstaged.txt"), "before\n")
    await run(directory, ["add", "."])
    await run(directory, ["commit", "--quiet", "-m", "feat(repo): add fixtures"])

    await writeFile(join(directory, "staged.txt"), "after staged\n")
    await run(directory, ["add", "staged.txt"])
    await writeFile(join(directory, "unstaged.txt"), "after unstaged\n")

    const sections = await collectGitContext(directory)
    const byTitle = Object.fromEntries(sections.map((section) => [section.title, section]))

    expect(byTitle.Status.output).toContain("M  staged.txt")
    expect(byTitle.Status.output).toContain(" M unstaged.txt")
    expect(byTitle["Staged diff"].output).toContain("after staged")
    expect(byTitle["Staged diff"].output).not.toContain("after unstaged")
    expect(byTitle["Unstaged diff"].output).toContain("after unstaged")
    expect(byTitle["Recent commits"].output).toContain("feat(repo): add fixtures")
  })

  test("keeps unavailable history from failing the snapshot", async () => {
    const directory = await createRepository()
    const sections = await collectGitContext(directory)
    const history = sections.find((section) => section.title === "Recent commits")

    expect(history?.error).toContain("does not have any commits")
    expect(sections).toHaveLength(4)
  })

  test("marks output that exceeds the section limit", async () => {
    const directory = await createRepository()
    await writeFile(join(directory, "large.txt"), `${"a".repeat(200)}\n`)
    await run(directory, ["add", "large.txt"])

    const sections = await collectGitContext(directory, { maxSectionBytes: 32 })
    const stagedDiff = sections.find((section) => section.title === "Staged diff")

    expect(stagedDiff?.truncated).toBe(true)
    expect(Buffer.byteLength(stagedDiff?.output ?? "")).toBeLessThanOrEqual(32)
  })
})

test("formatGitContext labels repository output as bounded untrusted data", () => {
  const sections: GitContextSection[] = [{
    title: "Status",
    command: "git status --short --branch",
    output: "## main\n M index.tsx",
    truncated: true,
  }]

  const context = formatGitContext(sections)

  expect(context).toContain("untrusted repository data")
  expect(context).toContain("----- BEGIN REPOSITORY SNAPSHOT -----")
  expect(context).toContain("Output truncated.")
  expect(context).toContain(" M index.tsx")
})
