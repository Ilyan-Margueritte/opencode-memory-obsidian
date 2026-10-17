// Installation create-only de l'agent `memory` par le plugin :
// la source vit dans `agents/memory.md` du paquet, la copie dans
// `<config>/opencode/agents/memory.md` n'est JAMAIS écrasée.
import { expect, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, "..")

// --- Résolution de la source selon la disposition du paquet ----------------

test("résout la source agents/memory.md depuis une disposition dist (paquet npm)", () => {
  // <root>/pkg/{dist, agents/memory.md} : module bundled dans dist/.
  const root = mkdtempSync(join(tmpdir(), "agent-src-dist-"))
  try {
    mkdirSync(join(root, "pkg", "dist"), { recursive: true })
    mkdirSync(join(root, "pkg", "agents"), { recursive: true })
    writeFileSync(join(root, "pkg", "agents", "memory.md"), "source", "utf8")

    const source = resolveAgentSource(join(root, "pkg", "dist"))
    expect(source).toBe(join(root, "pkg", "agents", "memory.md"))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("résout la source agents/memory.md depuis la disposition src (développement)", () => {
  // <root>/pkg/{src/agent, agents/memory.md} : module source chargé tel quel.
  const root = mkdtempSync(join(tmpdir(), "agent-src-dev-"))
  try {
    mkdirSync(join(root, "pkg", "src", "agent"), { recursive: true })
    mkdirSync(join(root, "pkg", "agents"), { recursive: true })
    writeFileSync(join(root, "pkg", "agents", "memory.md"), "source", "utf8")

    const source = resolveAgentSource(join(root, "pkg", "src", "agent"))
    expect(source).toBe(join(root, "pkg", "agents", "memory.md"))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// --- Installation create-only (avec la source RÉELLE du dépôt) --------------

test("installe create-only l'agent memory dans le dossier fourni", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-install-"))
  try {
    const target = join(dir, "memory.md")

    expect(installAgent({ agentsDir: dir })).toBe("created")
    expect(existsSync(target)).toBe(true)

    const sourcePath = resolveAgentSource()
    expect(sourcePath).toBeDefined()
    const source = readFileSync(sourcePath as string, "utf8")
    expect(readFileSync(target, "utf8")).toBe(source)

    // Une version existante (personnalisée) n'est jamais écrasée.
    writeFileSync(target, "custom", "utf8")
    expect(installAgent({ agentsDir: dir })).toBe("exists")
    expect(readFileSync(target, "utf8")).toBe("custom")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("la source de l'agent memory est valide et portable", () => {
  const sourcePath = resolveAgentSource()
  expect(sourcePath).toBeDefined()
  const source = readFileSync(sourcePath as string, "utf8")

  // Frontmatter : description en une ligne, et bimode primary + délégué.
  expect(source.startsWith("---\n")).toBe(true)
  expect(source).toContain("mode: all")
  const description = /^(description: ".*")$/m.exec(source)?.[1]
  expect(description).toBeDefined()

  // Les neuf outils memory_* sont tous documentés.
  for (const tool of [
    "memory_read",
    "memory_write",
    "memory_update",
    "memory_forget",
    "memory_clear",
    "memory_inspect",
    "memory_why",
    "memory_useful",
    "memory_irrelevant",
  ]) {
    expect(source).toContain(tool)
  }

  // Portable : aucun chemin absolu de machine.
  expect(source).not.toContain("C:/Users")
  expect(source).not.toContain("C:\\Users")
})

// --- Câblage des deux adaptateurs -------------------------------------------

async function v1harness(dir: string) {
  const instance = (await plugin.server(
    {
      client: {
        session: {
          get: async () => ({ data: { directory: "/project" } }),
          messages: async () => ({ data: [] }),
          create: async () => ({ data: { id: "child" } }),
          promptAsync: async () => ({}),
          delete: async () => ({}),
        },
      },
    },
    { dir, dream: false, surface: false },
  )) as any
  return { dispose: () => instance.dispose() }
}

async function v2harness(dir: string) {
  const tools = new Map<string, unknown>()
  await plugin.setup({
    options: { dir, dream: false, surface: false },
    location: { directory: "/project" },
    tool: {
      transform: async (callback: any) => {
        callback({ add: (tool: any) => tools.set(tool.name, tool) })
        return { dispose: async () => {} }
      },
      list: async () => [...tools.keys()].map((id) => ({ id })),
    },
    session: {
      get: async () => ({ location: { directory: "/project" } }),
      context: async () => [],
      hook: async () => ({ dispose: async () => {} }),
    },
  } as never)
}

test("le chargement de l'adaptateur installe l'agent dans le dossier global simulé", async () => {
  // AGENTS_DIR vient du preload (tests/agents-env.ts) : chaque suite de tests
  // pointe OPENCODE_MEMORY_AGENTS_DIR vers un dossier temporaire.
  expect(AGENTS_DIR).toBeDefined()
  expect(await Bun.file(join(AGENTS_DIR, "memory.md")).exists()).toBe(false)

  const vault = mkdtempSync(join(tmpdir(), "agent-wiring-v1-"))
  try {
    await v1harness(vault)
    expect(await Bun.file(join(AGENTS_DIR, "memory.md")).exists()).toBe(true)
  } finally {
    rmSync(vault, { recursive: true, force: true })
  }
})

test("le chargement V2 installe aussi l'agent", async () => {
  const vault = mkdtempSync(join(tmpdir(), "agent-wiring-v2-"))
  try {
    await v2harness(vault)
    expect(await Bun.file(join(AGENTS_DIR, "memory.md")).exists()).toBe(true)
  } finally {
    rmSync(vault, { recursive: true, force: true })
  }
})

// --- Imports en fin de fichier : ces modules n'existent pas encore (RED) ----
import plugin from "../src/index.ts"
import { installAgent, resolveAgentSource } from "../src/agent/install.ts"
import { AGENTS_DIR } from "./agents-env.ts"
