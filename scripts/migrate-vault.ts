// CLI wrapper around the JSON → Markdown migration.
//
//   bun run scripts/migrate-vault.ts [--dir <path>] [--verify]
//   bun run scripts/migrate-vault.ts --rollback <backupDir>
//
// --dir defaults to the configured memory directory (resolveConfig().dir).
// --verify recounts the notes on disk and compares them with the migrated
// entries. --rollback restores store.json / state.json / SUMMARY.md from a
// .memory/backup-… directory back to the memory root.
import { countVaultNotes, migrateLegacyJson, rollbackFromBackup } from "../src/vault/migrate.ts"
import { createVaultStore } from "../src/vault/vaultStore.ts"
import { resolveConfig } from "../src/config.ts"

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag)
  return index === -1 ? undefined : process.argv[index + 1]
}

const dir = argValue("--dir") ?? resolveConfig().dir
const rollback = argValue("--rollback")
const verify = process.argv.includes("--verify")

if (rollback) {
  await rollbackFromBackup(rollback, dir, (message) => console.log(`rollback: ${message}`))
  console.log(`rollback complete — ${rollback} restored to ${dir}`)
} else {
  const result = await migrateLegacyJson(dir, (message) => console.log(`migrate: ${message}`))
  if (result.alreadyMigrated) {
    console.log(`nothing to migrate in ${dir} (no store.json at the root)`)
  } else {
    console.log(`migrated ${result.migrated} entries — backup: ${result.backup}`)
  }
  if (verify) {
    // After a no-op pass result.migrated is 0: compare with the live vault
    // instead so --verify stays meaningful on an already-migrated directory.
    const expected = result.alreadyMigrated
      ? (await createVaultStore(dir).getStore()).entries.length
      : result.migrated
    const notes = await countVaultNotes(dir)
    if (notes === expected) {
      console.log(`verify OK — ${notes} notes on disk match ${expected} entries`)
    } else {
      console.error(`verify FAILED — ${notes} notes on disk vs ${expected} expected entries`)
      process.exitCode = 1
    }
  }
}
