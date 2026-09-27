/** Fixture-only sequencing: the first research listing fires the Wednesday report and waits for its delivery. */
let tick
let deliver
const delivered = new Promise(resolve => { deliver = resolve })
let fired = false

/** Keep the Wednesday full-report timer callback. */
export function registerTick(expression, onTick) {
  if (expression === '0 14 * * 3') tick = onTick
}

/** Release the waiting listing after the report reaches the delivery listener. */
export function markDelivered() { deliver() }

/** Fire the report once, at 2:00 PM Phoenix time on Wednesday of week 3, and wait for delivery. */
export async function fireOnce() {
  if (fired) return
  fired = true
  tick(Date.UTC(2026, 8, 23, 21, 0))
  await delivered
}
