/**
 * Read-only composition include for presets that layer one shipped
 * composition over another.
 *
 * @module @deepseek-ai/dsh-agent-presets/include
 */

import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import { classifyRowSpecifier } from './specifier.ts'

const harnessBases = new WeakMap<object, string>()
const HARNESS_BASE = Symbol.for('dsh.agent-presets.harness-base')

/**
 * Record the host resolver base for all preset includes in one runtime root.
 *
 * A nested include inherits the source file's `baseUrl`, which is correct for
 * relative rows and wrong for package rows in a shipped preset. The outer
 * preset mount records the installed harness base here before importing the
 * nested include; the root key keeps concurrent preset sessions isolated from
 * other Cordis runtimes while sharing one resolver within this runtime.
 * @param ctx - the outer preset context.
 * @param base - the harness base URL used for package resolution.
 */
export function setPresetHarnessBase(ctx: Context, base: string): void {
  harnessBases.set(ctx.root, base)
  Object.defineProperty(ctx.root, HARNESS_BASE, {
    configurable: true,
    value: base,
  })
}

/** Resolve the harness base recorded for this runtime, if one exists. */
function presetHarnessBase(ctx: Context): string | undefined {
  return harnessBases.get(ctx.root)
    ?? (ctx.root as unknown as Record<symbol, unknown>)[HARNESS_BASE] as string | undefined
}

/**
 * Include another preset composition without allowing Loader updates to write
 * into the source file.
 *
 * Preset files are shared inputs. A nested include otherwise inherits the
 * ordinary file-backed include's write path, which could rewrite a shipped
 * composition when a child entry emits a config update.
 */
export default class PresetInclude extends Include {
  /**
   * Resolve package rows from the installed harness while retaining relative
   * rows' resolution against the included preset directory.
   * @param name - the module specifier from the row.
   * @param getOuterStack - the loader's stack composer for import diagnostics.
   * @returns the imported module, or the `cordis:` builtin.
   */
  override import(name: string, getOuterStack?: () => string[]): unknown {
    const row = classifyRowSpecifier(name)
    const base = presetHarnessBase(this.ctx)
    if (base === undefined || row.kind !== 'package') return super.import(row.specifier, getOuterStack)
    const internal = this.ctx.loader.internal
    /* v8 ignore next -- Node always supplies the internal module loader; the branch keeps a
       hypothetical embedder from losing the row's name in a resolution error. */
    if (internal === undefined) return super.import(row.specifier, getOuterStack)
    return internal.import(row.specifier, base, {})
  }

  /** Ignore Loader write-back for the shared source composition. */
  override write(): void {
  }
}
