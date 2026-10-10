import { describe, expect, test } from "bun:test"
import { applyConsolidation, emptyStore } from "../src/core.ts"
import { findSecret } from "../src/memory/redaction.ts"

function dreamedEntry(overrides: Partial<any> = {}) {
  return {
    id: "e1",
    text: "The user codes in Rust.",
    category: "preferences",
    scope: "global" as const,
    weight: 1,
    created: Date.now(),
    lastSeen: Date.now(),
    source: "dreamed" as const,
    ...overrides,
  }
}

// findSecret returns the LABEL of the detected pattern, never the secret
// itself, so a refusal never echoes the value back.
describe("findSecret — positive patterns", () => {
  test("detects an sk- API key (>= 16 alnum chars)", () => {
    expect(findSecret("The deployment key is sk-abc123456789012345678.")).toBe("API key")
  })

  test("detects a ghp_ GitHub token (ghp_ + 36 alnum)", () => {
    expect(findSecret("ghp_a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8")).toBe("GitHub personal access token")
  })

  test("detects an AWS access key ID", () => {
    expect(findSecret("The key starts with AKIAIOSFODNN7EXAMPLE today.")).toBe("AWS access key ID")
  })

  test("detects a PEM private key block", () => {
    expect(findSecret("-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA")).toBe("private key block")
  })

  test("detects a password assignment", () => {
    expect(findSecret("password: hunter22")).toBe("credential assignment (password/token)")
  })

  test("detects an api_key assignment with = separator", () => {
    expect(findSecret("api_key=xyz123456")).toBe("credential assignment (password/token)")
  })

  test("different pattern families yield distinct labels", () => {
    const labels = [
      findSecret("sk-abc123456789012345678"),
      findSecret("ghp_a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"),
      findSecret("AKIAIOSFODNN7EXAMPLE"),
      findSecret("-----BEGIN PRIVATE KEY-----"),
      findSecret("token: hunter22"),
    ]
    expect(new Set(labels).size).toBe(labels.length)
  })
})

describe("findSecret — negative cases (prose must not trigger)", () => {
  test("plain prose does not trigger", () => {
    expect(findSecret("The user likes TypeScript.")).toBeUndefined()
  })

  test("a bare mention of 'token' does not trigger", () => {
    expect(findSecret("The token policy is strict")).toBeUndefined()
  })

  test("'api_key rotation' has no :/= + value, so it does not trigger", () => {
    expect(findSecret("api_key rotation is documented")).toBeUndefined()
  })

  test("'password manager' has no separator, so it does not trigger", () => {
    expect(findSecret("The user's password manager is 1Password")).toBeUndefined()
  })
})

// Dream-extracted facts are untrusted input: a fact that looks like a
// credential is skipped entirely (never partially redacted, never stored),
// while the rest of the batch is applied normally.
describe("applyConsolidation — secret guard", () => {
  test("skips a new fact containing an sk- key, adds the other facts of the batch", () => {
    const store = emptyStore()
    const logs: { level: string; message: string; extra?: Record<string, unknown> }[] = []
    applyConsolidation(
      store,
      {
        new: [
          { text: "The deployment API key is sk-abc123456789012345678.", category: "project" },
          { text: "The user prefers TypeScript over JavaScript.", category: "preferences" },
        ],
      },
      undefined,
      Date.now(),
      (level, message, extra) => logs.push({ level, message, extra }),
    )
    expect(store.entries).toHaveLength(1)
    expect(store.entries[0].text).toBe("The user prefers TypeScript over JavaScript.")
    const skips = logs.filter((l) => l.message === "dream fact skipped: potential secret")
    expect(skips).toHaveLength(1)
    expect(skips[0].level).toBe("warn")
    // The label is logged, never the secret value itself.
    expect(skips[0].extra?.label).toBe("API key")
    expect(JSON.stringify(logs)).not.toContain("sk-abc123456789012345678")
  })

  test("skips an update whose text contains a secret, leaves the target untouched", () => {
    const store = emptyStore()
    store.entries = [dreamedEntry({ id: "e1" })]
    const logs: { level: string; message: string; extra?: Record<string, unknown> }[] = []
    applyConsolidation(
      store,
      { update: [{ id: "e1", text: "The user codes in Rust with token ghp_a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8." }] },
      undefined,
      Date.now(),
      (level, message, extra) => logs.push({ level, message, extra }),
    )
    expect(store.entries).toHaveLength(1)
    expect(store.entries[0].text).toBe("The user codes in Rust.")
    expect(logs.some((l) => l.message === "dream fact skipped: potential secret")).toBe(true)
  })
})
