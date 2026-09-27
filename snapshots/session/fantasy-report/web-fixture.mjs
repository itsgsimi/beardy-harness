/** One dated news page per roster player; search answers each player query with that player's page. */
export const name = 'fantasy-report-web-fixture'
export const inject = ['web']

const PAGES = [
  ['Trevor Lawrence', 'Trevor Lawrence practiced fully on Wednesday and is expected to start in week 3.'],
  ['Jahmyr Gibbs', 'Jahmyr Gibbs practiced fully on Wednesday and led the backfield with 21 touches in week 2.'],
  ['Omarion Hampton', 'Omarion Hampton practiced fully on Wednesday and is expected to handle early downs in week 3.'],
  ['Parker Washington', 'Parker Washington practiced fully on Wednesday and ran a route on 88 percent of dropbacks in week 2.'],
  ['Zay Flowers', 'Zay Flowers was limited in practice Wednesday with a hamstring injury and is questionable for week 3.'],
  ['Tyler Warren', 'Tyler Warren practiced fully on Wednesday and saw seven targets in week 2.'],
  ['Breece Hall', 'Breece Hall practiced fully on Wednesday and is expected to lead the backfield in week 3.'],
  ['Jordan Addison', 'Jordan Addison practiced fully on Wednesday and caught five passes in week 2.'],
  ['Jayden Daniels', 'Jayden Daniels did not practice Wednesday and has been ruled out for week 3 with an elbow injury.'],
  ['J.K. Dobbins', 'J.K. Dobbins practiced fully on Wednesday and is splitting carries in week 3.'],
  ['Nico Collins', 'Nico Collins did not practice Wednesday and is out for week 3 with a hamstring injury.'],
  ['Bhayshul Tuten', 'Bhayshul Tuten practiced fully on Wednesday and is the change-of-pace back in week 3.'],
  ['Isaiah Likely', 'Isaiah Likely practiced fully on Wednesday and played 60 percent of snaps in week 2.'],
  ['Cairo Santos', 'Cairo Santos practiced fully on Wednesday and has made every field goal this season.'],
  ['Steelers', 'The Steelers defense has nine sacks through two weeks and faces a turnover-prone offense in week 3.'],
]

export function apply(ctx) {
  ctx.web.registerSearchProvider({
    id: 'fantasy-report-fixture', available: () => true,
    async search(request) {
      const index = PAGES.findIndex(([player]) => request.query.includes(player))
      return { sources: index < 0 ? [] : [{ url: `https://news.example/week-3/${index + 1}`, title: `${PAGES[index][0]} week 3 notes` }],
        truncated: false }
    },
  })
  ctx.web.registerFetchProvider({
    id: 'fantasy-report-fixture', available: () => true,
    async fetch(request) {
      const index = Number(/\/([0-9]+)$/u.exec(request.url)?.[1]) - 1
      return { url: request.url, statusCode: 200, body: { kind: 'text', content: `Week 3 injury report. ${PAGES[index][1]}` }, truncated: false }
    },
  })
}
