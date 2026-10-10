// Dream model provider: how DREAM consolidation reaches a model.
//
// Two kinds, chosen through the dreamProvider option (see src/config.ts):
//   - "opencode": the caller drives the local OpenCode session model itself;
//     this module only hands back the discriminator.
//   - "openai-compatible": any POST /chat/completions endpoint called with
//     fetch (Bun's built-in) — no vendor SDK, no new runtime dependency.
//
// The memory must stay consultable when the model is unavailable: complete()
// may throw, and the CALLER decides whether to skip the consolidation round.
// Failure messages quote the HTTP status only — never the response body and
// never the API key.
import type { MemoryConfig } from "../config.ts"

export type DreamModel = {
  complete(req: { prompt: string; timeoutMs?: number }): Promise<string>
}

export type DreamProviderConfig =
  | { kind: "opencode" }
  | {
      kind: "openai-compatible"
      baseUrl: string
      apiKey?: string
      model: string
      extraHeaders?: Record<string, string>
    }

const DEFAULT_TIMEOUT_MS = 120_000

// Map a resolved MemoryConfig onto the provider description. resolveConfig
// already enforces that "openai-compatible" comes with dreamBaseUrl and
// dreamModel; the checks below keep hand-built MemoryConfigs from producing
// an unusable provider (errors quote the option name, never a secret).
export function dreamProviderConfig(config: MemoryConfig): DreamProviderConfig {
  if (config.dreamProvider === "openai-compatible") {
    const baseUrl = config.dreamBaseUrl
    const model = config.dreamModel
    if (typeof baseUrl !== "string" || baseUrl.trim() === "") {
      throw new Error(`opencode-memory dreamBaseUrl must be set when dreamProvider is "openai-compatible"`)
    }
    if (typeof model !== "string" || model.trim() === "") {
      throw new Error(`opencode-memory dreamModel must be set when dreamProvider is "openai-compatible"`)
    }
    return {
      kind: "openai-compatible",
      baseUrl,
      model,
      ...(config.dreamApiKey === undefined ? {} : { apiKey: config.dreamApiKey }),
    }
  }
  return { kind: "opencode" }
}

export function createOpenAICompatibleModel(cfg: Extract<DreamProviderConfig, { kind: "openai-compatible" }>): DreamModel {
  return {
    async complete({ prompt, timeoutMs }) {
      const headers: Record<string, string> = {
        "content-type": "application/json",
        ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}),
        ...cfg.extraHeaders,
      }
      // fetch rejects on network errors or on the timeout abort; those
      // rejections never carry request headers (so never the API key).
      const response = await fetch(`${cfg.baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({ model: cfg.model, messages: [{ role: "user", content: prompt }], stream: false }),
        signal: AbortSignal.timeout(timeoutMs ?? DEFAULT_TIMEOUT_MS),
      })
      if (!response.ok) {
        // The upstream body may contain request material: report status only.
        throw new Error(`opencode-memory dream request failed with HTTP status ${response.status}`)
      }
      let payload: unknown
      try {
        payload = await response.json()
      } catch {
        // JSON.parse errors can quote body fragments: discard the original.
        throw new Error("opencode-memory dream response was not valid JSON")
      }
      const content = (payload as { choices?: Array<{ message?: { content?: unknown } }> })?.choices?.[0]?.message?.content
      if (typeof content !== "string") throw new Error("opencode-memory dream response has no message content")
      return content
    },
  }
}
