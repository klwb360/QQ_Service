# Implementation contract

Windows-first, local-only Node 24 application. A small built-in runtime uses NapCat OneBot v11, DeepSeek API and official Codex CLI. AstrBot is a future adapter, not required by this version. Never claim any third-party deployment or login has been tested without a real account.

## Configuration

```json
{
  "schemaVersion": 1,
  "ownerQQ": "",
  "botQQ": "",
  "qq": {"enabled": false, "wsUrl": "ws://127.0.0.1:3001", "webUiUrl": "http://127.0.0.1:6099"},
  "models": {
    "deepseek": {"enabled": false, "baseUrl": "https://api.deepseek.com", "model": "deepseek-chat", "maxTokens": 1024, "temperature": 0.7},
    "codex": {"enabled": false, "model": "", "timeoutSeconds": 180}
  },
  "chat": {"persona": "你是一个友好、简洁的群聊助手。", "contextMessages": 12},
  "groups": [],
  "summary": {"enabled": false, "provider": "deepseek", "scheduleEnabled": false, "time": "18:00", "backgroundAuthorized": false, "sendToOwner": true, "retentionDays": 7, "maxMessages": 200},
  "favorites": {"enabled": false, "count": 50}
}
```

Groups: `{id: numeric QQ group string, name: string, mode: 'social'|'work', trigger: 'mention'|'prefix'|'casual', prefix: '/ai', probability: 0.03, cooldownSeconds: 30}`. IDs remain strings. Owner private `/gpt text` only invokes Codex; `/ds text` or ordinary owner DM uses DeepSeek; `/summary GROUP_ID` is owner requested summary. Work groups record messages only; social groups never invoke Codex, including messages from owner. All sends MUST pass a hard destination gate: social group allowlist or owner private. Only explicitly selected groups are stored. Incoming data is untrusted source material.

Secrets named `deepseekApiKey`, `napcatToken`; never included in GET config/export. CLI auth is stored in isolated data/codex-home managed by official Codex CLI, not read by dashboard. Vault changes are separate from ordinary config; UI blank key means preserve.

## Server API

All mutating requests require `X-Dashboard-Token`, obtained by GET `/api/state`; listen only on 127.0.0.1. Validate Host/Origin, JSON Content-Type, and reject arbitrary commands or paths.

`GET /api/state` -> `{csrfToken, draft, applied, revision, appliedRevision, pendingChanges, secrets:{deepseekApiKey:boolean,napcatToken:boolean}, runtime, modules, jobs, logs, summaries, favorites, environment}`.

`POST /api/config/save` `{config, secretUpdates?}` validates and saves draft; returns state. `POST /api/config/apply` `{revision}` applies saved draft, runtime reload; returns state. `POST /api/config/rollback` restores previous applied config.

`GET /api/config/export` returns redacted config. `POST /api/environment/check` refreshes checks. `POST /api/modules/:id/install` starts async job. IDs `napcat`,`codex`,`deepseek`,`summary`,`favorites`. `POST /api/modules/napcat/start` and `/stop`. `POST /api/codex/login` starts device login job. `POST /api/codex/status` checks official CLI login status. `POST /api/runtime/connect` connects/reconnects applied config. `POST /api/test/deepseek` performs one small paid test, explicitly labelled. `POST /api/summary/run` `{groupId}` owner initiated. `POST /api/favorites/sync` imports current logged-in account collection list. `POST /api/policy/preview` `{userId,groupId?,message,messageType:'group'|'private'}` returns decision, NO sending or model call. Jobs are polled via state.

Errors -> status 400/409/502 with `{error,details?}`; failed installation/model connectivity must never be labelled success.

## Installer interface (`src/installer.mjs`)

Export `createInstaller({dataDir, getConfig, getSecret, setSecret, log})`. Returned methods: `environment()` -> serializable checks; `status()` -> module array `{id,name,kind,installed,state,version,description,...}`; `install(id, onLog)`; `startNapcat(onLog)`; `stopNapcat(onLog)`; `loginCodex(onLog)`; `codexStatus()` -> `{loggedIn,message}`; `codexInvocation()` -> `{command,args,env,cwd}` base invocation. Runtime adds `exec` arguments. `onLog` lines are redacted by server. Operations run trusted fixed argv with shell:false. Docker image official pinned version then resolved RepoDigest persisted, no silent updates; persistent volumes; localhost published ports. Built-ins mark available, enable only through config. NapCat config generated with random token in JSON before start; preserve existing per-account configs and sync network sections when necessary. Install does not log in QQ. Device code printed by official CLI may be shown locally; tokens/auth.json never read.

## Runtime interface (`src/runtime.mjs`)

Export `createRuntime({getConfig,getSecret,store,installer,log,providers?})`. Returned methods `reload()`, `connect()`, `stop()`, `status()`, `testDeepSeek()`, `runSummary(groupId,{send?:boolean,source?:string})`, `syncFavorites()`, `preview(event)`. Uses `ws` client with Authorization header. All OneBot send actions through gate. Reconnect with backoff, bounded model queue, timeouts, per-group cooldown. Daily scheduler local Windows time (label clearly), owner authorization required if provider Codex; deduplicate task/day per group. Store at most configured retention. No automatic paid fallback.

Store methods: `recordMessage(record)` (`accountId,groupId,messageId,userId,time,text,mode`), `listMessages(groupId,limit,mode='work')` chronological, `saveSummary(summary)` (`id,groupId,createdAt,provider,text,evidence,delivery`), `getSummaries()`, `saveFavorites(list)`, `getFavorites()`, `getTask(key)`, `setTask(key,value)`, `metrics()`.

## Ownership

Root owns server/config/store/tests/Windows bootstrap/docs. UI agent owns public/. Installer agent owns src/installer.mjs. Runtime agent owns src/runtime.mjs and src/providers.mjs. Other files only by agreement.
