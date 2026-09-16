---
name: "dsh-provider-unavailable-diagnosis"
description: "Diagnose a DSH tool that fails with a provider-availability error (e.g. web_search -> WEB_PROVIDER_CONFIGURED_UNAVAILABLE) by separating backend health from launch-environment wiring, then prove the fix without guessing."
whenToUse: "Use when a DSH-hosted tool reports its configured provider is registered but unavailable/missing, or when an external service (SearXNG, Exa, Perplexity, any env-configured endpoint) looks healthy from the outside while the harness refuses to call it. Also use when a newly added environment variable appears to have no effect."
---

# DSH provider-availability diagnosis

An availability error almost never means the backend is down. Availability checks are **local validation of configured settings and make no network call**, so "registered but unavailable" means missing or malformed configuration, not an outage. Establish that split first; it prevents replacing a healthy service or restarting things that cannot help.

## 1. Read the error taxonomy before touching anything

Selection semantics live in the owning Service Definition. For `ctx.web` (`packages/web/web/src/index.ts`) each code names a different cause:

| Code | Cause |
| --- | --- |
| `WEB_PROVIDER_CONFIGURED_MISSING` | configured id is not registered at all (patch/mount problem) |
| `WEB_PROVIDER_CONFIGURED_UNAVAILABLE` | registered, but its own `available()` returned false (config/env problem) |
| `WEB_PROVIDER_AMBIGUOUS` | no id configured, several usable providers |
| `WEB_PROVIDER_UNAVAILABLE` | no id configured, none usable |
| `WEB_PROVIDER_ERROR` | a request was actually made and failed (real outage, HTTP error, bad body) |

Reaching the selection stage at all proves mounting worked. `grep -rn "CONFIGURED_UNAVAILABLE" packages/` locates both the raiser and each provider's `available()` implementation.

## 2. Prove backend health independently

Container health checks are frequently fake-positive. Query the real contract instead:

```sh
docker ps -a | grep -i <service>
curl -s -o /tmp/probe.txt -w "http=%{http_code} time=%{time_total}s size=%{size_download}\n" \
  "<endpoint>?q=test&format=json" && head -c 600 /tmp/probe.txt
```

Non-empty real results plus HTTP 200 means the backend is innocent and the fault is wiring. Also read logs for a *second*, independent problem worth reporting separately but not conflating:

```sh
docker logs --tail 60 <container> 2>&1 | tail -70
```

Upstream-engine blocks (SearXNG captcha/`suspended_time` on duckduckgo or startpage) degrade result quality while availability stays fine. Report as secondary.

## 3. Trace where the setting is actually resolved from

Read the plugin's `apply()` to find the resolution order before inspecting files. The common shape is config value, then environment, then an empty-string fallback that silently produces an unusable provider:

```js
baseURL: config.baseURL ?? launchEnvironmentOf(ctx).get(SEARXNG_BASE_URL_ENV)?.value ?? ''
```

An `??` chain ending in `''` means a missing variable degrades instead of failing loudly at boot.

## 4. Inspect the live host process, never your own shell

The tool-executor environment is **not** the host environment. Find the real process and read its actual state:

```sh
for p in $(pgrep -f node); do c=$(tr '\0' ' ' < /proc/$p/cmdline 2>/dev/null)
  case "$c" in *<profile-or-bin>*) echo "PID $p :: ${c:0:180}";; esac; done | head
tr '\0' '\n' < /proc/<pid>/environ | grep -i <VAR> || echo "(absent)"
ls -l /proc/<pid>/cwd          # decides which .env is the project layer
ps -o lstart=,etime= -p <pid>  # start time; env is frozen at boot
```

`/proc/<pid>/cwd` matters because it can point at a **different checkout** than the binary's path. Then check every layer in priority order (`packages/boot/app-boot/src/index.ts`, `loadLayeredEnv`): inherited process env > `<cwd>/.env` (project) > `$DSH_HOME/.env` (user). Mask values when listing them:

```sh
grep -nE "^[A-Z_]+=" <file> | sed -E 's/(=.{0,6}).*/\1…/'
```

If the host runs under systemd, `WorkingDirectory=` is what sets the project layer and `Environment=` lines are the inherited layer:

```sh
u=$(find ~/.config/systemd/user /etc/systemd/user -name "<unit>.service" | head -1)
grep -nE "Environment|WorkingDirectory|ExecStart|EnvironmentFile" "$u" | sed -E 's/(TOKEN|KEY|SECRET)=.*/\1=<masked>/'
```

## 5. Validate a candidate value before writing it

Replicate the provider's own validator in Node rather than inferring acceptance rules. SearXNG's is `URL.canParse` plus http/https scheme, no credentials, no query or hash:

```
""                       available() = false
"127.0.0.1:8080"         available() = false   # scheme required
"http://127.0.0.1:8080"  available() = true
```

A scheme-less value is the classic reason a fix appears to do nothing.

## 6. Check `.env` acceptance before creating a home-layer file

Creating `$DSH_HOME/.env` can make the host **refuse to boot**. Bootstrap-only names are rejected, and prefixes catch more than expected:

```sh
grep -n "BOOTSTRAP_NAMES = \|BOOTSTRAP_PREFIXES = " -A 8 packages/boot/app-boot/src/index.ts
```

`BOOTSTRAP_PREFIXES` includes `DSH_`, `XDG_`, `DYLD_`, `BASH_FUNC_`. Proxy names are allowed in the home layer only. Absent `.env` is fine (`ENOENT` is tolerated), so a new file adds a layer rather than replacing one. Keep it mode `600` and never print secret values.

## 7. Prove the fix end-to-end, then hand over the restart

The launch-environment snapshot is **frozen at boot**: no HMR, no patch reload picks up a new variable. Before claiming success, replay the provider's exact request path with the new value and one of the actually-failed queries:

```sh
node -e 'const fs=require("fs");
const v=Object.fromEntries(fs.readFileSync(process.env.HOME+"/.dsh/.env","utf8").split("\n")
  .filter(l=>/^[A-Za-z_]+=/.test(l)).map(l=>[l.slice(0,l.indexOf("=")),l.slice(l.indexOf("=")+1)]));
const ep=new URL(v.SEARXNG_BASE_URL); const bp=ep.pathname==="/"?"":ep.pathname.replace(/\/+$/u,"");
ep.pathname=`${bp}/search`; ep.searchParams.set("q","<failed query>"); ep.searchParams.set("format","json");
fetch(ep.href,{redirect:"error",headers:{accept:"application/json"}})
  .then(r=>r.json()).then(j=>console.log("results =",(j.results||[]).length));'
```

Restarting the host restarts the agent process serving the current conversation: the turn dies mid-flight, while the session log persists and stays resumable. Because that is a service-state mutation with visible blast radius, present the exact command and let the operator choose who runs it rather than firing it unilaterally.

## Reporting shape

Lead with backend-healthy-versus-wiring-broken, give the causal chain with file:line links, show the replicated validator output as proof, state the one-line fix plus the restart caveat, and keep secondary engine degradation clearly separated from the root cause.
