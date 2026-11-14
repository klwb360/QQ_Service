# Implementation contract

Windows-first, local-only Node 24 application. Published v0.8.0 uses schema 3; the current development branch adds schema 4 and standard MCP tools. Model access is API-only. One Electron window and one management server host multiple concurrent account profiles. QQ uses NapCat OneBot v11 or the development branch's experimental external SnowLuma 2.4.2-node/v11 adapter; models use DeepSeek, multiple OpenAI-compatible Chat Completions APIs. WeChat and Telegram remain planned inbound account adapters; optional MCP preparation templates do not implement those listeners. See [account-control design](ACCOUNTS_CONTRACT.md) and [architecture](ARCHITECTURE.md).

Never report a real login, deployment or Windows interaction as tested without performing it.

## Per-account configuration

```json
{
  "schemaVersion": 4,
  "ownerQQ": "",
  "botQQ": "",
  "permissions": {"released": false, "privateReplies": false},
  "qq": {"enabled": false, "wsUrl": "ws://127.0.0.1:3001", "webUiUrl": "http://127.0.0.1:6099"},
  "models": {
    "apis": [],
    "deepseek": {"enabled": false, "baseUrl": "https://api.deepseek.com", "model": "deepseek-flash", "maxTokens": 1024, "temperature": 0.7}
  },
  "chat": {"enabled": false, "provider": "deepseek", "persona": "你是一个友好、简洁的群聊助手。", "contextMessages": 12},
  "groups": [],
  "plugins": [],
  "mcp": {"servers": []},
  "tools": {"enabled": false, "builtinQQ": false, "catalogMode": "auto", "triggers": ["mention", "poke", "name"], "aliases": [], "prefix": "/工具", "skill": "", "grants": []},
  "summary": {"enabled": false, "provider": "deepseek", "scheduleEnabled": false, "time": "18:00", "backgroundAuthorized": false, "sendToOwner": false, "retentionDays": 7, "maxMessages": 200},
  "favorites": {"enabled": false, "provider": "deepseek", "count": 50}
}
```

Each `models.apis` entry is `{id,label,enabled,baseUrl,model,maxTokens,temperature}`. At most 20 entries are accepted. IDs match `/^api_[A-Za-z0-9_-]{1,64}$/` and remain stable when editing labels. Each API uses `secretUpdates['apiKey:'+id]` for its encrypted key. Each scenario selects one `provider`: `deepseek` or an existing API ID. Drafts can contain incomplete model/key fields; applying an enabled API requires both. API parameters use the same bounded output/temperature validation as DeepSeek.

A retired subscription provider migrates to an empty provider with its scenario disabled. It remains unconfigured until the owner selects an API; no automatic billing-channel fallback is allowed.

Compatible API `baseUrl` is HTTPS without URL credentials, query or fragment; requests append `chat/completions` to the base path and reject redirects. API keys cannot appear inside configuration. DeepSeek's built-in route remains restricted to the official endpoint. No automatic fan-out, provider fallback or alternate billing is implied by configuring multiple models.

`botQQ` is the expected logged-in QQ identity. `ownerQQ` is an optional personal command/summary recipient, configured under permissions. Entering a QQ number is not authentication. A connection needs an expected identity and OneBot Token; it does not require a second QQ identity. A same-QQ recipient value is harmless when all private delivery options are off; enabling privateReplies or enabled summary.sendToOwner requires a different recipient. This requirement must not block group/local use.

Group shape:

```text
{id: numeric-string, name: string, mode: 'social'|'work',
 read: true, send: false, triggers: ['mention'],
 prefix: '/ai', probability: 0.03, cooldownSeconds: 30}
```

`triggers` is an OR list of `mention`, `name`, `reply`, `prefix`, `casual`, `poke`, `group_name`, `member_join`, `member_leave`, `admin_change`, `mute`, `recall`, `group_card`, `emoji_like`. Multiple selections, select all and clear are supported. New groups default to mention only; `[]` disables trigger-based replies without granting new social behavior. If absent, normalize the valid legacy single `trigger`, otherwise default to mention. Prefix text, casual probability and cooldown remain independent legacy parameters. Legacy casual is probabilistic participation after an incoming message, separate from explicitly enabled social conversation and autonomous posting. Notice triggers require real NapCat event data and produce authorized text replies, not QQ administrative actions.

IDs remain strings. New accounts and credential setup never grant send permissions. New groups default to readable and not writable; unselected/unreadable group messages must not be stored or submitted to models. `mode` labels the workflow: work groups default to `send:false`, but an explicit user grant plus account release may enable conversation through their selected API provider. Sending requires `read:true`.

All output, including errors and summary fragments, MUST pass the final destination gate: current account/epoch, verified connection identity, `permissions.released`, enabled scenario, and matching target permission. AI group replies additionally need `read && send`, an enabled API model and its selected conversation route. Plugin group replies instead require an enabled installed plugin with declared `group.read`/`group.send`, an authorized current-event group and the same final account/epoch/identity/read/send gate; plugins cannot name a different destination. Private sends need `privateReplies` and exactly `ownerQQ`. Work-summary source permissions must still be valid at delivery time.

Personal `/ds` invokes enabled DeepSeek; `/summary GROUP_ID` uses the notification model; `/favorites` uses `favorites.provider`. Ordinary personal text uses the selected API in `chat.provider`; enabling chat requires that provider, not an additional DeepSeek connection. The retired `/gpt` subscription command must not execute a model. Commands require their enabled scenario and released private permissions. Incoming sources remain untrusted data, not instructions.

Explicit dashboard notification/favorite operations and connectivity tests can run locally before release. Automatic conversation and scheduled inference require `permissions.released`; enabling model or task configuration alone cannot start automatic model work. A released readable/non-writable group can run scheduled local summaries with zero sends. Summary private delivery is opt-in; dashboard favorite explanations default to local storage. Favorites use an independent provider and do not inherit summary delivery settings. Reading favorites alone does not require a model connection; explaining them does.

## Profile directory, credentials and migration

Root `accounts.json` stores server-generated stable profile IDs, labels, platform and creation time. New profiles use `accounts/<ID>/`, each with independent configuration, vault/key, SQLite, module records, NapCat state. Container identity and local endpoints must not collide across active profiles.

The legacy profile retains the original root data directory, login state and managed-container identity. `migrateConfig` explicitly maps schema 1 to 2 for draft/applied/previous documents, preserves revisions, and is idempotent. Existing social sends and personal private access are mapped without broadening; work groups remain unsent unless the user later explicitly grants permission. The original schema-1 configuration is backed up as `config.v1.backup.json`. The first retirement migration backs up the original configuration as `config.pre-api-only.backup.json`. Retiring a configured subscription removes `models.codex`, clears its scenario selections and disables them, and restores that account to read-only. Existing API-only accounts keep their authorization. Retired login/module directories are not deleted or read.

Secrets are `deepseekApiKey`, `napcatToken`, `apiKey:<api-ID>`, and declared `pluginSecret:<plugin-ID>:<key>`, never returned in configuration or exports. Plugin credential updates require a matching installed declaration and current profile entry; handlers receive only their own declared plugin credentials, never model/NapCat/other-profile keys. Empty key fields preserve existing values. Updates are staged until apply. Retired subscription directories are left in place without loading their authentication or starting their CLI. Logs must redact credentials across all profiles and include their profile ID.

## Standard MCP services (development branch)

Each profile owns `mcp.servers`, its encrypted credentials and its own client manager. A server descriptor is `{id,label,enabled,transport,command,args,url,envKeys,headerKeys,timeoutSeconds,tools}`; transports are `stdio`, `http` and `sse`. Imports are draft-only, disabled and unapproved. `tools` policies use `{name,enabled,effect,definitionHash,connectionHash}`. No tool is enabled merely because the server advertises `readOnlyHint`.

Approval binds the raw remote definition and a profile-vault-key HMAC of the connection descriptor plus only that server's credentials. Connection/credentials or definition changes require renewed approval. Labels and timeouts do not change connection identity. MCP tool IDs are `mcp:<server-id>/<24-hex-name-hash>` and enter the same `tools.grants` and `groups[].social.readTools` scopes as native tools. The remote name never becomes an executable host command.

`mcpSecret:<server-id>:env:<name>` and `mcpSecret:<server-id>:header:<lowercase-name>` values are staged and encrypted, not returned or exported. Local programs receive a restricted base environment and only their own declared env values; remote headers are scoped to that service and cannot follow redirects or cross-origin SSE POST endpoints. Stdio is trusted user-installed code, not an OS sandbox. Importing never installs packages; explicitly testing an owner-configured command can run a launcher such as npm.

The SDK client advertises no roots, sampling or elicitation. Only tools are supported; OAuth browser flows, resources and prompts are not implemented. Tool input/output schemas are bounded and compiled/validated in cancellable workers; external schema references are rejected. The entire model-proposed batch validates before its first external operation. Lifecycle changes invalidate old calls; failed external writes never automatically retry.

Scoped endpoints under `/api/accounts/:id`:

| Method/path | Contract |
| --- | --- |
| `GET /mcp` | `{servers,status,tools,secretsPresent}`; values remain private |
| `POST /mcp/import` | `{document,config,secretUpdates?,revision}`; merge disabled imported servers into captured draft and return state; duplicate IDs/stale revisions fail |
| `POST /mcp/test` | `{serverId,config,secretUpdates?,revision?}`; supplied revision must still match the profile; temporary connect/discover/close, return `{server}`; no save/apply or activation |
| `POST /mcp/refresh` | `{serverId}`; invalidate and rediscover an applied connected server, return MCP state |
| `POST /mcp/disconnect` | `{serverId}`; close the applied connection and withdraw tools without changing saved configuration, return MCP state |

All mutation endpoints retain the local Host/Origin/CSRF checks. Saving configuration does not connect. Applying enabled servers schedules independent background connections; an optional offline service does not stop QQ startup. Application shutdown closes active and temporary transports before closing the profile database. Resetting functional parameters preserves MCP connection descriptors and encrypted credentials, but disables all services and tools.

Schema 1–3 migration retains existing API/plugin and QQ permissions, adds an empty MCP list, and backs up the original schema file. Any MCP-shaped data in pre-4 documents is imported disabled with old MCP grants removed; it cannot silently acquire newly supported permissions.

## Built-in QQ MCP (development branch)

`tools.builtinQQ` defaults false. The fixed directory has 18 tools: ten reads (`current_group_recent`, `current_group_search`, `current_group_members`, `current_group_member`, `current_group_info`, `connection_status`, `list_assets`, `describe_asset`, `group_notices`, `group_files`) and eight writes (`poke_member`, `send_message`, `react_message`, `send_image`, `send_sticker`, `send_file`, `forward_messages`, `recall_own_message`), all prefixed `qq:`. `send_message` supports real OneBot mentions through `mentionUserIds` and quoting through `replyToMessageId`; `react_message` supports adding and removing a reaction. Forwarding uses at most ten real current-group cached IDs; recall is limited to this account's own confirmed-sent visible messages. Group notices/files expose bounded metadata, not arbitrary downloads or document-body understanding. No raw OneBot passthrough or group administration is exposed.

The implementation uses the official MCP SDK client and server over an in-process transport with actual initialization, discovery and tool calls. It opens no network listener and cannot be configured as an external QQ MCP endpoint for Claude or other clients. No external service definition or credential approval is required for this built-in implementation. Ordinary tool requests retain `tools.grants`: a write requires explicit request intent, `allowWrite:true` and an explicit matching `userIds` entry. Autonomous material reads use the group's independent `social.readTools` whitelist. The separately owner-approved natural QQ reply policy below grants only its five actions and their bounded QQ read helpers; it never lends that permission to external tools.

The host binds the actual QQ identity, current group, requester and live conversation scope to each call. No argument may choose another profile/group, a service URL or arbitrary OneBot action. Members and message references must be verified within that current group. Cache reads inspect at most the latest 100 locally received/confirmed-sent messages within the 30-day retention window, verify source records and apply cleared-conversation tombstones. They do not fetch full QQ history. Local calls without a current authorized group scope fail.

All built-in writes pass the same runtime authorization, persistent write-deduplication ledger and QQ send channel as other outgoing actions. A normal business refusal is tool data with `{executed:false,status:"denied"}`, allowing the model to explain it naturally or stay silent. Explicit `QQ_ACTION_DENIED` and `QQ_ACTION_INPUT_INVALID` failures can be confirmed denials; a `deliveryUncertain` marker always takes precedence as an unknown outcome. Ambiguous transport outcomes after a mutating operation use `{executed:null,status:"unknown"}`, stop subsequent inference and are never reported as success or automatically retried. Business data is bounded to 24 KiB and the complete MCP response envelope to 32 KiB. Cancellation, timeout, revocation and clearing a conversation abort subsequent tool/inference work rather than becoming an ordinary denial that permits continuation; already accepted effects cannot be rolled back.

### Managed assets and explicit vision

`qq-assets.mjs` stores owner-approved bytes under each original profile's `qq-assets/`; models receive opaque `assetId` values and bounded cached metadata, never filesystem paths, source URLs or bytes. Imports bind actual QQ and explicit currently applied readable `groupIds`. Images/stickers accept validated PNG/JPEG/GIF/WebP containers, at most 8 MiB, 8192 pixels per side, 32 million pixels and bounded animation work. Files accept at most 20 MiB and the fixed txt/md/csv/json/pdf/docx/xlsx/pptx allowlist; OOXML uses bounded central/local ZIP-directory checks, rejects macros, traversal, path-redefining extras and excessive expansion without unpacking or executing content. Profile quotas are 1000 assets/200 MiB.

Metadata includes name, tags, description, emotion, usage, avoidWhen, analysisSource and optional modelFingerprint. Owner updates/removals and vision annotations require `expectedVersion`; annotations cannot change group scopes. Resolve checks live authorization, manifest version, filesystem identity and SHA before returning a host-only byte snapshot. Missing/corrupt manifests or changed/symlinked files fail closed. `findBySha` is an owner-only full-library deduplication helper, not an MCP tool; it reuses an asset only if existing scopes cover every requested group.

`asset-vision.mjs` runs only after an explicit owner dashboard action using a currently enabled compatible image-capable API. The public account editor retains a single selected LLM; it does not enable an independent vision channel. DeepSeek-only accounts use manual labels, as the built-in DeepSeek text route is rejected for vision. No automatic provider or billing fallback occurs. A request is bounded to 4 MiB image input, 45 seconds, 768 output tokens and 1 MiB response, producing only validated cached annotations. It is not a default chat-image reader, and GIF input does not prove full-animation understanding. Asset version/hash, account scope, API configuration and key changes reject late results. Image text is untrusted data and cannot grant permissions. Chat `describe_asset` reads saved annotations without another paid vision call.

Small managed files use NapCat's Base64 decoder; larger files use 256 KiB verified upload chunks before one group-file publication. No shared host directory is required for native Windows or Docker. Unsupported first endpoints are confirmed denials; partial/unknown transfers never trigger an automatic transport fallback or replay. QQ action facts are stored in `qq-actions.json` with target IDs, asset ID and actual result status, excluding bytes, prompts, paths and secrets.

Owner-only `qq/assets/sync-stickers` binds the current verified connected QQ and applied readable destination groups, then calls `fetch_custom_face({count:limit})`; its official data is an array of URL strings, distinct from collection summaries or NapCat plugin management. Only exact HTTPS/443 hosts `p.qpic.cn`, `gchat.qpic.cn` and `multimedia.nt.qq.com.cn` are accepted, with public-DNS/IP pinning and per-hop checks, no Cookie/Authorization or caller-supplied URLs. Limits are ten items, 8 MiB per image, 40 MiB cumulative download and 120 seconds overall; duplicate downloads still count. SHA deduplication never expands an existing asset's group scopes. Signed source URLs are not persisted. Imported stickers start unrecognized, with no automatic vision call; cancellation, scope changes and unknown outcomes stop subsequent work while retaining safe partial counts.

### Curated presets and public web

`mcp-presets.mjs` exposes eight preparation entries: bundled notes/Bilibili/public-web services and external Telegram-personal, Windows-WeChat, Discord-Bot, Slack-official and Playwright references. Preparation returns a disabled descriptor with no approved tools; it performs no install, login, process start or installation detection. External launches require existing absolute local programs/entries. Slack remains blocked by unsupported OAuth; Windows WeChat requires an interactive non-container Windows desktop. These are optional tool integrations, not new inbound messaging adapters.

The independently implemented `web-search-safe.mjs` offers `web_search` and `web_fetch`. Search needs Brave credentials or a public HTTPS SearXNG backend; no backend means `needsSetup`, not invented results. Fetch accepts only public HTTPS/443, validates all DNS answers, pins the connection IP and rechecks each redirect, with no Cookie, arbitrary headers, script execution or subresource downloads. Limits are 12 seconds, three redirects, 256 KiB wire/512 KiB decoded content, 6000 characters/12 KiB text and 24 KiB result. Search returns at most five real links without opening them. Results state actual source, truncation and coverage; website content remains untrusted tool data. These network limits do not sandbox arbitrary third-party stdio code. Source/license review scope is documented in [MCP_PRESETS.md](MCP_PRESETS.md).

## Bilibili chat background tasks (development branch)

The bundled Bilibili MCP advertises12 tools:9 source reads and3 host task controls. `queue_library_digest` and `cancel_library_digest` require write classification, explicit caller permission and a real current request; `library_digest_status` is read-only. Standalone MCP clients receive `requiresHost` for these controls. Only the exact bundled stdio program can bind host execution; a remote service copying their names cannot queue tasks.

Task parameters select the current Bilibili account's video favorite folders, watch-later videos and/or independent favorite articles; video/article kinds; published or added time; fixed ISO bounds or rolling `lookbackDays`; one-time or daily IANA-zone runtime windows; at most10 items per run and a summary focus. Daily mode requires recurring intent in the actual requester text, not in site content. No argument can supply a destination, model credential, executable or callback URL.

Profile-local `tasks` storage persists jobs under `bilibili-digests:v1`. A job binds the actual QQ, original conversation and creator, approved server/tool hashes and exact selected model fingerprint. Current authorization is rechecked before source reads, inference and every outgoing QQ chunk. Owner-private use additionally needs the existing privateReplies setting and an explicit per-tool owner user grant; other MCP services receive no new private tool channel. Status and cancellation remain creator/conversation-scoped.

The scheduler returns a queue acknowledgement before any long-running work, processes one job per profile, and limits each run to5 minutes,5 source-list reads,100 candidates and10 summaries. Daily windows are deduplicated by their starting local date, including overnight windows; no missed-window catch-up burst runs. Exact inference/send boundaries honor the window, not only the polling timer. Completed source IDs prevent repeat summaries; daily runs without new summaries stay quiet. Once-only empty results receive an explicit completion. Cancel/revoke/close/config changes stop subsequent work; model and connection changes never inherit old task approval.

The Bilibili cookie is scoped to the official metadata API. Subtitle downloads accept only configured official HTTPS CDN addresses and carry no Cookie/Authorization. Results use canonical content links, source kinds and coverage; signed subtitle URLs and full source bodies are not persisted in jobs. Missing subtitles produce clearly labeled metadata summaries. Articles use real text; images and embedded media do not count as read content. The source implementation issues no playback/history/favorite writes.

Summaries use the current configured API once per content item, with an output prompt scaled to its token budget and literal-source quotation checks. No automatic provider fallback or paid retry is introduced. Delivery attempts are persisted before sending; ambiguous results and fixed failure notices never automatically replay. Partial generated summaries remain recoverable after a crash. All controls are conversational; no Bilibili-specific frontend page or REST task administration endpoint is added. See [MCP guide](MCP.md) for setup and chat examples.

## AI tool calling

Native plugin function calling is documented in [PLUGIN_DEVELOPMENT.md](PLUGIN_DEVELOPMENT.md). The development branch also implements a standard MCP tools client, documented in [MCP.md](MCP.md), using explicit stdio, Streamable HTTP or legacy SSE transports. Neither grants arbitrary website control without a configured service implementing it. Account `tools` defaults off; at most 100 grants each identify `{tool:'plugin/name',groupIds:[],userIds:[],allowWrite:false}`. Reads may allow every member of explicitly selected groups through an empty `userIds`; caller-initiated writes require `allowWrite:true` and an explicit matching requester. The separate natural-QQ-reply policy does not grant external application writes. QQ read/send permissions do not grant access to external apps by themselves.

Wake modes are real OneBot mentions, notices that poke the controlled QQ, configured names/aliases at the start of a message, and an optional command prefix. In the ordinary command flow, bare mentions/names/pokes only return a wake response without external tool execution. An explicit tool request requires enabled API chat, an available installed plugin/approved MCP/built-in implementation as appropriate, matching grants, current QQ identity, read/send group access and account release. Social replies may instead use the separately owner-approved natural QQ actions. All model invocations use configured APIs. Tool routing precedes ordinary chat/plugin callbacks to avoid duplicate execution.

`tools.catalogMode` is `auto` by default, with `all` as an owner-selectable alternative. Automatic mode uses host-local `search_available_tools` when the authorized catalog exceeds six tools or 16 KiB of schemas. Discovery searches only this request's already-authorized snapshot, supports Chinese/English terms, and exposes at most five matching real tools plus the search function within a 96 KiB definition budget. Two discovery searches are separate from the three business-tool calls; progressive conversations allow at most six inference rounds, while all-loaded/small catalogs retain four. The host never substitutes a generic remote `call_tool` that could bypass per-tool schemas, write receipts or runtime checks. Unsearched function names remain unavailable.

The built-in QQ MCP uses the same authorized catalog and budgets; see its scope and result contracts above. Cache outputs remain bounded text with real source message IDs for attribution, never an arbitrary history or OneBot gateway.

The host offers only currently authorized descriptors to the API model; each candidate call is schema-checked before any batch executes and re-authorized on execution and final delivery within the budgets above. Results are `tool` role data, not system instructions. Model conversations enable the internal `recoverPolicyDenials` router policy: an unavailable/unauthorized tool name or schema-invalid arguments reject the entire proposed batch before executing any action; otherwise valid calls in that batch also remain unexecuted. Confirmed denials return `{executed:false,status:"denied"}` as tool data for a natural reply or silence and still consume the corresponding search/business budget. Malformed JSON, duplicate call IDs, protocol failures, cancellation/revocation/clear and unknown execution outcomes remain terminal. No automatic retry or billing fallback is introduced. Same-request duplicate writes and persistent same-message write replays are blocked; cancelling a tool cannot roll back effects already accepted by an external app.

## Social conversation and member memory

Schema 2 remains compatible. Missing new fields use conservative defaults; migration never enables social participation, autonomous tools or memory for an existing group.

```text
chat.social = {
  name:'', aliases:[], interests:'', batchMs:1500,
  followUpSeconds:120, accountCallsPerHour:30
}
groups[].social = {
  enabled:false, proactive:false, interests:'', style:'',
  activeStart:'10:00', activeEnd:'22:00',
  decisionCallsPerHour:12, repliesPerHour:6,
  proactiveIntervalMinutes:10, readTools:[], replyTools:[],
  replyActionCooldownSeconds:30, replyActionsPerHour:6
}
```

Social mode unifies ordinary responses and offered tools. No authorized tool is required to answer an ordinary question. The model returns a bounded internal reply/silent decision, visible reply text, optional short topic and candidate memory metadata; invalid structures must never be sent as raw JSON to QQ. Short-message batching and a relevant follow-up window replace silent loss of direct follow-ups under the legacy casual cooldown. Subject to permissions, direct requests have priority over unsolicited participation. Stale unsolicited output may be discarded; external write execution retains the existing persistent replay protection and cannot be automatically repeated due to a conversation update.

Autonomous opportunities use host-local active hours, a minimum check interval, per-group/per-account model-call budgets and a group send cap. The check interval is not a promise to send. There is no mandatory idle threshold or daily topic quota. Each follow-up model request in an autonomous tool conversation counts toward its budget. A separately authorized `readTools` list offers installed enabled material-reading tools to an explicit autonomous identity; manual requester grants must not be borrowed or fabricated. External application writes are never added to autonomous jobs. Every send still passes account, identity, epoch, scenario and group read/send checks. Restarting must not reset activity budgets or replay missed posts.

`groups[].social.replyTools` defaults empty and accepts only `qq:send_sticker`, `qq:send_image`, `qq:send_message`, `qq:react_message` and `qq:poke_member`. Owner selection independently permits these current-group reply actions and their QQ cache/member/asset read helpers during social turns, including autonomous turns; it does not borrow a group member's grants. File sending, forwarding, recalling and external writes remain excluded. `replyActionCooldownSeconds` defaults to 30 (5–3600), `replyActionsPerHour` to 6 (0–60). Per-group attempts are persisted before dispatch and remain limited across restart. Each autonomous turn uses a host UUID, not an invented member identity. Pure action replies may be silent after success while retaining the follow-up window; they do not create fabricated memory or experience evidence. Asset choices use cached semantics and current context; an inappropriate/uncertain choice should produce text or silence instead.

Conversation records are scoped to the stable profile, actual logged-in QQ and group. They distinguish user/assistant roles and preserve sender, time, optional display name and reply relation. Assistant content is recorded as delivered only for confirmed successful send parts; own echoes do not retrigger or duplicate records. Development-branch storage retains conversation originals for 330 days, independently of notification retention; model context and QQ cache-tool retrieval retain their existing 30-day window.

Long-term member memory adds member QQ to this scope. Candidates represent explicit member facts/preferences and are proposed alongside existing reply calls without dedicated paid extraction. Sources must resolve to bounded real human messages actually supplied in that turn, matching the candidate member; assistant text, notices, tools and tests are not evidence. Store necessary source excerpts separately from expiring message history. Pending/rejected records are never injected as memory. Only confirmed records from the current enabled group's exact identity scope may be retrieved, with bounded relevance/context. Confirmed memories are not erased by notification cleanup, restart, functional reset or pause; explicit deletion is required. Owner mutations use record versions to reject stale edits. Enabling/pausing memory is a separate data operation and neither applies account parameters nor changes QQ authorization.

### Memory storage and directory migration (development branch)

`memory-storage.mjs` separates 12 memory/conversation/experience/persona business tables and an internal migration marker into profile-local `memory.sqlite`. The default is the profile's existing data directory; a custom global root uses `<root>/profiles/<stable-profile-id>/memory.sqlite`. Account configuration, vault keys, QQ connections, notification `messages`, tasks, write ledgers and event receipts stay in the original profile directory. Profile identity and actual-QQ/group/member scopes are preserved.

`GET /api/memory-storage` returns `{activeRoot,pendingRoot,restartRequired,defaultRoot,migrationError,capacityMultiplier,limits}` plus diagnostic state. An empty `activeRoot` means the default per-profile locations; `pendingRoot:null` means no pending switch. `POST /api/memory-storage {directory}` accepts an absolute local directory or `""` to restore defaults, checks write access and stages the selection only. It retains local Host/Origin/CSRF checks and does not change account parameters, grant permissions or move an open database. Fully exiting and restarting applies the change; closing to tray does not. Docker paths refer to the container and require an appropriate persistent mount.

Before opening account stores, migration copies only the fixed table set in a synchronous SQLite snapshot and verifies row counts, row contents and database integrity. Only after all profiles succeed does the global pointer in `memory-storage-settings.json` switch. Existing sources remain intact; initial splitting backs up `history.sqlite` as `history.pre-memory-split.backup.sqlite`, and replacing a prior target keeps a `before-move` backup. Ownership markers and process locks reject conflicting profiles/live access; missing initialized memory cannot silently become an empty replacement. Failure retains the active source, pending selection and a visible error.

Storage limits increase by 1000% to 11 times their prior values: conversation originals 330 days/132000 characters per record, manual member memories 6600 characters, experiences 3300 characters/440 active entries per group, management list maximum 11000 and persona-history retrieval maximum 1100. Previously uncapped total fact/version counts remain uncapped. Candidate generation, relevant-memory scans/returned counts, prompt truncation, the 30-day model retrieval window and two-hour conversation TTL are unchanged. Larger storage does not enlarge each model request or automatically increase API use.

User-facing setup and diagnostics: [SOCIAL_CHAT.md](SOCIAL_CHAT.md).

## HTTP API

Listen only on `127.0.0.1`. All mutations require `X-Dashboard-Token`. Validate Host/Origin, JSON Content-Type and body size. Reject arbitrary shell commands and download origins. Native NapCat selection and custom-plugin imports are explicit, validated local-path operations; other endpoints do not gain filesystem access.

```text
GET  /api/memory-storage
POST /api/memory-storage {directory}
GET  /api/mcp/presets
GET  /api/accounts -> {csrfToken, accounts, platforms, napcatSettings, plugins}
GET  /api/plugins -> {plugins}
POST /api/plugins/install {sourcePath}
POST /api/plugins/:id/uninstall {}
POST /api/accounts {name, platform:'qq', qqNumber?} -> {account, state}
GET  /api/accounts/:id/state
GET  /api/accounts/:id/qq/assets?groupId=&kind=&query=&limit=
GET  /api/accounts/:id/qq/assets/preview?assetId=&groupId=
GET  /api/accounts/:id/qq/actions?groupId=&limit=
POST /api/accounts/:id/qq/assets/import {groupIds,kind,name,dataBase64,...metadata}
POST /api/accounts/:id/qq/assets/update {assetId,expectedVersion,...metadata}
POST /api/accounts/:id/qq/assets/remove {assetId,expectedVersion}
POST /api/accounts/:id/qq/assets/analyze {assetId,groupId,provider}
POST /api/accounts/:id/qq/assets/sync-stickers {groupIds,limit?}
POST /api/accounts/:id/mcp/preset/prepare {id,command?,args?,url?}
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
POST /api/accounts/:id/runtime/connect
POST /api/accounts/:id/test/deepseek
POST /api/accounts/:id/test/model {provider}
POST /api/accounts/:id/plugins/:pluginId/run {input?}
POST /api/accounts/:id/qq/test-message {groupId}
GET  /api/accounts/:id/setup/status
GET  /api/accounts/:id/tools
POST /api/accounts/:id/tools/call {tool, arguments?}
GET  /api/accounts/:id/memory?actualQQ=&groupId=&userId=&status=&query=
GET  /api/accounts/:id/memory/tree
POST /api/accounts/:id/memory/action {action,id?,version?,actualQQ,groupId,userId,text?,kind?}
POST /api/accounts/:id/memory/group {actualQQ,groupId,enabled}
POST /api/accounts/:id/summary/run {groupId}
POST /api/accounts/:id/favorites/sync
POST /api/accounts/:id/favorites/summarize
POST /api/accounts/:id/policy/preview {userId,groupId?,message,messageType:'group'|'private'}
```

Asset import alone permits a bounded 29 MiB JSON body for Base64; other APIs retain the 1 MiB limit. The host supplies the applied account identity and rejects conflicting caller identities. Image preview is scoped to approved current-group image/sticker bytes with the actual MIME and `nosniff`; it is not an arbitrary file endpoint. Preview/import do not grant send permission. Explicit vision analysis uses the account's currently enabled compatible API if it supports image input; it never enables another model or treats DeepSeek text as image-capable.

Account list entries: `{id,name,platform,qqNumber,runtime,permissions,pendingChanges}`. Account state: `{account,csrfToken,draft,applied,revision,appliedRevision,pendingChanges,secrets,runtime,modules,jobs,logs,summaries,favorites,environment,metrics,setup}`. `secrets` contains boolean presence flags for `deepseekApiKey`, `napcatToken` and configured `apiKey:<id>` values; never plaintext credentials. Additional diagnostic metadata may be included.

Memory actions are `create`, `update`, `confirm`, `reject` and `delete`; kinds are `fact` or `preference`, with `pending`, `confirmed` or `rejected` status. A record contains `{id,actualQQ,groupId,userId,text,kind,status,version,sources,createdAt,updatedAt}`; each message source preserves `{messageId,userId,text,time}`. Manual owner-created records may have no message evidence and are identified as manual. Group activation must refer to a selected readable group in the profile. Memory endpoints inherit the local Host/Origin/session checks and never expose another profile's store.

Group discovery requires a verified connected QQ identity. It returns joined group IDs/names; it does not auto-select groups or grant permissions. Policy preview never sends or invokes a model. Model connectivity testing is a real request, potentially billed for APIs or consuming subscription allowance, and must be labelled accordingly. The optional QQ test-message endpoint sends fixed visible diagnostic text, does not invoke a model, and requires an enabled API chat scenario, account release and a configured readable/writable group.

Saving a draft cannot grant `released:true`. Ordinary apply and rollback always restore read-only state. Only `/permissions/release` validates the saved current revision and explicitly applies the requested targets with sending enabled. Revoke immediately blocks sends and cancels old work for that account. Revisions prevent applying stale forms.

Every task captures a profile ID; UI selection never reassigns a running operation. Legacy unscoped endpoints are compatible only when exactly one profile exists; multiple profiles require explicit IDs. Errors use 400/403/404/409/502 as appropriate and `{error,details?,issues?,code?,action?,nextStep?}`. Configuration issues are `{path,message,action}` objects; `details` retains compatible text messages. Display actionable field errors, not a raw JSON array. Failed installation or model connectivity cannot be labelled successful.

## Guided setup and window controls

The account page begins with only the create action. Each account expands into six steps: identity/model selection, credentials, verified QQ connection, scenarios, target permissions/release, and verification. Overview retains its business content. Existing Scenarios subpages remain available and edit the same per-account configuration.

`setup` in account state and `GET /setup/status` contain:

- `steps`: `{id,title,state:'complete'|'current'|'pending',description,optional?}` for `identity`, `models`, `connection`, `scenarios`, `permissions`, `verification`.
- `blockers`: `{code,message,field,action,nextStep}`; `nextStep` identifies the first actionable step.
- `connection`: `{state,connected,verified,expectedQQ,actualQQ,lastError,issue}`; refused socket, wrong endpoint, authentication, QQ-not-logged-in and identity mismatch have distinct guidance.
- `models`: `{configured,tested,providers:[{id,label,enabled,credentialReady,tested,testedAt}]}`. Successful real tests are tied to the provider configuration/key fingerprint and cannot remain valid after relevant edits.
- `verification`: `{tested,groupId?,accountId?,testedAt?}` records the explicit fixed-message test, not a fabricated real-account end-to-end result.

The final “启动此账号” action invokes the existing explicit release transaction. Read-only connect and group discovery never invoke AI or release send permissions. Missing a successful optional real model test does not justify claiming that model is verified.

Desktop uses `frame:false` and custom, accessible window controls with restricted preload IPC. A global Settings choice persists close-to-tray (default) or quit in Electron userData `desktop-settings.json`; both custom close and OS close honor it. Explicit quit and tray “完全退出” always stop owned backends. No tray support means closing exits. Window settings contain no credentials and are independent of account configuration/export.

## Installer interface

`createInstaller({dataDir,profileId,legacy,getConfig,getSecret,setSecret,log})` returns `environment`, `status`, `install`, `startNapcat`, `stopNapcat`, `napcatGuide` and `dispose`.

Operations use trusted fixed argv and `shell:false`. Docker uses a local daemon, pinned official image and persisted RepoDigest, per-profile managed container labels, independent persistent volumes and loopback ports. Never take over a non-project container. Native Windows NapCat is installed and run externally; OneBot runtime access does not require Docker. Docker install/start/stop buttons do not manage native instances.

The installer does not install or authenticate a model CLI. Model access is configured with API keys. Retired subscription module/action routes must be rejected rather than launching old executables. NapCat installation, process state, QQ login, API configuration and permission state remain distinct.

## Runtime and store interfaces

`createRuntime({getConfig,getSecret,store,installer,log,providers?})` returns `reload`, `connect`, `stop`, `status`, `testDeepSeek`, `testModel`, `testGroupMessage`, `listGroups`, `runSummary`, `runFavoritesSummary`, `syncFavorites` and `preview`. Each profile has its own runtime, socket, epoch, cancellation, bounded queue and cooldowns. Reconnect uses backoff. Scheduler follows host-local time, with per-account/group/day deduplication and release checks before scheduling, queueing and inference. No silent paid fallback.

`createStore(dataDir)` provides draft/application/rollback state, staged encrypted secrets, message/evidence history, summaries, favorites, task deduplication and metrics. Each profile's database and retention are independent. Source records preserve QQ identity, group, message/CID, sender, time and original text. No cross-profile context or favorite reuse.

Desktop native export accepts an optional profile ID and uses the corresponding fixed redacted endpoint. Application exit or parent IPC loss must close all profile runtimes and owned installer subprocesses. Never kill unrelated processes.

## v0.8.0 persona, experiences and connector additions

Account endpoints remain under `/api/accounts/:id`. Reads are `GET /persona/history?actualQQ`, `/experiences?actualQQ&groupId&status`, `/experiences/history?actualQQ&groupId&id` and `/conversation/state?actualQQ&groupId`. Mutations retain the same local Host/Origin and CSRF checks.

- `POST /persona/preview {config, groupId?}` previews the unsaved form without calling a model. `POST /persona/restore {actualQQ, revision}` returns a role draft, without saving or applying permissions.
- `POST /experiences/action` uses `{actualQQ,groupId,action,id,version,text?,kind?,targetVersion?}`. Actions are create/update/archive/restore/delete/rollback; create omits id/version. Delete removes text, sources and versions; one-way fingerprints prevent automatic relearning.
- `POST /experiences/group {actualQQ,groupId,paused,version}` changes accumulation/retrieval. `POST /conversation/clear {actualQQ,groupId,version}` clears short context and cancels old work while retaining raw history and long-term memory.
- Config schema 3 adds `qq.backend` (`napcat` or `snowluma`) and `qq.connections` snapshots. Top-level `qq.wsUrl/webUiUrl/httpUrl` are authoritative for the active backend. SnowLuma HTTP and WS credentials have separate encrypted names, `snowlumaHttpToken` and `snowlumaWsToken`; `napcatToken` remains unchanged. The development adapter declares `available:true`, `verified:false`, `externalRuntime:true`, `runtimeManaged:false`, with Windows dynamic and live QQ review still pending. It connects a user-prepared external instance and does not download, install, start, update or redistribute SnowLuma/native inputs. Availability is a protocol-integration state, not a vendor-binary safety verdict. The exact handshake requires `app_name:SnowLuma`, `app_version:2.4.2-node`, `protocol_version:v11`, matching HTTP/WS QQ identity, and both channels reporting online/good.
- `POST /connection/switch {backend,revision}` verifies the target connector identity and returns to read-only. Profiles and actual QQ identity are preserved. No automatic backend rotation or uncertain-send retry is permitted.
- SnowLuma's own status responder, notification channels, history sync and hook autoload must remain disabled in a controlled setup; they are outside QQ_Service's send gate. QQ_Service model keys and vaults are never passed to that program. Its Node requirement (`^24.22.1 || >=26.12.1`) is independent of the currently bundled QQ_Service Windows Node24.19.0. `updateSource.mode:direct` is not an update-disable switch. Source, licensing and remaining checks are recorded in [SnowLuma review](SNOWLUMA_SECURITY_REVIEW.md) and [public build evidence](SNOWLUMA_BUILD.md).
- Host-created message references use `qqref:v1:<backend>:<connection-generation>:...`, with explicit stored origin/native-ID provenance. Each socket gets a fresh generation. History and memory survive reconnection/switch, but reply/reaction/forward/recall targets must resolve to a visible stored row matching the active account, group and generation. Legacy raw IDs remain read-only, and a parsed or model-supplied prefix alone is not authority. Native wire IDs are reconstructed only after this proof; they are not used as global evidence identities.

Experiences and current conversation state are profile-local and keyed by actual QQ and group. Member facts keep their explicit confirmation requirement. Background browsing cannot become evidence for either store.
