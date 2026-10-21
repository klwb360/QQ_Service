# Account control implementation contract

This document describes the 0.4.0 guided account-control flow. The user requires multiple saved accounts that can run concurrently; account/model setup remains read-only until permissions are released in the group permissions subpage.

## Configuration and authorization

Each profile has its own existing configuration document. Version 2 retains `botQQ` as the connected QQ identity and `ownerQQ` as the optional private command/summary recipient; UI labels must explain those roles without small/main account terminology.

- `schemaVersion: 2`.
- `permissions: { released: false, privateReplies: false }` is the account-wide authorization. Model login and saving credentials never set it.
- `chat` adds `enabled: false` and `provider: 'deepseek'`. The owner default conversation model can be DeepSeek, a configured compatible API, or Codex; automatic group conversation is enabled only for API providers. Existing persona/context fields remain.
- Each group retains its existing fields and adds `read: true`, `send: false`. `triggers` is a multiselect OR list, default mention only; legacy single `trigger` normalizes to the corresponding list. Clear means no automatic replies, and select all never grants permissions. Group mode describes the workflow; sending requires explicit per-group permission and account release. Group creation never authorizes sending.
- Summary defaults to disabled and `sendToOwner: false`; its model and schedule remain per account.
- Favorites adds its own `provider: 'deepseek'`, independent of the notification workflow.
- QQ connection can be enabled without `ownerQQ`; an expected `botQQ` and OneBot token are required. A QQ number is configuration, not authentication.
- All outgoing messages, including errors, require the account release, enabled scenario and destination permission at the final send gate. Owner private replies additionally require `privateReplies`. Workflows can run locally without sending.
- Codex subscription remains for owner-initiated/authorized personal tasks. Public automatic group conversation uses the selected DeepSeek/compatible API provider. The UI provides model choices only where supported.
- `models.apis` holds up to 20 named OpenAI-compatible API entries; `provider` may be `deepseek`, `codex` or an `api_...` ID. Each scenario chooses one. Secrets use `apiKey:<id>` outside exportable config; enabling several entries does not send each message to all providers.
- Same-QQ `ownerQQ` is allowed when private delivery is off. When private replies or enabled private summary delivery is selected, require another recipient or explain how to turn those options off; do not block group-only or local read access.
- Configuration errors expose `issues: [{path,message,action}]`, with text `details` retained for compatibility. Explain and locate errors without displaying a raw validation array.
- `schemaVersion: 1` documents migrate explicitly, preserving existing permissions without broadening them. New profiles start fully read-only. Existing data paths and login state remain in place for the legacy profile.

## Profiles, API and isolation

Root `accounts.json` contains stable IDs, platform (`qq` currently), label and creation time. New profiles use `accounts/<UUID>/` with independent config/vault/database/module records/Codex login. The migrated legacy profile keeps the original root directory. UI selection never changes the target of a running operation.

Current platform registry exposes QQ as implemented and WeChat/Telegram as planned, not functioning adapters. IDs are server-generated, and unsupported platforms are rejected. Each account owns independent OneBot ports/token/NapCat container or external connection; no account may use another account's active endpoint.

API shape:

```text
GET  /api/accounts -> { csrfToken, accounts, platforms }
POST /api/accounts { name, platform: 'qq', qqNumber? } -> { account, state }
GET  /api/accounts/:id/state -> existing state + { account }
POST /api/accounts/:id/config/save -> existing save payload and response
POST /api/accounts/:id/config/apply -> existing revision payload and response
POST /api/accounts/:id/config/rollback
POST /api/accounts/:id/permissions/release { revision }
POST /api/accounts/:id/permissions/revoke
POST /api/accounts/:id/codex/login, /codex/status
POST /api/accounts/:id/runtime/connect
POST /api/accounts/:id/environment/check
POST /api/accounts/:id/setup/install, /modules/:module/(install|start|stop)
POST /api/accounts/:id/test/deepseek
POST /api/accounts/:id/test/model { provider }
POST /api/accounts/:id/qq/test-message { groupId }
GET  /api/accounts/:id/setup/status
POST /api/accounts/:id/summary/run { groupId }
POST /api/accounts/:id/favorites/sync, /favorites/summarize
POST /api/accounts/:id/policy/preview
GET  /api/accounts/:id/qq/groups -> { groups: [{ id, name }] }
GET  /api/accounts/:id/config/export, /napcat/guide
```

Account list entries: `{ id, name, platform, qqNumber, runtime, permissions, pendingChanges }`. Account states keep `{ draft, applied, revision, appliedRevision, secrets, codexAuth, runtime, modules, jobs, logs, summaries, favorites, environment, metrics, csrfToken }` so existing forms can be scoped rather than duplicated.

Save/apply cannot turn a non-released account into a released one; explicit `permissions/release` validates and applies the current saved revision only after group/target configuration. Revoke immediately disables sending and cancels old work. All profile APIs are account-bound; legacy unscoped APIs work only when one profile exists (or lazily create a blank legacy profile for older clients).

Ordinary apply and rollback return to read-only. Automatic schedules require release; explicit dashboard local tasks remain available while read-only. Configuration transactions reserve both the old and candidate QQ identities and endpoints until external work succeeds or rollback completes. Shutdown rejects late request bodies and does not restart runtimes while restoring an in-flight transaction.

The desktop native export receives an optional profile ID and uses the corresponding fixed export endpoint. Logs and jobs carry the profile ID and redact credentials across every profile. Close/disconnect cleans all owned runtimes and installer child processes.

## UI

Navigation: Overview / Account control / Scenarios and permissions / Modules / Records / Settings. Overview contains key statistics, runtime status and recent jobs; account selection, draft/apply controls and duplicate onboarding details belong on account-related pages. All four overview statistics navigate to their relevant account, permission or record page. Remove the native title/menu bars; custom window buttons and a global close-to-tray/quit choice belong to the desktop interface.

- Account control: the only page with an account creation entry. Initially show only create; after creation, each account is one accordion whose header remains consistent when expanded or collapsed. Its body continues directly below the same header with an animated transition. Do not repeat the account heading, add a separate collapse action or render a horizontal step navigation bar.
- Continuous setup: retain the six logical phases for identity/model selection, credentials, QQ connection, scenarios, permissions and verification. Completing/continuing a phase reveals the next section below with an animated transition; previously revealed forms remain visible and editable. Existing task and permission editors remain separate destinations reachable from the continuous flow. Multiple API channels and ChatGPT subscription can coexist. Plainly explain NapCat and show actual next actions rather than requiring users to infer the workflow from unrelated pages.
- Scenarios: account selector and two subpages, "账号功能参数" and "选定群与消息权限". All chat/summary/favorites parameters belong to the selected account. Remove quick scenario presets.
- Group permissions: per-group read/send controls, optional private command/summary recipient, private reply authorization, and a final explicit release/revoke action. Show the actual applied permission state.
- Preserve unsaved fields across polling and account changes; actual login identity cannot fall back to the configured QQ number. Final “启动此账号” explicitly applies/release checks; separate status and fixed-message verification must not imply a real account was tested in CI.
- Existing Docker NapCat installation remains an optional per-profile deployment path. Explain native external NapCat setup; do not claim the installer already installs native Windows NapCat.

## Setup status and diagnosis

`setup` is returned in account state and via `GET /api/accounts/:id/setup/status`. It derives six step states and actionable blockers from this profile's saved/applied parameters, actual OneBot identity, scenario selection and release state. Model tests and optional fixed QQ test messages are explicit actions. Test success is bound to configuration and credentials and becomes stale after relevant changes; configured parameters are not evidence of a working model.

`POST /test/model {provider}` performs a real local-only model request. `POST /qq/test-message {groupId}` sends fixed visible diagnostic text to a released readable/writable group through the same destination gate, with API chat enabled and no AI call. It must reject unauthorized targets, stale account identities and Codex automatic group routes. Group reading/local summaries require no private recipient.

## Multiple group triggers

The supported `group.triggers` values are `mention`, `prefix`, `casual`, `poke`, `group_name`, `member_join`, `member_leave`, `admin_change`, `mute`, `recall`, `group_card`, `emoji_like`. UI labels describe responding to @, prefixes, low-probability new-message participation, poke and actual group notices. All obey account release, selected readable/writable groups, API-only public conversation and cooldown. Notices only request authorized text replies; they do not grant renaming, moderation, recall access or idle autonomous posting. Absent arrays preserve valid legacy single trigger choices; explicit empty arrays stay empty.
