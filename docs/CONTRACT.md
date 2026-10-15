# Implementation contract

Windows-first, local-only Node 24 application, version 0.3.0. One Electron window and one management server host multiple concurrent account profiles. QQ uses NapCat OneBot v11; models use DeepSeek API and official Codex CLI. WeChat and Telegram are planned registry entries, not implemented adapters. See [account-control design](ACCOUNTS_CONTRACT.md) and [architecture](ARCHITECTURE.md).

Never report a real login, deployment or Windows interaction as tested without performing it.

## Per-account configuration

```json
{
  "schemaVersion": 2,
  "ownerQQ": "",
  "botQQ": "",
  "permissions": {"released": false, "privateReplies": false},
  "qq": {"enabled": false, "wsUrl": "ws://127.0.0.1:3001", "webUiUrl": "http://127.0.0.1:6099"},
  "models": {
    "deepseek": {"enabled": false, "baseUrl": "https://api.deepseek.com", "model": "deepseek-chat", "maxTokens": 1024, "temperature": 0.7},
    "codex": {"enabled": false, "model": "", "timeoutSeconds": 180}
  },
  "chat": {"enabled": false, "provider": "deepseek", "persona": "你是一个友好、简洁的群聊助手。", "contextMessages": 12},
  "groups": [],
  "summary": {"enabled": false, "provider": "deepseek", "scheduleEnabled": false, "time": "18:00", "backgroundAuthorized": false, "sendToOwner": false, "retentionDays": 7, "maxMessages": 200},
  "favorites": {"enabled": false, "provider": "deepseek", "count": 50}
}
```

`botQQ` is the expected logged-in QQ identity. `ownerQQ` is an optional personal command/summary recipient, configured under permissions. Entering a QQ number is not authentication. A connection needs an expected identity and OneBot Token; it does not require a second QQ identity. Private delivery needs a configured recipient distinct from the connected account.

Group shape:

```text
{id: numeric-string, name: string, mode: 'social'|'work',
 read: true, send: false, trigger: 'mention'|'prefix'|'casual',
 prefix: '/ai', probability: 0.03, cooldownSeconds: 30}
```

IDs remain strings. New accounts, model login and credential setup never grant send permissions. New groups default to readable and not writable; unselected/unreadable group messages must not be stored or submitted to models. `mode` labels the workflow: work groups default to `send:false`, but an explicit user grant plus account release may enable their DeepSeek conversation. Sending requires `read:true`.

All output, including errors and summary fragments, MUST pass the final destination gate: current account/epoch, verified connection identity, `permissions.released`, enabled scenario, and matching target permission. A group additionally needs `read && send`, enabled DeepSeek and the DeepSeek conversation route. Private sends need `privateReplies` and exactly `ownerQQ`. Work-summary source permissions must still be valid at delivery time.

Personal `/gpt` invokes Codex; `/ds` invokes DeepSeek; `/summary GROUP_ID` uses the notification model; `/favorites` uses `favorites.provider`. Ordinary personal text uses `chat.provider` (DeepSeek or Codex); enabling chat requires the selected provider, not an additional DeepSeek connection. Choosing Codex as default disables automatic group conversation. Commands require their enabled scenario and released private permissions. Codex subscription is for owner-initiated/authorized personal tasks, never public automatic group conversation. Incoming sources remain untrusted data, not instructions.

Explicit dashboard notification/favorite operations and connectivity tests can run locally before release. Automatic conversation and scheduled inference require `permissions.released`; enabling model or task configuration alone cannot start automatic model work. A released readable/non-writable group can run scheduled local summaries with zero sends. Summary private delivery is opt-in; dashboard favorite explanations default to local storage. Favorites use an independent provider and do not inherit summary delivery settings. Reading favorites alone does not require a model connection; explaining them does.

## Profile directory, credentials and migration

Root `accounts.json` stores server-generated stable profile IDs, labels, platform and creation time. New profiles use `accounts/<ID>/`, each with independent configuration, vault/key, SQLite, module records, NapCat state, Codex home and workspace. Container identity and local endpoints must not collide across active profiles.

The legacy profile retains the original root data directory, login state and managed-container identity. `migrateConfig` explicitly maps schema 1 to 2 for draft/applied/previous documents, preserves revisions, and is idempotent. Existing social sends and personal private access are mapped without broadening; work groups remain unsent unless the user later explicitly grants permission. The original configuration is backed up as `config.v1.backup.json`.

Secrets are `deepseekApiKey` and `napcatToken`, never returned in configuration or exports. Empty key fields preserve existing values. Updates are staged until apply. Official Codex CLI manages per-profile authentication; the dashboard does not read `auth.json`. Logs must redact credentials across all profiles and include their profile ID.

## HTTP API

Listen only on `127.0.0.1`. All mutations require `X-Dashboard-Token`. Validate Host/Origin, JSON Content-Type and body size. Reject arbitrary shell commands, download origins and filesystem paths.

```text
GET  /api/accounts -> {csrfToken, accounts, platforms}
POST /api/accounts {name, platform:'qq', qqNumber?} -> {account, state}
GET  /api/accounts/:id/state
GET  /api/accounts/:id/qq/groups
GET  /api/accounts/:id/config/export
GET  /api/accounts/:id/napcat/guide
POST /api/accounts/:id/config/save {config, secretUpdates?}
POST /api/accounts/:id/config/apply {revision}
POST /api/accounts/:id/config/rollback
POST /api/accounts/:id/permissions/release {revision}
POST /api/accounts/:id/permissions/revoke
POST /api/accounts/:id/environment/check
POST /api/accounts/:id/setup/install {modules}
POST /api/accounts/:id/modules/:module/install
POST /api/accounts/:id/modules/napcat/start
POST /api/accounts/:id/modules/napcat/stop
POST /api/accounts/:id/codex/login
POST /api/accounts/:id/codex/status
POST /api/accounts/:id/runtime/connect
POST /api/accounts/:id/test/deepseek
POST /api/accounts/:id/summary/run {groupId}
POST /api/accounts/:id/favorites/sync
POST /api/accounts/:id/favorites/summarize
POST /api/accounts/:id/policy/preview {userId,groupId?,message,messageType:'group'|'private'}
```

Account list entries: `{id,name,platform,qqNumber,runtime,permissions,pendingChanges}`. Account state: `{account,csrfToken,draft,applied,revision,appliedRevision,pendingChanges,secrets:{deepseekApiKey:boolean,napcatToken:boolean},codexAuth,runtime,modules,jobs,logs,summaries,favorites,environment,metrics}`. Additional diagnostic metadata may be included; secrets are booleans only.

Group discovery requires a verified connected QQ identity. It returns joined group IDs/names; it does not auto-select groups or grant permissions. Policy preview never sends or invokes a model. DeepSeek connectivity testing is a real, potentially billed request and must be labelled accordingly.

Saving a draft cannot grant `released:true`. Ordinary apply and rollback always restore read-only state. Only `/permissions/release` validates the saved current revision and explicitly applies the requested targets with sending enabled. Revoke immediately blocks sends and cancels old work for that account. Revisions prevent applying stale forms.

Every task captures a profile ID; UI selection never reassigns a running operation. Legacy unscoped endpoints are compatible only when exactly one profile exists; multiple profiles require explicit IDs. Errors use 400/403/404/409/502 as appropriate and `{error,details?}`. Failed installation or model connectivity cannot be labelled successful.

## Installer interface

`createInstaller({dataDir,profileId,legacy,getConfig,getSecret,setSecret,log})` returns `environment`, `status`, `install`, `startNapcat`, `stopNapcat`, `loginCodex`, `codexStatus`, `codexInvocation`, `napcatGuide` and `dispose`.

Operations use trusted fixed argv and `shell:false`. Docker uses a local daemon, pinned official image and persisted RepoDigest, per-profile managed container labels, independent persistent volumes and loopback ports. Never take over a non-project container. Native Windows NapCat is installed and run externally; OneBot runtime access does not require Docker. Docker install/start/stop buttons do not manage native instances.

Codex is an official pinned npm package installed in project data, with independent per-profile `CODEX_HOME`/workspace. Authentication is a separate device-code task. Official auth output may be shown locally, but credentials cannot appear in ordinary status, exports or logs. Install, process state, QQ login, model authorization and permission state remain distinct.

## Runtime and store interfaces

`createRuntime({getConfig,getSecret,store,installer,log,providers?})` returns `reload`, `connect`, `stop`, `status`, `testDeepSeek`, `listGroups`, `runSummary`, `runFavoritesSummary`, `syncFavorites` and `preview`. Each profile has its own runtime, socket, epoch, cancellation, bounded queue and cooldowns. Reconnect uses backoff. Scheduler follows host-local time, with per-account/group/day deduplication, explicit background authorization and release checks before scheduling, queueing and inference. No silent paid fallback.

`createStore(dataDir)` provides draft/application/rollback state, staged encrypted secrets, message/evidence history, summaries, favorites, task deduplication and metrics. Each profile's database and retention are independent. Source records preserve QQ identity, group, message/CID, sender, time and original text. No cross-profile context or favorite reuse.

Desktop native export accepts an optional profile ID and uses the corresponding fixed redacted endpoint. Application exit or parent IPC loss must close all profile runtimes and owned installer subprocesses. Never kill unrelated processes.
