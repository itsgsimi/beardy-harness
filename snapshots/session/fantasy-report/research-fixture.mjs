/** Native provider whose first listing waits for the scheduled report it fires. */
import LocalResearchService from '@deepseek-ai/dsh-research-local'
import { fireOnce } from './gate.mjs'

export default class SnapshotResearchService extends LocalResearchService {
  async list(request) {
    await fireOnce()
    return super.list(request)
  }
}
