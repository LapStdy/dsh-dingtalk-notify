# DingTalk Notify · dsh-dingtalk-notify

[中文](README.md) | **English**

A [DSH](https://github.com/deepseek-ai) plugin: **ping your DingTalk group when the agent needs your input, or when a turn finishes**, plus a settings panel inside the DSH UI.

> DingTalk custom robots are one-way — they can only send. That is why the notification says "come back to the DSH page to act".

## Install

### Web (CLI / `dsh web`)

```powershell
dsh plugin --profile web add github:LapStdy/dsh-dingtalk-notify
```

Then **restart `dsh web`** (the panel roster is scanned at startup) and open **Settings → DingTalk Notify**.

### Desktop app (DeepSeek Harness)

The desktop app owns its profile exclusively, so **the CLI cannot install into it** (`dsh plugin --profile desktop ...` fails with `managed exclusively by the Electron application`). Install from inside the app:

1. Click **Plugins** in the sidebar
2. Click **Add plugin**
3. Paste `github:LapStdy/dsh-dingtalk-notify` (or the full URL `https://github.com/LapStdy/dsh-dingtalk-notify`) and install
4. **Restart the desktop app**, then open **Settings → DingTalk Notify**

> To hack on the code, `git clone https://github.com/LapStdy/dsh-dingtalk-notify.git` first, then `dsh plugin --profile web add "<the cloned directory>"`.
> The plugin is plain JS with no build step, so installing from GitHub needs **no** build authorization.

Config lives at `~/.dsh/dingtalk-notify/config.json`. **Saving from the panel or editing the file both take effect immediately — no restart.**

**Requirements**: DSH ≥ `0.1.5-rc.1`, Node ≥ 18.

## Tutorial: making messages actually reach your DingTalk group

Installing the plugin is only half of it — **whether a message gets through depends on how the robot is set up on the DingTalk side.** Five minutes, start to finish.

### Step 1 · Add a robot to a DingTalk group

1. Open DingTalk and go to the group you want notifications in (create one — a group with only you works fine)
2. **Group settings** (⋯) → **Robots** → **Add robot** → **Custom (via Webhook)**
3. Give it a name (e.g. "DSH Notify") and continue

### Step 2 · Pick a security setting (**this decides whether sending works at all**)

Choose one:

| Option | What to do | Watch out for |
|---|---|---|
| **Signed** (recommended) | Copy the `SEC...` secret | Paste it into DSH; re-copy if you rebuild the robot |
| **Custom keyword** | Enter a keyword, e.g. `DSH` | DingTalk only delivers messages whose **body contains that word**; this plugin's title always contains `DSH`, so `DSH` always matches |

Accept, finish, then **copy the Webhook URL** (`https://oapi.dingtalk.com/robot/send?access_token=...`).

> ⚠️ The Webhook URL and signing secret are posting credentials for that group. Do not share them, and never commit them to GitHub.

### Step 3 · Paste into DSH and verify

Open **Settings → DingTalk Notify**:

![Connection settings](docs/screenshots/panel-connection.png)

1. **Webhook URL**: paste the URL from step 2 (the stored one is shown masked; pasting a new value replaces it)
2. **Signing secret**: paste `SEC...` for signed mode, or leave empty for keyword mode
3. Click **Send test message** — it **ignores gating and always really sends**

If the group receives it, the chain works.

### Step 4 · What lands in the group

![Notifications in the DingTalk group](docs/screenshots/dingtalk-group.png)

### Step 5 · Nothing arrived? Check in this order

| Symptom | Meaning |
|---|---|
| Panel shows **send failed `310000`** | Keyword or signature mismatch — the most common trap. Switching to "custom keyword" with `DSH` is the easy fix |
| Panel shows **skipped** | Not a failure: someone was watching the DSH page / no phone online / inside the do-not-disturb window. **Send test message** bypasses gating to verify the chain on its own |
| Panel shows **no Webhook yet** | The URL did not save — redo step 3 |
| Nobody got @-mentioned | The robot only posts to the group; to @ someone, add their number under Advanced |
| Completion notices arrive but question notices do not | Something like `dsh-auto-review` may have answered the question directly; the diagnostics list has a record |

## What it sends

| When | What lands in DingTalk |
|---|---|
| The agent asks you to choose (including plan review) | 🔔 DSH needs your input |
| An action is blocked pending your approval | 🔐 DSH needs your approval |
| A turn ends | ✅ Done / ❌ Failed / ⏹ Aborted |

Every trigger can be turned off individually. Turns shorter than 5 seconds are skipped by default, to avoid spam.

The plugin only **observes** — it never answers for you: it calls the next handler immediately, so popups and auto-approval keep working. A failed send is only logged; it never breaks the agent.

![Triggers](docs/screenshots/panel-triggers.png)

## When it actually sends (gating)

Every open DSH page reports in once every 45 seconds, so the host keeps a table of online devices:

| Mode | Behaviour |
|---|---|
| `away` (default) | Stay quiet while someone is looking at the DSH page; send when they step away or only the phone is watching |
| `mobileOnly` | Send only while a phone is online, otherwise stay quiet |
| `always` | Always send |

A phone browser pauses its timers when locked, so heartbeats stop; the heartbeat TTL defaults to 5 minutes. If you want "notify me when I leave the desk", `away` is the more reliable choice.

![Gating](docs/screenshots/panel-gating.png)

## What the message looks like (detail level)

Pick one in the panel — the preview updates live:

| Brief | Detailed |
|---|---|
| ![](docs/screenshots/panel-content-brief.png) | ![](docs/screenshots/panel-content-detailed.png) |

**Brief** sends one line plus the session name; **detailed** adds the question body, options, tool name, duration and a reply summary.

## Configuration

`~/.dsh/dingtalk-notify/config.json` — a commented template is generated on first start:

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master switch |
| `webhook` | `""` | Robot Webhook URL (required) |
| `secret` | `""` | Signing secret `SEC...`; leave empty for "keyword" mode |
| `detailLevel` | `detailed` | `brief` (one line) / `detailed` (question body, options, tool name, duration) |
| `gating` | `away` | `away` / `mobileOnly` / `always` |
| `presenceTtlSeconds` | `300` | Heartbeat TTL (60–3600 s) |
| `notifyOnQuestion` | `true` | Notify when the agent asks you to choose |
| `notifyOnApproval` | `true` | Notify when an approval is pending |
| `notifyOnTurnEnd` | `true` | Notify when a turn completes |
| `notifyOnError` | `true` | Notify when a turn fails |
| `notifyOnAbort` | `false` | Notify when a turn is aborted |
| `minTurnSeconds` | `5` | Skip turns shorter than this; `0` = every turn |
| `includeSubagents` | `false` | Also notify for subagent turns |
| `atMobiles` | `[]` | Phone numbers to @ (the body gets an `@number` text, otherwise DingTalk will not really @ them) |
| `atAll` | `false` | @ everyone |
| `dndEnabled` | `false` | Do-not-disturb window switch |
| `dndFrom` / `dndTo` | `23:30` / `07:30` | Do-not-disturb window, may cross midnight |
| `dndExceptErrors` | `true` | Still notify on errors inside the window |
| `mergeWindowSeconds` | `3` | Merge same-kind alerts in one turn; `0` = off |
| `retryOnFail` | `true` | Retry once on failure; 60 s cooldown when rate-limited |
| `maxMessagesPerMinute` | `18` | Per-minute cap (DingTalk allows 20) |

Send log: `~/.dsh/dingtalk-notify/log.ndjson`, one JSON object per line (`sent` / `skip` / `error`). The **Diagnostics** section of the panel shows the last 20 decisions with skip reasons.

![Advanced](docs/screenshots/panel-advanced.png)

## Panel API (host side)

| Method | Path | Notes |
|---|---|---|
| GET | `/api/dsh-dingtalk-notify/config` | Masked config + current gating verdict |
| POST | `/api/dsh-dingtalk-notify/config` | Write config (`null` clears a key) |
| POST | `/api/dsh-dingtalk-notify/test` | Send one test message |
| POST | `/api/dsh-dingtalk-notify/presence` | Device heartbeat |
| GET | `/api/dsh-dingtalk-notify/status` | Online devices + send history |
| POST | `/api/dsh-dingtalk-notify/log` | `{action:"clear"}` clears in-memory history |

All routes except `presence` are **loopback-only**; `presence` writes the online table and never reads config. The signing secret is **never sent back to the browser** — only whether it is set.

## Self-test

```powershell
node bin/selftest.mjs         # config I/O, masking, gating, message assembly, client half — sends nothing
node bin/smoke-test.mjs --dry # load the plugin against a stub context, check listeners and panel routes
node bin/dingtalk-test.mjs    # really send one test message to your group
```

## Uninstall / mute

```powershell
dsh plugin --profile web remove dsh-dingtalk-notify
```

To mute temporarily: turn off the master switch in the panel, or set `enabled` to `false` in `config.json`.

Any change under `lib/` (host half `index.js`, client half `client.js`) needs a **`dsh web` restart** — a running process does not reload plugin source.

## Troubleshooting

| Symptom | Cause |
|---|---|
| No "DingTalk Notify" in Settings | `dsh web` was not restarted; the panel roster is scanned at startup |
| Nothing arrived, panel says "skipped" | Read the skip reason: someone is looking at the page / no phone online / do-not-disturb / no Webhook |
| Panel says "send failed" | Error codes are translated into plain language; `310000` = keyword or signature mismatch |
| Only completion notices, no question notices | The question may have been answered directly by something like `dsh-auto-review`; the diagnostics list has a record |

## Changelog

See [CHANGELOG.md](CHANGELOG.md).

## License

MIT
