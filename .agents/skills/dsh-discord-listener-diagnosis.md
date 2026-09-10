---
name: "dsh-discord-listener-diagnosis"
description: "Diagnose why an inbound Discord message produced no reply in a running DSH host: locate the channel's durable Session log, decide whether the gateway admitted the message or never received it, and prove which leg (inbound, outbound, config gate) is broken without host process or log access."
whenToUse: "Use when someone says a Discord DM or channel post to a DSH bot got no answer, or asks how the Discord conversation loop works, in this repo's `beardy` profile deployment (or any composition mounting `@deepseek-ai/dsh-discord-gateway`)."
---

# Discord listener diagnosis

Determine which leg of the inbound path is broken: admission (allowlist/gating), delivery to a Session, the turn itself, or outbound posting.

## Wiring (this deployment)

- Listener package: `packages/discord/discord-gateway` (`index.ts` holds `DEFAULT_*` bounds and `apply`; `conversation.ts` owns open/resume/debounce/delivery; `gateway.ts` owns the websocket).
- Profile config: `~/.dsh/profiles/beardy/cordis.patch.yml` rows `tool-discord`, `discord-gateway`, `cron`. Bundle gate for all three: `disabled: !!js process.env.DISCORD_BOT_TOKEN === undefined`.
- Runtime facts: DM from `allowedUserIds` always admitted; guild channels need `allowedChannelIds` plus a mention (`guildRequireMention` default true); turn timeout 600 s posts **nothing** and sends no failure notice; idle release 15 min; conversation expiry 24 h.

## Evidence ladder

1. **Find the conversation log.** DM/guild conversations get a Session id `discord-<channelId>-<uuid>` under `~/.dsh/sessions/<cwd-slug>/`. Read it with `unzstd -c session.v2.jsonl.zstd` (the sibling `session.jsonl.zstd` is the previous generation; read v2). Inbound posts appear as `"type":"user/message"` carrying `"source":{"kind":"discord",...}`. Convert event epochs: `date -d @$((ms/1000))`.
2. **Split the failure.** No new `user/message` event and no new `discord-*` directory ⇒ the listener never admitted the message; look at config/connect, not the agent. A `user/message` plus `turn/end` but no reply in Discord ⇒ posting failed or the turn exceeded the timeout.
3. **Prove the row mounted.** The bash tool cannot read the host env: it runs under bubblewrap (`--unshare-pid --tmpfs /tmp`) and secret-looking variables (`DISCORD_BOT_TOKEN`, `DEEPSEEK_API_KEY`) read as UNSET even when set in the host, and host `/tmp` and process tables are invisible. Use `cron_manage` action `list` instead: cron shares the same token gate, so a mounted cron means the token was defined at composition load and the gateway row was enabled too.
4. **Check for a live websocket (corroborating only).** `getent hosts gateway.discord.gg`, then grep `/proc/net/tcp` for remote port `01BB` with the little-endian hex of those IPs (`162.159.133.234` → `EA859FA2`). A Discord desktop client on the same machine produces identical rows, so never conclude from this alone.
5. **Probe outbound.** Send one short `discord_send` message. Success proves token resolution and the destination channel; it says nothing about inbound. Ask for a reply to test inbound in the same breath.
6. **Ask for the host log lines.** The gateway logs once per state change to stdout, which only the terminal running the host can show: `discord-gateway: connected; …`, `… ; reconnecting`, `mounted but disabled by configuration`, and `listener stopped and will not retry` (fatal — dead for the whole process lifetime with no other symptoms).

## Causes worth ranking explicitly

- **Fatal at apply**: credential resolve, `agentPresets.resolve`, `permissionPresets.resolve`, or `storageDomain.open` throwing → logged once, listener never dials.
- **Two hosts on one bot token**: a stale `dsh` process splits or eats Discord identifies (documented limitation). Check for processes started earlier that day by their session-directory mtimes.
- **Wrong surface**: no `allowedChannelIds` set means guild channels and group DMs are never read; guild message bodies additionally need Message Content intent enabled in the developer portal.
- **Silent turn timeout**: an unsettled turn posts nothing at all, so a slow model reads as an unresponsive bot.

## Answer shape

State which leg is broken, the file or command that proves it, and the one action that fixes it. Separate what was measured from what is inferred; the host terminal log is usually the only decisive evidence for connect state.
