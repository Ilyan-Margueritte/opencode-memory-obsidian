// Dream model provider: mapping of MemoryConfig to a DreamProviderConfig and
// the OpenAI-compatible client. The mock endpoint uses Bun.serve on port 0
// (same pattern as scripts/verify-runtime.ts) so no external service or
// credential is involved.
import { expect, test } from "bun:test"
import { resolveConfig } from "../src/config.ts"
import { createOpenAICompatibleModel, dreamProviderConfig } from "../src/dream/provider.ts"

test("dreamProviderConfig defaults to the built-in opencode provider", () => {
  expect(dreamProviderConfig(resolveConfig({}, {}))).toEqual({ kind: "opencode" })
})

test("dreamProviderConfig maps a fully configured openai-compatible provider", () => {
  const config = resolveConfig({
    dreamProvider: "openai-compatible",
    dreamBaseUrl: "http://127.0.0.1:9/v1",
    dreamModel: "dream-model",
    dreamApiKey: "dream-key",
  }, {})
  expect(dreamProviderConfig(config)).toEqual({
    kind: "openai-compatible",
    baseUrl: "http://127.0.0.1:9/v1",
    model: "dream-model",
    apiKey: "dream-key",
  })
})

test("dreamProviderConfig omits the API key when none is configured", () => {
  const config = resolveConfig({
    dreamProvider: "openai-compatible",
    dreamBaseUrl: "http://127.0.0.1:9/v1",
    dreamModel: "dream-model",
  }, {})
  expect(dreamProviderConfig(config)).toEqual({
    kind: "openai-compatible",
    baseUrl: "http://127.0.0.1:9/v1",
    model: "dream-model",
  })
})

test("createOpenAICompatibleModel posts the documented request and returns the message content", async () => {
  const calls: { headers: Headers; body: unknown }[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      calls.push({ headers: request.headers, body: await request.json() })
      return Response.json({ choices: [{ index: 0, message: { role: "assistant", content: "DREAM_COMPLETION" } }] })
    },
  })
  try {
    const model = createOpenAICompatibleModel({
      kind: "openai-compatible",
      baseUrl: `http://127.0.0.1:${server.port}/v1`,
      model: "dream-model",
      apiKey: "test-key",
      extraHeaders: { "x-extra": "1" },
    })
    expect(await model.complete({ prompt: "Summarize this session." })).toBe("DREAM_COMPLETION")
    expect(calls.length).toBe(1)
    expect(calls[0].body).toEqual({
      model: "dream-model",
      messages: [{ role: "user", content: "Summarize this session." }],
      stream: false,
    })
    expect(calls[0].headers.get("content-type")).toBe("application/json")
    expect(calls[0].headers.get("authorization")).toBe("Bearer test-key")
    expect(calls[0].headers.get("x-extra")).toBe("1")
  } finally {
    server.stop(true)
  }
})

test("an openai-compatible endpoint without an API key sends no authorization header", async () => {
  const calls: Headers[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      calls.push(request.headers)
      return Response.json({ choices: [{ message: { content: "OK" } }] })
    },
  })
  try {
    const model = createOpenAICompatibleModel({
      kind: "openai-compatible",
      baseUrl: `http://127.0.0.1:${server.port}/v1`,
      model: "dream-model",
    })
    expect(await model.complete({ prompt: "p" })).toBe("OK")
    expect(calls[0].get("authorization")).toBeNull()
  } finally {
    server.stop(true)
  }
})

test("a non-2xx status throws with the status but never the body or the API key", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("UPSTREAM_BODY_MARKER", { status: 500 }),
  })
  try {
    const model = createOpenAICompatibleModel({
      kind: "openai-compatible",
      baseUrl: `http://127.0.0.1:${server.port}/v1`,
      model: "dream-model",
      apiKey: "TEST_KEY_MARKER",
    })
    try {
      await model.complete({ prompt: "p" })
      throw new Error("expected the completion to throw")
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      expect(message).toContain("500")
      expect(message).not.toContain("UPSTREAM_BODY_MARKER")
      expect(message).not.toContain("TEST_KEY_MARKER")
    }
  } finally {
    server.stop(true)
  }
})

test("a completion exceeding timeoutMs throws", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async () => {
      await Bun.sleep(2000)
      return Response.json({ choices: [{ message: { content: "TOO_LATE" } }] })
    },
  })
  try {
    const model = createOpenAICompatibleModel({
      kind: "openai-compatible",
      baseUrl: `http://127.0.0.1:${server.port}/v1`,
      model: "dream-model",
    })
    expect(model.complete({ prompt: "p", timeoutMs: 150 })).rejects.toThrow()
  } finally {
    server.stop(true)
  }
})
