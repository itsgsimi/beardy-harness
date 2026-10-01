# Fantasy reads

English | [中文](fantasy.zh.md)

The [Fantasy definition](../../packages/fantasy/fantasy/README.md) declares read views and branded Yahoo keys. The [Yahoo provider](../../packages/fantasy/fantasy-yahoo/README.md) supplies the private OAuth store and REST reads. The [model tool](../../packages/fantasy/tool-fantasy/README.md) exposes bounded results to a caller Session. The [report plugin](../../packages/fantasy/fantasy-reports/README.md) sends scheduled weekly reports.

## Authority and token ownership

The provider requires `tokenFile` below `$DSH_HOME`. It may copy an optional private `importFrom` file once when its store is empty; it never refreshes or writes the import source. The DSH store keeps yahoo_oauth-compatible fields and is replaced through a private temporary file under an exclusive sibling lock. An invalid store or a missing store without a valid import source fails during provider load. Only configured `authPresets` may run the human `/fantasy auth` command; its callback input is omitted from `command/run`. The model tool cannot call the authorization path.

`callerTeams` maps exact Session preset IDs to team keys. `teamFor` reads the trusted Session header, so a model's “my team” request cannot impersonate another lane. Goran and Mamabear share league reads under one authorized account, while their default team keys differ.

## Read views and paging

`FantasyLeagueSettings` includes roster slots and scoring modifiers. `FantasyTeam` carries standings, actual points, and projected matchup points when Yahoo provides them. `FantasyPlayer` carries roster position, selected slot, slot lock, status and injury note, bye, scoring, ownership, and stats when present; a roster player's slot is locked once Yahoo refuses to move him for the week, usually because his game has started. Transactions and draft picks retain team and player keys. Yahoo's numbered collections and arrays of partial objects are normalized before a tool result reaches the model.

The `fantasy` tool has only GET-backed actions: leagues, league, standings, scoreboard, matchup, team, players, player, transactions, draft, and weeks. Long serialized results expose `next_offset`; Yahoo player and transaction pages expose `next_start`. Tool calls and results are stored in ordinary Session history. The token store and API bearer header are never model-visible.

## Weekly reports

The report plugin reads configured teams by explicit team key, not by caller preset, so one composition can report on both Goran's and Mamabear's teams. Each report is a research workflow run that splits deterministic work from judgment. Code reads the Yahoo roster, slots, matchup, statuses, projections, and free agents, admits web pages only when they name the player they were fetched for, chooses a legal projection-maximizing lineup under the league's starting slots, slot locks, bye weeks, and unavailable statuses, flags close calls, shortlists free agents at weak positions, and renders the report. Small logged model stages make fixed-choice per-player calls, compare the flagged close calls, pick among the shortlisted free agents, check reasons against their excerpts, and write a summary; code validates each answer item, retries an invalid player once, and degrades anything still invalid to a code default listed in the report's caveats. A report is withheld only when no model stage answers usably, and Yahoo failures send a failure notice. When the plugin starts, it catches up each team's latest slot once if that slot is inside its window and its research history has no completed report, and it hands a completed report to delivery again under its original fire time. Shadow mode sends every report only to one configured channel with a label naming its team. A human in a preset listed in `commandPresets` can run `/fantasy-report <team> [full|thursday|sunday]` to start a team's report for the current week at once; it shares the scheduled queue, posts where scheduled reports go, and is never blocked by an earlier run of the same week and mode. Every fire outcome other than a published or redelivered report is logged as a warning.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxfantasy--fantasyservice-abstract-seam"></a>

### `ctx.fantasy` — `FantasyService` (abstract seam)

Provider-neutral read operations; callers supply explicit league or team identities.

```ts cordis-catalog
/** Resolve the caller's own team from its trusted Session preset.
 * @param caller - trusted live caller Session.
 * @returns configured team for its preset, or an error when unmapped.
 */
abstract teamFor(caller: Session): TeamKeyType

/** List leagues visible to the authenticated account.
 * @param signal - caller cancellation.
 * @returns authenticated account leagues.
 */
abstract leagues(signal?: AbortSignal): Promise<readonly FantasyLeague[]>

/** Read scoring settings and roster slots for a league.
 * @param key - league identity.
 * @param signal - caller cancellation.
 * @returns league options and scoring.
 */
abstract league(key: LeagueKeyType, signal?: AbortSignal): Promise<FantasyLeagueSettings>

/** Read the current league standings.
 * @param key - league identity.
 * @param signal - caller cancellation.
 * @returns season standings.
 */
abstract standings(key: LeagueKeyType, signal?: AbortSignal): Promise<readonly FantasyTeam[]>

/** Read every matchup on a league scoreboard.
 * @param key - league identity.
 * @param week - optional scoring week.
 * @param signal - caller cancellation.
 * @returns weekly matchups.
 */
abstract scoreboard(key: LeagueKeyType, week?: number, signal?: AbortSignal): Promise<readonly FantasyMatchup[]>

/** Read matchups involving one team.
 * @param key - team identity.
 * @param week - optional scoring week.
 * @param signal - caller cancellation.
 * @returns team matchups.
 */
abstract matchups(key: TeamKeyType, week?: number, signal?: AbortSignal): Promise<readonly FantasyMatchup[]>

/** Read selected slots and player scores on a weekly roster.
 * @param key - team identity.
 * @param week - scoring week.
 * @param signal - caller cancellation.
 * @returns roster and player scores.
 */
abstract team(key: TeamKeyType, week: number, signal?: AbortSignal): Promise<FantasyRoster>

/** Search or filter one page of league players.
 * @param league - league identity.
 * @param query - search or availability filters.
 * @param signal - caller cancellation.
 * @returns one provider page.
 */
abstract players(league: LeagueKeyType, query: { search?: string status?: 'FA' | 'W' position?: string sort?: 'points' | 'rank' | 'percent_owned' start: number count: number week?: number }, signal?: AbortSignal): Promise<readonly FantasyPlayer[]>

/** Read a player's statistics and ownership in a league.
 * @param league - league identity.
 * @param key - player identity.
 * @param week - optional scoring week.
 * @param signal - caller cancellation.
 * @returns player details.
 */
abstract player(league: LeagueKeyType, key: PlayerKeyType, week?: number, signal?: AbortSignal): Promise<FantasyPlayer>

/** Read one page of league transactions.
 * @param key - league identity.
 * @param start - zero-based provider offset.
 * @param count - provider page size.
 * @param signal - caller cancellation.
 * @returns recent transactions.
 */
abstract transactions(key: LeagueKeyType, start: number, count: number, signal?: AbortSignal): Promise<readonly FantasyTransaction[]>

/** Read the league draft results.
 * @param key - league identity.
 * @param signal - caller cancellation.
 * @returns completed draft picks.
 */
abstract draft(key: LeagueKeyType, signal?: AbortSignal): Promise<readonly FantasyDraftPick[]>

/** Read NFL game week dates for the configured season.
 * @param signal - caller cancellation.
 * @returns game calendar.
 */
abstract gameWeeks(signal?: AbortSignal): Promise<readonly FantasyGameWeek[]>
```

Types: [Session](session.md)

Source: [`packages/fantasy/fantasy/src/index.ts`](../../packages/fantasy/fantasy/src/index.ts)
<!-- END GENERATED cordis-surface -->
