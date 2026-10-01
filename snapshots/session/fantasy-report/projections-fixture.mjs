/** Fixed Sleeper week 3 projection rows behind the real projection provider. */
export const name = 'fantasy-report-projections-fixture'
export const inject = ['loader']

/** Sleeper projection rows: [first name, last name, position, team, stats]. */
const ROWS = [
  ['Trevor', 'Lawrence', 'QB', 'JAX', { pass_yd: 245, pass_td: 1.6, pass_int: 0.8, rush_att: 3, rush_yd: 15, rush_td: 0.1, fum_lost: 0.1 }],
  ['Jayden', 'Daniels', 'QB', 'WAS', { adp_dd_ppr: 1000 }],
  ['Jahmyr', 'Gibbs', 'RB', 'DET', { rush_att: 15, rush_yd: 78, rush_td: 0.7, rec: 3.5, rec_yd: 28, rec_td: 0.2, rec_tgt: 4.3, fum_lost: 0.05 }],
  ['Omarion', 'Hampton', 'RB', 'LAC', { rush_att: 13, rush_yd: 62, rush_td: 0.5, rec: 2.4, rec_yd: 18, rec_td: 0.1 }],
  ['Breece', 'Hall', 'RB', 'NYJ', { rush_att: 14, rush_yd: 60, rush_td: 0.4, rec: 2.8, rec_yd: 20 }],
  ['J.K.', 'Dobbins', 'RB', 'DEN', { rush_att: 10, rush_yd: 45, rush_td: 0.35, rec: 1.2, rec_yd: 8 }],
  ['Bhayshul', 'Tuten', 'RB', 'JAX', { rush_att: 6, rush_yd: 25, rush_td: 0.15, rec: 1, rec_yd: 7 }],
  ['Parker', 'Washington', 'WR', 'JAX', { rec: 4.8, rec_yd: 58, rec_td: 0.35, rec_tgt: 7 }],
  ['Zay', 'Flowers', 'WR', 'BAL', { rec: 4.5, rec_yd: 54, rec_td: 0.3, rush_yd: 4, rec_tgt: 7.2 }],
  ['Jordan', 'Addison', 'WR', 'MIN', { rec: 3.6, rec_yd: 44, rec_td: 0.25, rec_tgt: 5.8 }],
  ['Nico', 'Collins', 'WR', 'HOU', { adp_dd_ppr: 1000 }],
  ['Olamide', 'Zaccheaus', 'WR', 'ATL', { rec: 2, rec_yd: 22, rec_td: 0.1 }],
  ['Tyler', 'Warren', 'TE', 'IND', { rec: 4.2, rec_yd: 46, rec_td: 0.3 }],
  ['Isaiah', 'Likely', 'TE', 'NYG', { rec: 2.5, rec_yd: 26, rec_td: 0.15 }],
  ['Cairo', 'Santos', 'K', 'CHI', { fgm_20_29: 0.4, fgm_30_39: 0.6, fgm_40_49: 0.5, fgm_50p: 0.2, fgmiss_40_49: 0.2, xpm: 2.4, xpmiss: 0.1 }],
  ['Pittsburgh', 'Steelers', 'DEF', 'PIT', { sack: 2.8, int: 0.8, fum_rec: 0.6, def_td: 0.2, safe: 0.05, blk_kick: 0.05, def_pr_td: 0.05, pts_allow: 19.5 }],
]

const BODY = JSON.stringify(ROWS.map(([first, last, position, team, stats]) => ({
  team, player: { first_name: first, last_name: last, position, team, fantasy_positions: [position] }, stats,
})))

export async function apply(ctx) {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input))
    if (url.origin !== 'https://api.sleeper.com') return originalFetch(input, init)
    if (url.pathname !== '/projections/nfl/2026/3' || init?.method !== 'GET') throw new Error(`unexpected Sleeper fixture request ${url.pathname}`)
    return new Response(BODY, { status: 200 })
  }
  ctx.effect(() => () => { globalThis.fetch = originalFetch }, 'Sleeper fixture transport')
  await ctx.loader.create({ name: '@deepseek-ai/dsh-fantasy-projections-sleeper', config: {} })
}
