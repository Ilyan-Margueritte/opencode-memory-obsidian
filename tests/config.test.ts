import { expect, test } from "bun:test"
import { join, resolve } from "node:path"
import { resolveConfig } from "../src/config.ts"

test("plugin options override environment values and preserve defaults", () => {
  const config = resolveConfig({
    dream: false,
    surface: false,
    summary: false,
    dir: "/tmp/memory-from-config",
    delayMs: 25,
    rerank: true,
    coreSlot: 0,
  }, {
    OPENCODE_MEMORY_DREAM: "1",
    OPENCODE_MEMORY_SURFACE: "1",
    OPENCODE_MEMORY_SUMMARY: "1",
    OPENCODE_MEMORY_DIR: "/tmp/memory-from-env",
    OPENCODE_MEMORY_DELAY_MS: "90",
    OPENCODE_MEMORY_MAX_FACTS: "7",
  })
  expect(config.dream).toBe(false)
  expect(config.surface).toBe(false)
  expect(config.summary).toBe(false)
  expect(config.dir).toBe(resolve("/tmp/memory-from-config"))
  expect(config.delayMs).toBe(25)
  expect(config.maxFacts).toBe(7)
  expect(config.rerank).toBe(true)
  expect(config.coreSlot).toBe(0)
  expect(config.maxEntries).toBe(400)
})

test("every environment setting can be supplied through plugin options", () => {
  const options = {
    off: true, dream: false, surface: false, summary: false, dir: "/tmp/memory-all-options",
    debug: true, delayMs: 0, maxEntries: 1, maxFacts: 0, maxChars: 1,
    transcriptChars: 1, sweepIntervalMs: 1, sweepStartMs: 0, sweepBatch: 1,
    gcChildAgeMs: 0, inProgressTimeoutMs: 1, rerank: true,
    rerankCandidates: 1, rerankTimeoutMs: 1, rerankCacheMs: 0,
    coreSlot: 0, surfaceRefreshMs: 0,
    dreamProvider: "openai-compatible" as const, dreamModel: "dream-model",
    dreamBaseUrl: "http://127.0.0.1:9/v1", dreamApiKey: "dream-key", staleDays: 1,
  }
  expect(resolveConfig(options, {})).toEqual({ ...options, dir: resolve("/tmp/memory-all-options") })
})

test("invalid options fail at setup with the offending name", () => {
  expect(() => resolveConfig({ dreem: false }, {})).toThrow("dreem")
  expect(() => resolveConfig({ dream: "false" }, {})).toThrow("dream")
  expect(() => resolveConfig({ summary: "false" }, {})).toThrow("summary")
  expect(() => resolveConfig({ delayMs: -1 }, {})).toThrow("delayMs")
  expect(() => resolveConfig({ rerankTimeoutMs: Infinity }, {})).toThrow("rerankTimeoutMs")
  expect(() => resolveConfig({ dir: "" }, {})).toThrow("dir")
  expect(() => resolveConfig({ dir: "relative/path" }, {})).toThrow("absolute")
})

test("dream provider options keep their defaults and read the environment", () => {
  const defaults = resolveConfig({}, {})
  expect(defaults.dreamProvider).toBe("opencode")
  expect(defaults.dreamModel).toBeUndefined()
  expect(defaults.dreamBaseUrl).toBeUndefined()
  expect(defaults.dreamApiKey).toBeUndefined()
  expect(defaults.staleDays).toBe(90)
  const fromEnv = resolveConfig({}, {
    OPENCODE_MEMORY_DREAM_PROVIDER: "openai-compatible",
    OPENCODE_MEMORY_DREAM_BASE_URL: "http://127.0.0.1:9/v1",
    OPENCODE_MEMORY_DREAM_MODEL: "dream-model",
    OPENCODE_MEMORY_STALE_DAYS: "30",
  })
  expect(fromEnv.dreamProvider).toBe("openai-compatible")
  expect(fromEnv.dreamBaseUrl).toBe("http://127.0.0.1:9/v1")
  expect(fromEnv.dreamModel).toBe("dream-model")
  expect(fromEnv.staleDays).toBe(30)
})

test("invalid dream provider options fail at setup with the offending name", () => {
  expect(() => resolveConfig({ dreamProvider: "mistral" }, {})).toThrow("dreamProvider")
  // The error must list the valid values for the enum.
  expect(() => resolveConfig({ dreamProvider: "mistral" }, {})).toThrow("openai-compatible")
  expect(() => resolveConfig({ dreamProvider: "" }, {})).toThrow("dreamProvider")
  expect(() => resolveConfig({ dreamProvider: "openai-compatible" }, {})).toThrow("dreamBaseUrl")
  expect(() => resolveConfig({ dreamProvider: "openai-compatible", dreamBaseUrl: "http://127.0.0.1:9/v1" }, {}))
    .toThrow("dreamModel")
  expect(() => resolveConfig({ dreamModel: "" }, {})).toThrow("dreamModel")
  expect(() => resolveConfig({ dreamBaseUrl: "" }, {})).toThrow("dreamBaseUrl")
  expect(() => resolveConfig({ dreamApiKey: "" }, {})).toThrow("dreamApiKey")
  expect(() => resolveConfig({ staleDays: 0 }, {})).toThrow("staleDays")
})

test("summary is enabled by default and accepts a strict environment switch", () => {
  expect(resolveConfig({}, {}).summary).toBe(true)
  expect(resolveConfig({}, { OPENCODE_MEMORY_SUMMARY: "0" }).summary).toBe(false)
  expect(() => resolveConfig({}, { OPENCODE_MEMORY_SUMMARY: "false" })).toThrow("summary")
  expect(resolveConfig({ summary: false }, { OPENCODE_MEMORY_SUMMARY: "invalid" }).summary).toBe(false)
})

test("an invalid environment value cannot prevent a plugin option from taking precedence", () => {
  const result = Bun.spawnSync({
    cmd: ["bun", "-e", `await import(${JSON.stringify(join(import.meta.dir, "..", "src", "index.ts"))})`],
    env: { ...process.env, OPENCODE_MEMORY_DELAY_MS: "invalid" },
    stdout: "pipe",
    stderr: "pipe",
  })
  expect(result.exitCode, result.stderr.toString()).toBe(0)
  expect(resolveConfig({ delayMs: 25 }, { OPENCODE_MEMORY_DELAY_MS: "invalid" }).delayMs).toBe(25)
})

test("existing environment booleans keep their 1.7.0 behavior", () => {
  const config = resolveConfig({}, { OPENCODE_MEMORY_OFF: "false", OPENCODE_MEMORY_DEBUG: "no", OPENCODE_MEMORY_RERANK: "false" })
  expect(config.off).toBe(false)
  expect(config.debug).toBe(false)
  expect(config.rerank).toBe(false)
})
