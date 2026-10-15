import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin from "../src/index.ts"
import { extractRememberCommand } from "../src/memory/autocapture.ts"
import { createStore } from "../src/store.ts"

const directory = "/project"

// --- Pure extractor contract ----------------------------------------------

test("extracts French explicit remember commands", () => {
  expect(extractRememberCommand("retiens que je préfère le thé.")).toEqual({
    fact: "je préfère le thé.",
    project: false,
  })
  expect(extractRememberCommand("  Souviens-toi que le build passe par Bun.")).toEqual({
    fact: "le build passe par Bun.",
    project: false,
  })
  expect(extractRememberCommand("stp retiens bien que pour ce projet on utilise Bun")).toEqual({
    fact: "pour ce projet on utilise Bun",
    project: true,
  })
  expect(extractRememberCommand("À retenir : les réponses doivent rester courtes")).toEqual({
    fact: "les réponses doivent rester courtes",
    project: false,
  })
  expect(extractRememberCommand("N'oublie pas que la clé est dans le coffre.")).toEqual({
    fact: "la clé est dans le coffre.",
    project: false,
  })
})

test("extracts English explicit remember commands", () => {
  expect(extractRememberCommand("remember that I like tea.")).toEqual({
    fact: "I like tea.",
    project: false,
  })
  expect(extractRememberCommand("please note down that this project uses Bun")).toEqual({
    fact: "this project uses Bun",
    project: true,
  })
  expect(extractRememberCommand("Keep in mind: short answers only")).toEqual({
    fact: "short answers only",
    project: false,
  })
  expect(extractRememberCommand("don't forget that staging deploys first")).toEqual({
    fact: "staging deploys first",
    project: false,
  })
})

test("ignores questions, nostalgia and small talk", () => {
  expect(extractRememberCommand("tu te souviens que j'aime le thé ?")).toBeUndefined()
  expect(extractRememberCommand("do you remember that I like tea?")).toBeUndefined()
  expect(extractRememberCommand("remember when we migrated to Bun?")).toBeUndefined()
  expect(extractRememberCommand("rappelle-toi quand on a migré sur Bun ?")).toBeUndefined()
  expect(extractRememberCommand("retiens que")).toBeUndefined()
  expect(extractRememberCommand("remember:")).toBeUndefined()
  expect(extractRememberCommand("ok, c'est noté, merci !")).toBeUndefined()
  expect(extractRememberCommand("peux-tu m'expliquer ce bug ?")).toBeUndefined()
})

// --- V1 wiring: chat.message hook ------------------------------------------

async function v1harness(dir: string, options: Record<string, unknown> = {}) {
  const instance = (await plugin.server(
    {
      client: {
        session: {
          get: async () => ({ data: { directory } }),
          messages: async () => ({ data: [] }),
          create: async () => ({ data: { id: "child" } }),
          promptAsync: async () => ({}),
          delete: async () => ({}),
        },
      },
    },
    { dir, dream: false, surface: false, ...options },
  )) as any
  return {
    chatMessage: (text: string) =>
      instance["chat.message"](
        { sessionID: "session" },
        { message: {}, parts: [{ type: "text", text }] },
      ) as Promise<void>,
    dispose: () => instance.dispose(),
  }
}

test("V1 chat.message deterministically stores an explicit remember command", async () => {
  const dir = await mkdtemp(join(tmpdir(), "memory-autocapture-v1-"))
  const instance = await v1harness(dir)
  try {
    await instance.chatMessage("retiens que je préfère le thé.")
    const store = await createStore(dir).getStore()
    expect(store.entries.map((e) => e.text)).toContain("je préfère le thé.")
  } finally {
    await instance.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test("V1 chat.message ignores ordinary messages and honors autocapture:false", async () => {
  const dir = await mkdtemp(join(tmpdir(), "memory-autocapture-v1-off-"))
  const instance = await v1harness(dir)
  try {
    await instance.chatMessage("peux-tu m'expliquer ce bug ?")
    expect((await createStore(dir).getStore()).entries).toHaveLength(0)
  } finally {
    await instance.dispose()
    await rm(dir, { recursive: true, force: true })
  }
  const dir2 = await mkdtemp(join(tmpdir(), "memory-autocapture-v1-disabled-"))
  const off = await v1harness(dir2, { autocapture: false })
  try {
    await off.chatMessage("retiens que je préfère le thé.")
    expect((await createStore(dir2).getStore()).entries).toHaveLength(0)
  } finally {
    await off.dispose()
    await rm(dir2, { recursive: true, force: true })
  }
})

// --- V2 wiring: session prompt hook -----------------------------------------

async function v2harness(dir: string, options: Record<string, unknown> = {}) {
  const hooks = new Map<string, any>()
  const tools = new Map<string, any>()
  const dispose = await plugin.setup({
    options: { dir, dream: false, surface: false, ...options },
    location: { directory },
    tool: {
      transform: async (callback: any) => {
        callback({ add: (tool: any) => tools.set(tool.name, tool) })
        return { dispose: async () => {} }
      },
      list: async () => [...tools.keys()].map((id) => ({ id })),
    },
    session: {
      get: async () => ({ location: { directory } }),
      context: async () => [],
      hook: async (name: string, callback: any) => {
        hooks.set(name, callback)
        return { dispose: async () => {} }
      },
    },
  } as any)
  return {
    prompt: (text: string) =>
      hooks.get("prompt")({
        sessionID: "session",
        prompt: { text },
        delivery: "user",
      }) as Promise<void>,
    dispose: async () => {
      await dispose?.()
    },
  }
}

test("V2 prompt hook deterministically stores an explicit remember command", async () => {
  const dir = await mkdtemp(join(tmpdir(), "memory-autocapture-v2-"))
  const instance = await v2harness(dir)
  try {
    await instance.prompt("remember that I like tea.")
    const store = await createStore(dir).getStore()
    expect(store.entries.map((e) => e.text)).toContain("I like tea.")
  } finally {
    await instance.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test("V2 prompt hook ignores ordinary messages", async () => {
  const dir = await mkdtemp(join(tmpdir(), "memory-autocapture-v2-off-"))
  const instance = await v2harness(dir)
  try {
    await instance.prompt("can you explain this bug?")
    expect((await createStore(dir).getStore()).entries).toHaveLength(0)
  } finally {
    await instance.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})
