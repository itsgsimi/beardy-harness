---
name: "dsh-session-search-storage-failure-diagnosis"
description: "Diagnose DSH session-query tool failures whose model-visible text is \"session history storage is unavailable\" (SESSION_QUERY_PERSISTENCE_FAILED): map the sanitized message back to its throw site, probe the sqlite derived index and the durable JSONL store offline without touching either, reproduce the real read path over a COPY of the operator's store to name the exact poison session, and audit which sessions an index actually covers (workspace scoping, live-shadowed rows, unreachable null-cwd rows). Also covers why the host journal shows nothing."
whenToUse: "When a DSH session-query tool (session_search, session_event_search, session_event_read) fails with \"session history storage is unavailable\" / SESSION_QUERY_PERSISTENCE_FAILED, when search works in one deployment but not another carrying older durable session history, or when asked why a known session cannot be found."
---

# DSH session-search storage-failure diagnosis

Symptom: `session_search`, `session_event_search`, or `session_event_read` returns
`Error: session history storage is unavailable` (Web card shows
`SessionQueryError: SESSION_QUERY_PERSISTENCE_FAILED`). Reads of a **live** session
(`session_trace`) still work — the live path never consults persistence.

## 1. Map the model-visible text back to a code, then to throw sites

The tool layer sanitizes causes into fixed strings. Grep the message text:

- `packages/session-query/tool-session-query/src/service-boundary.ts` — one table mapping every
  `SessionQueryErrorCode` to the model-safe sentence. `session history storage is unavailable`
  == `SESSION_QUERY_PERSISTENCE_FAILED`.
- Then grep that code across `packages/session-query/` for throw sites. Only some carry a
  `cause`; the "did not stabilize after one retry" site has none, so logs cannot help there.

Do not conclude corruption from the message: it means "some read threw", including format refusals.

## 2. Rule out real storage damage first (all read-only)

- Derived index: `node -e` with `DatabaseSync(path, {readOnly:true})` →
  `pragma integrity_check`, `select count(*) from persisted_sessions`. Healthy DB + failing tool
  means the fault is on the persistence side, not the index file.
- Durable store (`$DSH_HOME/sessions/<encoded-cwd>/session-<uuid>/session.vN.jsonl.zstd`):
  full-frame decode each log with `zstd -dc <file> -o /dev/null` (non-zero exit = truncation);
  compare filename generation against the header's `version` (mismatch is a hard throw site in
  `session-persistence-jsonl/src/index.ts::readGenerationHeader`); look for duplicate session ids
  across project dirs, stray flat `*.jsonl*` files at project level (`legacyLayout`), and
  opposite-compression logs in one dir (`encodingMismatch`).
- `find` treats leading `--` directory names as predicates; use Node `fs.readdirSync` for these
  encoded-cwd dirs.

## 3. Get the real cause when logs are silent

Host logs may be filtered away entirely: check `$DSH_HOME/../.config/*/gateway-logging.mjs` (or
whatever plugin the systemd unit's `--patch` inserts) — an exporter with `levels:{default:3}` that
prints only selected lines discards the `logger.warn` carrying the cause chain.

Journal access usually works from inside the sandbox even though processes are invisible
(bwrap `--unshare-pid`, `--ro-bind / /`):

```sh
systemctl --user list-units | grep -i <host>
journalctl --user -u <unit> --since '<time>' --no-pager | grep -viE '<known noise>'
cat ~/.config/systemd/user/<unit>.service   # ExecStart shows profile, patches, DSH_HOME, cwd
```

## 4. Reproduce over a COPY of the operator's store (never the live one)

This is the decisive step and it needs no model call.

1. `cp -a "$DSH_HOME/sessions" <workspace>/.tmp-repro/sessions` (tens of MB), plus
   `cp "$DSH_HOME/session-search.sqlite" .tmp-repro/index.sqlite` to reproduce with the stale index.
2. Put the script **inside a package that has the deps linked** (e.g.
   `packages/session-query/session-query-sqlite/.tmp-verify.mts`) — bare `@deepseek-ai/*` specifiers
   do not resolve from the repo root.
3. Boot the real stack; a stubbed ctx fails (`new Service` needs `ctx.reflect.provide`):

```ts
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SqliteSessionQueryEngine from './src/index.ts'   // src + `pnpm exec tsx` avoids a full build

const ctx = new Context()
await ctx.plugin(SessionStore)
await ctx.plugin(JsonlSessionPersistence, { root: '<copy>/sessions', compression: 'zstd' })
await ctx.plugin(SqliteSessionQueryEngine, { path: '<copy>/verify.sqlite' })
const page = await ctx.sessionQuery.searchSessions({ query: 'x', limit: 5 })
```

4. Print `e.code` and walk `e.cause` recursively — the underlying class is usually
   `SessionFormatUnsupportedError`, which the wrapper hides.
5. Enumerate blast radius: loop `persistence.list()` then `open(id,'read')` + `handle.read(0)` per
   session and tally refusal classes. Observed real classes: `cannot safely transform unclassified
   message source` (`session-format-v2-to-v3/src/payload.ts`) and
   `user/message N source has unexpected member "..."`; refusals compose in `session-format/src/chain.ts`.

Interpretation: `_observeStable` cold-reads **every** listed persisted session across **all**
workspaces, so one uninterpretable log fails search host-wide; it can never index successfully, so
the outage is permanent, not transient.

## 5. Fix shape and verification

Graceful degradation belongs where the decision is made: catch `SessionFormatUnsupportedError` per
cold read and leave the entry unloaded (`_observeStable`) — reconciliation already selects only
`loaded !== undefined` entries, so no new state is needed. Mirror it with a spec mounting one
readable + one refusing stored session, update both README languages, and add an Agent Note
(`implemented/bug-fix/`).

- Focused run: `pnpm exec vitest run <spec> -t '<test name>'`, then the whole file.
- Cost check before adding any memoization: time 5 repeated searches over the copied store; warm
  reconcile of ~149 sessions with 27 refusals measured ~0.16s, so a refusal cache was rejected.
- `pnpm run test:docs` gates the note/README pairing.

## 6. Audit which sessions an index actually covers

Answer "why can't I find session X" with counts instead of guesses. Storage is ONE shared tree
(`$DSH_HOME/sessions/<encoded-cwd>/…`); workspace scoping happens at query time —
`tool-session-query/src/operations.ts` pushes `{ kind: 'cwd', values: [caller cwd] }` onto every
cross-session search and refuses outright when the caller session has no cwd.

Reconcile on-disk against indexed, then classify every gap:

```sh
# rows per workspace, and the unreachable ones
node -e "const{DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('$DSH_HOME/session-search.sqlite',{readOnly:true});
console.log(db.prepare('select cwd, count(*) n from persisted_sessions group by cwd order by n desc').all())"
```

Compare that with `fs.readdirSync` over the store dirs. A session dir whose name is absent from
`persisted_sessions.id` falls into exactly one of these buckets:

- **Format refusal** — proven by the copy-store cold-read scan in step 4; permanently excluded.
- **Live-shadowed** — reconciliation skips cold reads for sessions a live owner holds, so they index
  into connection-local TEMP tables and never appear in `persisted_sessions`. Confirm with the dir's
  `session.lock` mtime (a stamp matching host startup means it was resumed at boot) or with
  `Availability: live, persisted` in a result. Not a defect; re-check after the owner detaches.
- **Null cwd** — sessions under `$DSH_HOME/sessions/_no-cwd/` (named ids such as `preset-authored`)
  index fine but can never satisfy a cwd filter, so they are unreachable from every workspace search
  forever. Count them with `select count(*) from persisted_sessions where cwd is null`.

Two probe traps that produce confidently wrong counts:

- `persisted_sessions.id` equals the **directory name verbatim**, including a literal `session-`
  prefix where the session carries one, while a read handle's `header.id` may print without it.
  Compare directory names to index ids; stripping a `session-`/uuid pattern first invents hundreds of
  phantom misses.
- `temp.live_sessions` is connection-owned: a second read-only connection gets
  `no such table`, which means nothing about the engine's own view.

Query shape matters before concluding failure: caller text is quoted into one FTS5 phrase (literal
phrases as data), so a sentence query matches only that exact run of words. Search one or two terms.

## Sandbox gotchas that cost time here

- `.git` is read-bound: `verify-translation-pairing --write` dies in `git hash-object -w` with
  "Read-only file system". Hand the exact commands to the operator instead of escalating.
- `/tmp` is a fresh tmpfs per bash call — never stage intermediate files there across calls; write
  scratch under the workspace and delete it when evidence is captured.
- `ps`/process inspection shows only your own namespace; read unit files and journals instead.
