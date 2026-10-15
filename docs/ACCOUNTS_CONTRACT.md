# Account control implementation contract

This document describes the 0.3.0 account-control refactor. The user requires multiple saved accounts that can run concurrently; account/model setup remains read-only until permissions are released in the group permissions subpage.

## Configuration and authorization

Each profile has its own existing configuration document. Version 2 retains `botQQ` as the connected QQ identity and `ownerQQ` as the optional private command/summary recipient; UI labels must explain those roles without small/main account terminology.

- `schemaVersion: 2`.
- `permissions: { released: false, privateReplies: false }` is the account-wide authorization. Model login and saving credentials never set it.
- `chat` adds `enabled: false` and `provider: 'deepseek'`. The owner default conversation model can be DeepSeek or Codex; automatic group conversation is enabled only for DeepSeek. Existing persona/context fields remain.
- Each group retains its existing fields and adds `read: true`, `send: false`. Group mode describes the workflow; sending requires explicit per-group permission and account release. Group creation never authorizes sending.
- Summary defaults to disabled and `sendToOwner: false`; its model and schedule remain per account.
- Favorites adds its own `provider: 'deepseek'`, independent of the notification workflow.
- QQ connection can be enabled without `ownerQQ`; an expected `botQQ` and OneBot token are required. A QQ number is configuration, not authentication.
- All outgoing messages, including errors, require the account release, enabled scenario and destination permission at the final send gate. Owner private replies additionally require `privateReplies`. Workflows can run locally without sending.
- Codex subscription remains for owner-initiated/authorized personal tasks. Public automatic group conversation uses DeepSeek. The UI provides model choices only where supported.
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

Navigation: Overview / Account control / Scenarios and permissions / Modules / Records.

- Account control: list/create profiles, platform choice, QQ identity, connection state and model credentials; plain explanation of the QQ connection component (NapCat); advanced local endpoint/token fields.
- Scenarios: account selector and two subpages, "账号功能参数" and "选定群与消息权限". All chat/summary/favorites parameters belong to the selected account. Remove quick scenario presets.
- Group permissions: per-group read/send controls, optional private command/summary recipient, private reply authorization, and a final explicit release/revoke action. Show the actual applied permission state.
- Preserve unsaved fields across polling and account changes; actual login identity cannot fall back to the configured QQ number.
- Existing Docker NapCat installation remains an optional per-profile deployment path. Explain native external NapCat setup; do not claim the installer already installs native Windows NapCat.
