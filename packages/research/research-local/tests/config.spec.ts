import { expect, it } from 'vitest'
import { DEFAULT_BUDGETS, resolveConfig, type Config } from '../src/config.ts'

const base: Config = { provider: 'mock', model: 'test-model' }

it('materializes every engine budget and profile authority from validated config', () => {
  expect(resolveConfig(base)).toMatchObject({ ownerScope: 'session', budgets: DEFAULT_BUDGETS })
  const overrides: Config = {
    ...base, ownerScope: 'profile', ownerNamespace: 'home', reasoningEffort: 'medium',
    maxRounds: 3, minRounds: 1, firstRoundQueries: 2, laterRoundQueries: 2,
    searchResultsPerQuery: 2, maxPagesPerRound: 2, maxTotalPages: 3,
    maxPageChars: 1000, maxFindingsInSynthesis: 2,
    maxConcurrentSearches: 1, maxConcurrentFetches: 1, maxConcurrentModelCalls: 2,
    softRunTimeoutMs: 100, hardRunTimeoutMs: 200, stageTimeoutMs: 150,
    planMaxTokens: 2, queryMaxTokens: 2, extractMaxTokens: 2, reportMaxTokens: 3,
    maxEmptyRounds: 1, reportPageChars: 2, maxReportBytes: 3, maxEvidenceBytes: 4,
  }
  expect(resolveConfig(overrides)).toMatchObject({ ownerScope: 'profile', ownerNamespace: 'home',
    reasoningEffort: 'medium', budgets: { maxRounds: 3, maxReportBytes: 3, maxConcurrentModelCalls: 2 } })
})

it.each([
  [{ ...base, provider: ' ' }, /provider and model/],
  [{ ...base, reasoningEffort: ' ' }, /reasoningEffort/],
  [{ ...base, ownerScope: 'profile' as const }, /ownerNamespace/],
  [{ ...base, ownerScope: 'profile' as const, ownerNamespace: ' ' }, /ownerNamespace/],
  [{ ...base, ownerNamespace: 'home' }, /ownerNamespace/],
  [{ ...base, maxRounds: 0 }, /maxRounds/],
  [{ ...base, maxRounds: Number.NaN }, /maxRounds/],
  [{ ...base, maxRounds: Number.MAX_SAFE_INTEGER + 1 }, /maxRounds/],
  [{ ...base, maxPageChars: 999 }, /maxPageChars/],
  [{ ...base, maxPageChars: 100001 }, /maxPageChars/],
  [{ ...base, maxTotalPages: 201 }, /maxTotalPages/],
  [{ ...base, maxFindingsInSynthesis: 101 }, /maxFindingsInSynthesis/],
  [{ ...base, maxConcurrentFetches: 13 }, /maxConcurrentFetches/],
  [{ ...base, hardRunTimeoutMs: 86400001 }, /hardRunTimeoutMs/],
  [{ ...base, firstRoundQueries: 21 }, /firstRoundQueries/],
  [{ ...base, reportPageChars: 1000001 }, /reportPageChars/],
  [{ ...base, reportMaxTokens: 1000001 }, /reportMaxTokens/],
  [{ ...base, maxEvidenceBytes: 0 }, /maxEvidenceBytes/],
  [{ ...base, maxRounds: 1 }, /minRounds/],
  [{ ...base, maxRounds: 1, minRounds: 1, maxEmptyRounds: 2 }, /maxEmptyRounds/],
  [{ ...base, maxTotalPages: 1 }, /maxTotalPages/],
  [{ ...base, hardRunTimeoutMs: 299999 }, /hardRunTimeoutMs/],
  [{ ...base, hardRunTimeoutMs: 300000, stageTimeoutMs: 300001 }, /hardRunTimeoutMs/],
] as const)('rejects invalid configuration %#', (config, message) => {
  expect(() => resolveConfig(config)).toThrow(message)
})
