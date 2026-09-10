/**
 * Verify that no tsc emit sits beside a project source file. A program whose
 * rootDir no longer contains every file it reaches (for example a client-plane
 * tsconfig that picks up a host-plane test) writes `.js`/`.d.ts` next to the
 * `.ts` sources of every package it pulled in. tsconfig `paths` and Vite then
 * resolve the stale `.js` ahead of the `.ts`, and one process runs two copies
 * of the same module: scope keys stop matching and sessions leak state. The
 * cleaner owns the definition of this residue; `pnpm run clean` removes it.
 */
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RepositoryCleaner } from './clean.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const residue = await new RepositoryCleaner(root).sourceEmitResidue()

if (residue.length > 0) {
  console.error(`verify-no-source-emit: ${String(residue.length)} emitted file(s) sit beside their sources; run \`pnpm run clean\`:`)
  for (const path of residue) console.error(`  - ${path}`)
  process.exit(1)
}
console.log('verify-no-source-emit: no tsc emit beside project sources.')
