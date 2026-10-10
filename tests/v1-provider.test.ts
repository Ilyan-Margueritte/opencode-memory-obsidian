// Adapter-level check: V1 consolidation must honor dreamProvider. With
// dreamProvider: "openai-compatible" the consolidation calls the configured
// chat/completions endpoint (Bun.serve mock on port 0, same pattern as
// tests/dream-provider.test.ts) and NEVER drives the headless child-session
// path. The fact must land in the vault as a real note file.
import { expect, test } from "bun:test"
import { mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import v1Plugin from "../src/v1.ts"
import { createVaultStore } from "../src/vault/vaultStore.ts"
import { vaultPaths } from "../src/vault/paths.ts"

const FACT = "The user prefers teal terminal themes."
const CONSOLIDATION_ANSWER = JSON.stringify({
  new: [{ text: FACT, category: "preferences", scope: "global", confidence: 0.9 }],
})

test("V1 consolidation uses the configured openai-compatible endpoint instead of a child session", async () => {
  const calls: { url: string; body: unknown }[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      calls.push({ url: request.url, body: await request.json() })
      return Response.json({ choices: [{ message: { role: "assistant", content: CONSOLIDATION_ANSWER } }] })
    },
  })
  const root = mkdtempSync(join(tmpdir(), "memory-v1-provider-"))
  // Any touch of the headless child-session API means the adapter fell back
  // to the legacy path — which is exactly what must NOT happen here.
  const childSessionCalls: string[] = []
  const ts = Date.now()
  const client = {
    app: { log: async () => {} },
    session: {
      get: async ({ path }: { path: { id: string } }) => ({
        data: { id: path.id, title: "Provider test", directory: undefined },
      }),
      messages: async () => ({
        data: [
          {
            info: { role: "user", time: { created: ts, completed: ts } },
            parts: [{ type: "text", text: "I prefer teal terminal themes." }],
          },
          {
            info: { role: "assistant", time: { created: ts + 1, completed: ts + 1 } },
            parts: [{ type: "text", text: "Noted." }],
          },
        ],
      }),
      create: async () => {
        childSessionCalls.push("create")
        return { data: { id: "child" } }
      },
      promptAsync: async () => {
        childSessionCalls.push("promptAsync")
        return {}
      },
      delete: async () => ({}),
      list: async () => ({ data: [] }),
    },
  }
  let plugin: { dispose: () => Promise<void>; event: (input: { event: unknown }) => Promise<void> } | undefined
  try {
    plugin = (await v1Plugin({ client }, {
      dir: root,
      dream: true,
      surface: false,
      summary: false,
      delayMs: 0,
      sweepStartMs: 3_600_000,
      sweepIntervalMs: 3_600_000,
      dreamProvider: "openai-compatible",
      dreamBaseUrl: `http://127.0.0.1:${server.port}/v1`,
      dreamModel: "test-model",
    })) as { dispose: () => Promise<void>; event: (input: { event: unknown }) => Promise<void> }

    await plugin.event({ event: { type: "session.idle", properties: { sessionID: "provider-test-session" } } })

    // Poll the vault (a second VaultIO instance on the same directory — the
    // concurrent unlocked index persistence must stay collision-free) until
    // the dreamed fact lands.
    const io = createVaultStore(root)
    let stored: Awaited<ReturnType<typeof io.getStore>> | undefined
    for (let i = 0; i < 200; i++) {
      stored = await io.getStore()
      if (stored.entries.some((e) => e.source === "dreamed" && e.text === FACT)) break
      await Bun.sleep(50)
    }
    expect(stored?.entries.some((e) => e.source === "dreamed" && e.text === FACT)).toBe(true)
    // ...as a real note file on disk, not just in the parsed index.
    expect(readdirSync(vaultPaths(root).global).some((f) => f.toLowerCase().endsWith(".md"))).toBe(true)

    // The endpoint was called with the session transcript...
    expect(calls.length).toBeGreaterThanOrEqual(1)
    expect(calls[0]!.url).toContain("/chat/completions")
    expect(JSON.stringify(calls[0]!.body)).toContain("I prefer teal terminal themes.")
    // ...and the child-session path was never used.
    expect(childSessionCalls).toEqual([])
  } finally {
    await plugin?.dispose()
    server.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
}, 30_000)
