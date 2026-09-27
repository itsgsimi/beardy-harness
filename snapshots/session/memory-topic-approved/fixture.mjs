/** Deterministic approval answerer for the recorded memory write. */
export const name = 'memory-approval-fixture'
export const inject = ['approval']
export function apply(ctx) {
  ctx.on('approval/request', () => Promise.resolve('allowed-once'))
}
