import { describe, expect, test } from "bun:test"
import { hash8, noteFileName, projectFolderName, slugify, vaultPaths } from "../src/vault/paths.ts"

describe("vaultPaths", () => {
  test("produces every expected sub-path", () => {
    const p = vaultPaths("C:\\v")
    expect(p.root).toBe("C:\\v")
    expect(p.summary).toBe("C:\\v\\SUMMARY.md")
    expect(p.global).toBe("C:\\v\\Global")
    expect(p.projects).toBe("C:\\v\\Projects")
    expect(p.knowledge).toBe("C:\\v\\Knowledge")
    expect(p.knowledgeProjects).toBe("C:\\v\\Knowledge\\projects")
    expect(p.dreamReports).toBe("C:\\v\\Dream\\reports")
    expect(p.archives).toBe("C:\\v\\Archives")
    expect(p.memory).toBe("C:\\v\\.memory")
    expect(p.state).toBe("C:\\v\\.memory\\state.json")
    expect(p.index).toBe("C:\\v\\.memory\\index.json")
    expect(p.history).toBe("C:\\v\\.memory\\history")
    expect(p.lock).toBe("C:\\v\\.memory\\.lock")
  })
})

describe("hash8", () => {
  test("is deterministic", () => {
    expect(hash8("a")).toBe(hash8("a"))
  })

  test("distinguishes same basename under different parents", () => {
    expect(hash8("C:\\a\\proj")).not.toBe(hash8("C:\\b\\proj"))
  })
})

describe("slugify", () => {
  test("strips accents and punctuation, keeps first words", () => {
    expect(slugify("Préférences du user !!")).toBe("preferences-du-user")
    expect(slugify("Une-phrase_avec.tirets")).toBe("une-phrase-avec-tirets")
  })

  test("falls back to 'memoire' for empty input", () => {
    expect(slugify("")).toBe("memoire")
  })
})

describe("projectFolderName", () => {
  test("gives different folder names to paths with the same basename", () => {
    const a = projectFolderName("C:\\a\\proj")
    const b = projectFolderName("C:\\b\\proj")
    expect(a).not.toBe(b)
    expect(a).toMatch(/^proj-[0-9a-f]{8}$/)
  })
})

describe("noteFileName", () => {
  test("combines the slug and the id prefix", () => {
    expect(noteFileName("12345678-abcd-4321-8765-abcdefabcdef", "The user likes coffee.")).toBe(
      "the-user-likes-coffee-12345678.md",
    )
  })
})
