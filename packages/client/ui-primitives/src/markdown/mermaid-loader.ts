/** Import the optional Mermaid runtime on demand. */

import type { Mermaid } from 'mermaid'

/** Load Mermaid only when a diagram is rendered.
 * @returns the loaded Mermaid runtime.
 */
export async function importMermaid(): Promise<Mermaid> {
  const { default: mermaid } = await import('mermaid')
  return mermaid
}
