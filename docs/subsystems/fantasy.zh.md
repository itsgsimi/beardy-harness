# Fantasy 读取

[English](fantasy.md) | 中文

[Fantasy 定义](../../packages/fantasy/fantasy/README.zh.md)声明只读视图和品牌化 Yahoo 键。[Yahoo 提供方](../../packages/fantasy/fantasy-yahoo/README.zh.md)提供私有 OAuth 存储及 REST 读取。[模型工具](../../packages/fantasy/tool-fantasy/README.zh.md)向调用方 Session 提供有界结果。[报告插件](../../packages/fantasy/fantasy-reports/README.zh.md)定时发送每周报告。

## Authority and token ownership

提供方要求 `tokenFile` 位于 `$DSH_HOME` 下。仅当自有存储为空时，它可一次性复制可选的私有 `importFrom` 文件；它从不刷新或写入导入来源。DSH 存储保留与 yahoo_oauth 兼容的字段，并在独占同级锁下通过私有临时文件替换。存储无效，或存储缺失且没有有效导入来源时，提供方加载即失败。只有配置在 `authPresets` 中的预设能执行人工 `/fantasy auth` 命令；其回调输入不写入 `command/run`。模型工具不能调用授权路径。

`callerTeams` 将确切的 Session 预设 ID 映射到球队键。`teamFor` 读取可信 Session 头，因此模型提出“我的球队”请求时不能冒用其他对话通道。Goran 与 Mamabear 通过一个获授权的账户共享联盟读取，但默认球队键不同。

## Read views and paging

`FantasyLeagueSettings` 包含阵容位置与计分系数。Yahoo 提供相应字段时，`FantasyTeam` 包含排名、实际分数和对阵预测分数。`FantasyPlayer` 包含阵容位置、已选槽位、槽位锁定、状态与伤病说明、轮空周、得分、持有率和统计；当 Yahoo 本周拒绝移动某名在册球员（通常因为其比赛已开始）时，该球员的槽位即被锁定。交易与选秀结果保留球队和球员键。Yahoo 的数字键集合及局部对象数组先经过规范化，之后工具结果才进入模型。

`fantasy` 工具只有由 GET 支持的操作：leagues、league、standings、scoreboard、matchup、team、players、player、transactions、draft 和 weeks。长的序列化结果暴露 `next_offset`；Yahoo 球员与交易分页暴露 `next_start`。工具调用与结果保存在普通 Session 历史中。token 存储和 API bearer 请求头从不向模型显示。

## Weekly reports

报告插件按显式球队键读取配置的球队，而不是按调用方预设读取，因此一个组合可以同时为 Goran 和 Mamabear 的球队生成报告。每份报告都是一次研究工作流运行：Yahoo 阵容、阵容位、计分、对阵、状态和预测分数是权威上下文，网页只有写出其所针对的球员时才被采纳。在任何审阅之前，代码会依据联盟的 Yahoo 首发位、槽位锁定、轮空周和不可出场状态核对阵容是否合法；只有通过审阅策略的报告才会送到球队的 Discord 频道。插件启动时，若某支球队的最近时段仍在其窗口内且研究历史中没有已完成的报告，就对该时段补跑一次；已完成的报告则以原始触发时间再次交给投递。影子模式把所有报告只发送到一个配置的频道，并附上标明球队的标签。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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

Types: [Session](session.zh.md)

Source: [`packages/fantasy/fantasy/src/index.ts`](../../packages/fantasy/fantasy/src/index.ts)
<!-- END GENERATED cordis-surface -->
