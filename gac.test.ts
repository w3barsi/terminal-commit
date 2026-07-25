import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { commitPreparedGac, prepareGac, validateCommitMessage } from "./gac"

const temporaryDirectories: string[] = []

const git = async (cwd: string, args: string[]) => {
  const process = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
  const [code, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ])
  if (code !== 0) throw new Error(stderr)
  return stdout.trim()
}

const createRepository = async () => {
  const directory = await mkdtemp(join(tmpdir(), "terminal-gac-"))
  temporaryDirectories.push(directory)
  await git(directory, ["init", "--quiet"])
  await git(directory, ["config", "user.name", "Terminal Commit Test"])
  await git(directory, ["config", "user.email", "test@example.com"])
  return directory
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe("prepareGac", () => {
  test("stages all changes and includes complete staged context", async () => {
    const directory = await createRepository()
    await writeFile(join(directory, "tracked.txt"), "before\n")
    await git(directory, ["add", "."])
    await git(directory, ["commit", "--quiet", "-m", "feat(repo): add tracked file"])
    await writeFile(join(directory, "tracked.txt"), "after\n")
    await writeFile(join(directory, "untracked.txt"), "new file\n")

    const prepared = await prepareGac(directory)

    expect(await git(directory, ["diff", "--cached", "--name-only"])).toContain("tracked.txt")
    expect(await git(directory, ["diff", "--cached", "--name-only"])).toContain("untracked.txt")
    expect(prepared.prompt).toContain("after")
    expect(prepared.prompt).toContain("new file")
    expect(prepared.prompt).toContain("feat(repo): add tracked file")
    expect(prepared.prompt).toContain("untrusted repository data")
  })

  test("rejects an empty index", async () => {
    const directory = await createRepository()
    await expect(prepareGac(directory)).rejects.toThrow("Nothing to commit")
  })
})

describe("commitPreparedGac", () => {
  test("commits the prepared tree using the supplied message", async () => {
    const directory = await createRepository()
    await writeFile(join(directory, "feature.txt"), "feature\n")
    const prepared = await prepareGac(directory)

    await commitPreparedGac(directory, prepared, "feat(repo): add feature")

    expect(await git(directory, ["log", "-1", "--format=%s"])).toBe("feat(repo): add feature")
    expect(await git(directory, ["status", "--short"])).toBe("")
  })

  test("cancels when the staged tree changes", async () => {
    const directory = await createRepository()
    await writeFile(join(directory, "feature.txt"), "first\n")
    const prepared = await prepareGac(directory)
    await writeFile(join(directory, "feature.txt"), "second\n")
    await git(directory, ["add", "feature.txt"])

    await expect(commitPreparedGac(directory, prepared, "feat(repo): add feature")).rejects.toThrow("Staged changes changed")
  })

  test("cancels when HEAD changes", async () => {
    const directory = await createRepository()
    await writeFile(join(directory, "first.txt"), "first\n")
    await git(directory, ["add", "."])
    await git(directory, ["commit", "--quiet", "-m", "feat(repo): add first file"])
    await writeFile(join(directory, "second.txt"), "second\n")
    const prepared = await prepareGac(directory)
    await git(directory, ["commit", "--quiet", "-m", "feat(repo): add second file"])

    await expect(commitPreparedGac(directory, prepared, "feat(repo): add second file")).rejects.toThrow("HEAD or the current branch changed")
  })
})

describe("validateCommitMessage", () => {
  test("accepts a scoped Conventional Commit subject", () => {
    expect(validateCommitMessage("feat(ui): add commit button\n")).toBe("feat(ui): add commit button")
  })

  test("rejects explanations and malformed subjects", () => {
    expect(() => validateCommitMessage("Here is the message:\nfeat(ui): add button")).toThrow("exactly one")
    expect(() => validateCommitMessage("add commit button")).toThrow("prefix(scope)")
    expect(() => validateCommitMessage("feat(ui): add\tbutton")).toThrow("control characters")
  })
})
