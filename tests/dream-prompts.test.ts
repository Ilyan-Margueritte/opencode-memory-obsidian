import { expect, test } from "bun:test"
import { consolidationPrompt } from "../src/dream/prompts.ts"

test("consolidation prompt requires durable facts and forbids session logs", () => {
  const prompt = consolidationPrompt({
    entriesBlock: "(none)",
    transcript: "user: hello",
    sessionTitle: "test session",
    summary: false,
  })
  expect(prompt).toContain("still be useful in a later session")
  expect(prompt).toContain("Do NOT add session logs")
  expect(prompt).toContain("dated completion")
  expect(prompt).toContain("living project-state")
  // The model contract itself must stay stable: Dream still returns strict
  // JSON with the same new/update/delete/conflicts shape.
  expect(prompt).toContain('"new":[{')
})
