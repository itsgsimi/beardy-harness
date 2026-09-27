/** Synchronize progress inspection with deterministic fixture search. */
let release
const inspected = new Promise(resolve => { release = resolve })

export const waitForStatus = () => inspected
export const releaseStatus = () => { release() }
