/** Resolved, bounded research-engine configuration. @module @deepseek-ai/dsh-research-local/config */

import type { ResearchBudgets } from '@deepseek-ai/dsh-research/types'

/** Deployment defaults for a general research run. */
export const DEFAULT_BUDGETS: ResearchBudgets = {
  maxRounds: 4, minRounds: 2,
  firstRoundQueries: 4, laterRoundQueries: 3, searchResultsPerQuery: 10, maxPagesPerRound: 8,
  maxTotalPages: 24, maxPageChars: 12000, maxFindingsInSynthesis: 10,
  maxConcurrentSearches: 2, maxConcurrentFetches: 3, maxConcurrentModelCalls: 1,
  softRunTimeoutMs: 300000, hardRunTimeoutMs: 1800000, stageTimeoutMs: 240000,
  planMaxTokens: 1024, queryMaxTokens: 2048, extractMaxTokens: 2048, reportMaxTokens: 8192,
  maxEmptyRounds: 2, reportPageChars: 16000, maxReportBytes: 1048576, maxEvidenceBytes: 8388608,
}

/** Provider route, ownership policy, and optional budget overrides. */
export interface Config extends Partial<ResearchBudgets> {
  /** Exact model provider route recorded with each run. */
  provider: string
  /** Exact model name recorded with each run. */
  model: string
  /** Optional effort supported by the exact model route. */
  reasoningEffort?: string
  /** Session isolation by default; profile scope requires a single-user deployment. */
  ownerScope?: 'session' | 'profile'
  /** Stable single-user profile authority, required with profile scope. */
  ownerNamespace?: string
  /** Sampling temperature from 0 through 2 of every stage request a workflow stage does not override; default 0.2. */
  stageTemperature?: number
}

/** Stage temperature for structured, instruction-following stages. */
export const DEFAULT_STAGE_TEMPERATURE = 0.2

/** Fully materialized settings retained by one provider instance. */
export type ResolvedConfig = Omit<Config, keyof ResearchBudgets | 'ownerScope' | 'ownerNamespace' | 'stageTemperature'> & {
  readonly budgets: ResearchBudgets
  readonly stageTemperature: number
} & (
  | { readonly ownerScope: 'session'; readonly ownerNamespace?: never }
  | { readonly ownerScope: 'profile'; readonly ownerNamespace: string }
)

/**
 * Resolve defaults and reject invalid direct-constructor or Loader input.
 * @param config - supplied provider configuration.
 * @returns validated exact route, ownership, and budget settings.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  if (!config.provider.trim() || !config.model.trim()) throw new Error('research provider and model must be nonblank')
  if (config.reasoningEffort !== undefined && !config.reasoningEffort.trim()) {
    throw new Error('research reasoningEffort must be nonblank')
  }
  const stageTemperature = config.stageTemperature ?? DEFAULT_STAGE_TEMPERATURE
  assertTemperature(stageTemperature, 'research stageTemperature')
  const ownerScope = config.ownerScope ?? 'session'
  let owner: { readonly ownerScope: 'session' } | { readonly ownerScope: 'profile'; readonly ownerNamespace: string }
  if (ownerScope === 'profile') {
    const namespace = config.ownerNamespace
    if (!namespace?.trim()) throw new Error('research profile owner scope requires ownerNamespace')
    owner = { ownerScope, ownerNamespace: namespace }
  } else {
    if (config.ownerNamespace !== undefined) throw new Error('research ownerNamespace requires profile owner scope')
    owner = { ownerScope }
  }
  const budgets = { ...DEFAULT_BUDGETS }
  for (const key of Object.keys(DEFAULT_BUDGETS) as Array<keyof ResearchBudgets>) {
    const value = config[key]
    if (value === undefined) continue
    const min = key === 'maxPageChars' ? 1000 : 1
    const max = key === 'maxPageChars' ? 100000
      : key === 'maxTotalPages' ? 200
        : key === 'maxFindingsInSynthesis' ? 100
          : key.startsWith('maxConcurrent') ? 12
            : key.endsWith('TimeoutMs') ? 86400000
              : ['maxRounds', 'minRounds', 'firstRoundQueries', 'laterRoundQueries', 'searchResultsPerQuery', 'maxPagesPerRound', 'maxEmptyRounds'].includes(key) ? 20
                : key === 'reportPageChars' ? 1000000
                  : key.endsWith('MaxTokens') ? 1000000 : Number.MAX_SAFE_INTEGER
    if (!Number.isSafeInteger(value) || value < min || value > max) {
      throw new Error(`research ${key} must be a safe integer from ${min} through ${max}`)
    }
    budgets[key] = value
  }
  if (budgets.minRounds > budgets.maxRounds || budgets.maxEmptyRounds > budgets.maxRounds) {
    throw new Error('research minRounds and maxEmptyRounds must not exceed maxRounds')
  }
  if (budgets.maxTotalPages < budgets.maxPagesPerRound) {
    throw new Error('research maxTotalPages must cover maxPagesPerRound')
  }
  if (budgets.hardRunTimeoutMs < budgets.softRunTimeoutMs || budgets.hardRunTimeoutMs < budgets.stageTimeoutMs) {
    throw new Error('research hardRunTimeoutMs must cover softRunTimeoutMs and stageTimeoutMs')
  }
  const common = {
    provider: config.provider, model: config.model, budgets, stageTemperature,
    ...(config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort }),
  }
  return { ...common, ...owner }
}

/**
 * Reject a sampling temperature outside the range model routes accept.
 * @param value - configured or workflow-supplied temperature.
 * @param name - setting name used in the error.
 */
export function assertTemperature(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 2) throw new Error(`${name} must be a number from 0 through 2`)
}
