import { describe, expect, test } from "bun:test"
import { parseNote, renderNote } from "../src/vault/note.ts"
import type { Entry } from "../src/core.ts"

function fullEntry(): Entry {
  return {
    id: "12345678-abcd-4321-8765-abcdefabcdef",
    text: "The user likes coffee.",
    category: "preferences",
    scope: "project",
    projectID: "C:\\proj\\mon-projet",
    weight: 3,
    created: Date.UTC(2026, 9, 10, 12, 0, 0),
    lastSeen: Date.UTC(2026, 9, 11, 8, 30, 0),
    source: "explicit",
    createdBy: "memory_write",
    sourceSessionID: "ses-1",
    sourceMessageIDs: ["m1", "m2"],
    extractedAt: Date.UTC(2026, 9, 10, 12, 0, 0),
    confidence: 0.9,
    tier: "core",
    pinned: true,
    expiresAt: Date.UTC(2026, 11, 31),
    status: "ACTIVE",
    sensitivity: "normal",
    lastSurfaced: Date.UTC(2026, 9, 11, 8, 30, 0),
    surfacedCount: 4,
    useCount: 2,
    helpfulCount: 1,
    irrelevantCount: 0,
  }
}

function mustParse(raw: string, fileName = "note.md"): Entry {
  const res = parseNote(raw, fileName)
  if ("error" in res) throw new Error(`unexpected parse error: ${res.error}`)
  return res.entry
}

function assertFields(actual: Entry, expected: Entry) {
  for (const [key, value] of Object.entries(expected)) {
    expect(actual[key as keyof Entry]).toEqual(value)
  }
}

describe("renderNote → parseNote round trip", () => {
  test("full entry with all optional fields survives", () => {
    const entry = fullEntry()
    expect(mustParse(renderNote(entry))).toEqual(entry)
  })

  test("minimal entry with required fields only", () => {
    const entry: Entry = {
      id: "87654321-abcd-4321-8765-abcdefabcdef",
      text: "The user uses Bun daily.",
      category: "workflow",
      scope: "global",
      weight: 1,
      created: 1730000000000,
      lastSeen: 1730000001000,
      source: "dreamed",
    }
    assertFields(mustParse(renderNote(entry)), entry)
  })

  test("french accents and quotes survive a round trip", () => {
    const text = `L'utente préfère le "verde" — café`
    expect(mustParse(renderNote({ ...fullEntry(), text })).text).toBe(text)
  })

  test("multiline text is preserved", () => {
    const text = "line one\nline two\n\nline four"
    expect(mustParse(renderNote({ ...fullEntry(), text })).text).toBe(text)
  })
})

describe("parseNote tolerance", () => {
  test("missing frontmatter is an error", () => {
    const res = parseNote("just some text without frontmatter", "note.md")
    expect("error" in res).toBe(true)
  })

  test("missing id is an error", () => {
    const raw = renderNote(fullEntry()).replace(/^id: .*\n/m, "")
    expect("error" in parseNote(raw, "note.md")).toBe(true)
  })

  test("empty body is an error", () => {
    expect("error" in parseNote('---\nid: "12345678"\ntype: memory\n---\n', "note.md")).toBe(true)
    expect("error" in parseNote('---\nid: "12345678"\ntype: memory\n---\n\n', "note.md")).toBe(true)
  })

  test("legacy 'general' category becomes 'other'", () => {
    expect(mustParse(renderNote({ ...fullEntry(), category: "general" })).category).toBe("other")
  })

  test("unknown category becomes 'other'", () => {
    expect(mustParse(renderNote({ ...fullEntry(), category: "not-a-category" })).category).toBe("other")
  })

  test("dates accepted as ISO datetime, date-only or epoch ms", () => {
    const ts = Date.UTC(2026, 9, 9)
    for (const value of ["2026-10-09T00:00:00.000Z", "2026-10-09", String(ts)]) {
      const raw = `---\nid: "x"\ncreated: ${value}\nlastSeen: ${value}\nweight: 1\n---\n\nbody\n`
      const entry = mustParse(raw)
      expect(entry.created).toBe(ts)
      expect(entry.lastSeen).toBe(ts)
    }
  })

  test("unknown keys are ignored (Obsidian plugin enrichment)", () => {
    const raw = renderNote(fullEntry()).replace(
      /^type: .*\n/m,
      `type: memory\naliases: [coffee, java]\ntags: test\n`,
    )
    expect(mustParse(raw)).toEqual(fullEntry())
  })
})
