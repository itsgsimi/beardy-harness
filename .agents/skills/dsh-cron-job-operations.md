---
name: "dsh-cron-job-operations"
description: "Use when asked to list, disable, pause, reschedule, or change delivery for a cron job in a DSH deployment, or when a cron edit appears to have no effect: tell config-owned from stored jobs and their hard permission split, find where a job is actually defined (a shipped bundle patch carries an empty job list; live definitions sit in the operator profile patch under ~/.dsh/profiles), apply delivery and schedule edits safely, and know when a change needs a host restart instead of taking effect live."
---

# DSH cron job operations

## Origin decides what you may do

`cron_manage(action: list)` labels each job `(config)` or `stored`. This is a hard permission boundary, enforced in `packages/cron/cron/src/registry.ts` by `requireStored(name, action)`:

- **stored** — full CRUD: `create`, `update`, `delete`, `pause`, `resume`, `note`.
- **config** — only `list`, `run_now`, `note`. Pause/resume fails with `job "<name>" comes from configuration; pause applies to stored jobs only`.

So "disable this job" cannot be done through the tool for a config job. Edit its definition file instead.

## Find where a config job is really defined

Shipped bundles deliberately ship an empty job list, so the live definitions are almost always in the operator's profile patch:

1. `grep -rn "<job-name>" packages/` — hits in `packages/*/*/tests/` and `snapshots/` are fixtures, not live config. The real shipped shape is usually `packages/bundle/<bundle>/cordis.patch.yml`, which mounts the plugin with `jobs: []`.
2. The live definitions are in `~/.dsh/profiles/<profile>/cordis.patch.yml` under a `- id: cron` row's `config.jobs`.
3. Ignore sibling files named `cordis.patch.yml.pre-*` and `.bak` — those are operator snapshots, not loaded.

The profile lives **outside** the session workspace, so writes there hit a read-only sandbox denial. Escalate once with the narrowest wider mode (`danger-full-access`) plus a justification naming the file and the user's request. Expect repeated cancellations and retry only when the user says to.

## Editing safely

- Snapshot first: `cp cordis.patch.yml cordis.patch.yml.pre-<change>`, matching the existing convention in that directory.
- Re-read the whole cron block before editing; the operator may have changed the file since you last looked (line counts shift silently, and a stale read makes an edit fail or land wrong).
- Validate that it still parses, stripping the `!!js` tag so plain YAML can read the expression bodies:

```sh
node -e "const d=require('./node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/index.js');
const t=require('fs').readFileSync(process.env.HOME+'/.dsh/profiles/beardy/cordis.patch.yml','utf8');
for(const j of d.parse(t.replace(/!!js/g,'')).find(r=>r.id==='cron').config.jobs) console.log(j.name, j.deliverChannel)"
```

- Confirm the edit with `diff cordis.patch.yml.pre-<change> cordis.patch.yml`.

## Restart semantics — the part that bites

Config jobs are read at load. The scheduler re-plans timers **only** on a write to the `cron_jobs` storage `jobs` table (`index.ts`, the `domain/changed` handler). Editing YAML while the host runs changes nothing until restart; say so explicitly rather than implying the change is live.

## Delivery facts

- A job with no `deliverChannel` posts nowhere: the gateway listener returns early when `deliverChannelId === undefined` (`packages/discord/discord-gateway/src/conversation.ts`, `attachCronDelivery`). Its output exists only in its own session, named `cron-<job-name>-<uuid>`.
- Delivery is keyed on **channel id, not job name**, and resolves through `router.deliver(channelId, ...)`. Cron output can never reach a user DM unless the configured channel *is* a group DM id. Renaming a job does not stop it posting.
- `deliverOutcomes` (config default `true`) only adds failure/timeout lines once a target exists; with no target, even failures stay silent.

## Arm-state internals, for design work

`RegistryJob.enabled` is the single arm gate, applied at three points: `scheduled()` filters it before building timers, `resolveJob()` returns `undefined` when unarmed so an existing timer skips its fire, and `beginRun()` refuses a reservation (`registry.ts`). Config jobs enter through `fromConfig()`, which hardcodes `enabled: true`. That makes a clean disable design possible without new machinery: add an optional `enabled` to `jobStateRecord` (no domain version bump) and let it override the config default.
