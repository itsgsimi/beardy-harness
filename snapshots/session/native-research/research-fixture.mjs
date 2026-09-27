/** Native provider with fixture-only sequencing for progress and cancellation. */
import LocalResearchService from '@deepseek-ai/dsh-research-local'
import { releaseStatus } from './gate.mjs'

export default class SnapshotResearchService extends LocalResearchService {
  async start(request) {
    if (request.query === 'Cancel this run') return this.startStored(request)
    return super.start(request)
  }

  async status(id, owner) {
    const view = await super.status(id, owner)
    releaseStatus()
    return view
  }

  async report(id, owner) {
    await this.whenDone(id)
    return super.report(id, owner)
  }
}
