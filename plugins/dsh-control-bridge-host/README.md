# dsh-control-bridge-host

MIT. A Desktop-profile bundle for `dsh-control-bridge`. It is not a DeepSeek product.

The loopback bearer and the choice to call `sessionController` inside the Host, instead of the browser token, follow the MIT-licensed project [ft54482/dsh-agent-bridge](https://github.com/ft54482/dsh-agent-bridge). This package is a separate implementation and does not include that project's code.

Installing this Host for Codex? Start with the [Windows setup and pairing guide](https://github.com/ft54482/dsh-control-bridge/blob/main/docs/windows-delivery.md#codex-desktop-setup). For a custom listener port, follow the [port configuration guide](https://github.com/ft54482/dsh-control-bridge/blob/main/docs/ports.md#desktop-host).

## What it calls

Inside a Desktop Host that has already mounted the official services, the plugin uses:

- `workspaceRegistry.list()` (synchronous) to list allowlisted workspaces
- `sessionController.list(request, signal)` to list allowlisted sessions; rows are official `SessionSummary` values (`sessionId`, `running`, `agentAvailable`, `projections.values`)
- `sessionQuery.readSession(sessionId)` → `{ session, inheritedEventCount, events }` to page history
- `sessionQuery.observeSession(sessionId)` for the cheaper result polling during a resume (falls back to `readSession`)
- `sessionController.prompt(request, AbortSignal)` with `mode: "queue"`, whose official result is only `{ accepted: true }`
- `sessionController.cancel({ sessionId })` only after the log proves the open turn carries this request's `rpcId`
- `agents.get(sessionId).model.current()/select()` for the session-scoped model choice
- `llm.listProviders()`, `llm.listModels()`, `llm.resolveCallConfig()`, and `llm.resolveModelInfo()` for the route and its official reasoning efforts
- `sessionController.create({ workspaceId } | { cwd })`, `workspaceRegistry.create(path, title)`, `sessionController.canOpenWorkspacePath()/openWorkspacePath(request, signal)` for the opt-in create/open endpoints (0.2.0)

The full 0.2.0 endpoint and state contract is [docs/host-api.md](../../docs/host-api.md); the evidence level of each part is in [docs/release-0.2.0.md](../../docs/release-0.2.0.md).

## Models: four different things, never conflated

The deployment default, the selection a session recorded, a pending selection, and what a request actually executed are four different values. The plugin reports them separately and never substitutes one for another:

| Field | Source |
| --- | --- |
| `global_default` | `agentDefaultModel.currentSelection()` — the deployment default, reported only as itself |
| `session.last_used` | the last `request/header` event's `config` — what a request really used |
| `session.pending` | a later `model/selection` event not yet used by a request |
| `session.next` | `pending ?? last_used` — what the next request will use |
| `session.last_execution` | the last `request/header` config (the recorded execution) |
| `execution_model` (resume) | the `request/header` inside the collected turn |

When the session recorded nothing, the model is `null` with `model_source: "unknown"`. **A deployment default is never reported as a session's model.** `model_source` is one of `session_log`, `session_projection`, `request_header`, `unknown`.

`GET /v1/models?session_id=…` returns the four states, the availability of `next`, and `can_set` / `can_set_reason`. `POST /v1/model {session_id, provider, model, reasoning_effort?}`:

1. requires write access and an idle session;
2. checks `llm.listProviders()` / `llm.listModels()` / `llm.resolveCallConfig()` — a provider without an adapter is `409 no_adapter` **before** anything is sent;
3. needs a live Agent; without one it returns `409 needs_ui` and changes nothing (the plugin never attaches agents and never edits history files);
4. records `agent.model.select(...)` — the official session-scoped `model/selection` event — then reads `agent.model.current()` back and fails with `model_readback_mismatch` if it differs;
5. never changes the deployment default (it does not call `sessionController.selectModel`, which also saves the default).

`POST /v1/resume` accepts an optional `model: {provider, model, reasoning_effort}` and performs the same set-then-confirm path. It always refuses before `prompt()` when: the route is unknown, no adapter is registered, the adapter rejects the call config, the grant is read-only, the session is running, or the confirmed selection changed between the preflight and the send (`409 model_changed_before_send`). After the turn it reports `requested_model`, `confirmed_selection`, `execution_model`, `execution_model_source`, and `model_match`; a mismatch (`execution_model` differs from the confirmed route) is `completed: false` with `terminal: "model_mismatch"`, never a silent fallback.

`sessionController` is part of the Desktop Host because Desktop runs the Web Host. The headless profile does not mount it. If the service is missing, `apply` returns without listening and without throwing, so a headless profile is not crashed and is not described as Desktop.

## Long tasks: durable journal, SSE, discovery (0.2.0)

`POST /v1/resume` still accepts a synchronous wait (default 120 s), but `wait: false` / `wait_ms: 0` returns `202` with the accepted record immediately. The Desktop task is independent of that HTTP connection; the result is read later from the durable `requests.json`:

- `GET /v1/requests/:id/wait?timeout_ms=` — long poll to the terminal body (max 30 min);
- `GET /v1/requests/:id/events?after_seq=N` — incremental events, heartbeat when nothing changed;
- `GET /v1/requests/:id/stream` — SSE with `id:` = monotonic seq, a heartbeat comment every 15 s, `Last-Event-ID` resume, and `event: end` on terminal.

Every transition is journaled (`recorded`, `accepted`, `running`, `terminal`, `unknown`, `wait_stopped`, `revoked`) with a bounded 200-entry history. After a Host restart, the endpoint re-reads the official log with the stored `rpcId`: provable terminal states are folded back, unprovable ones stay `unknown` and are never resent. This observation channel is the honest completion mechanism; no inbound webhook is treated as a completion signal and nothing is pushed off the machine.

`GET /v1/discover` is the operator-anointed global view: all registered workspaces and sessions, `top`/`subagent`/`worker` classification, `running`/`waiting_input`/`error`/`terminal`/`unknown` (from the official list row and projections; otherwise `unknown`), pagination, dedupe, and `cwd_source`. It reads metadata only. History still requires a per-session grant, and prompt/cancel still require write access.

## Create and open, opt-in and path-guarded (0.2.0)

Three endpoints are disabled unless the plugin config names both the capability and the allowed roots:

```yaml
    workspaceRoots: [C:/work]
    allowCreateSession: true
    allowCreateWorkspace: true
    allowOpenPath: true
```

- `POST /v1/workspaces {path, title?, create_directory?}` → official `workspaceRegistry.create`; an existing path is idempotent, a missing path needs `create_directory: true` (one leaf under an existing parent).
- `POST /v1/sessions {workspace_id | (path + create_workspace:true), access?, title?, model?, agent_preset?}` → official `sessionController.create`, then a merge-only grant (default `read`; `write` explicit). A new session's model is `deferred` unless a live idle Agent exists; the deployment default is never changed.
- `POST /v1/open {path, action?, application?}` → official `openWorkspacePath`; it opens on the Host desktop and creates nothing.

For preset sessions in 0.2.2, use an already paired workspace ID. If its directory is outside the roots, list its exact ID in `presetSessionWorkspaceIds`. A new write session requires an existing write grant in that workspace. This exception applies only to creating a preset session, and it is the rule that [workspace autonomy](#workspace-autonomy-opt-in-per-operator-this-release) relaxes — only when the operator turns that policy on.

Filesystem paths are realpath-checked inside `workspaceRoots`: the root itself, sibling prefixes, `..`, and symlink escapes are refused. No delete endpoint is exposed.

## Workspace autonomy, opt-in per operator (this release)

**Identity of this change.** The plugin manifest stays at `0.2.2`; this work is not a version bump and is not released. `tests/test_release_manifest.py:15-19` asserts `dsh_control_bridge.__version__ == pyproject.toml` version `== dsh-control-bridge-host` version, so the number moves only together with a release of all three. Until then, identify the build by commit, not by the version string in `package.json`.

**What it changes.** A fresh workspace cannot be bootstrapped by the guarded create endpoints above: registration produces no grant, and a preset write Session requires an existing write Session. `workspaceAutonomy` closes that loop **only when the operator turns it on**.

**What it costs.** An effective policy makes *any absolute directory* eligible to become a workspace, take a write grant and hold the first write Session. The Host performs no writability test — it canonicalizes the path and, when asked, creates one leaf — so the real limit is the OS account's own file permissions: the same reach an ordinary shell in that account has. The policy is not a sandbox and it does not add a path restriction. It is therefore off by default, has no remote switch, and must be enabled by the operator in the plugin configuration of one profile. The bearer stays loopback-only, so this does not widen the network surface — it widens what a local caller with the bearer may name. Enable it in an isolated profile first; see [First start](#first-start) and [windows-delivery.md](../../docs/windows-delivery.md#workspace-autonomy).

### Configuration

```yaml
- id: dsh-control-bridge-host
  config:
    allowlistFile: <state dir>/allowlist.json
    secretFile: <state dir>/host.secret
    workspaceAutonomy: true            # or { enabled: true }; absent/false = old behaviour
    autonomyRecordFile: <file>         # optional; default dirname(allowlistFile)/workspace-autonomy.jsonl
    allowCreateWorkspace: true         # still the capability switch for POST /v1/workspaces
    allowCreateSession: true           # still the capability switch for POST /v1/sessions
    busyPolicy: refuse                 # default; a busy Session is never preempted
```

- `workspaceAutonomy` accepts `true` or `{ enabled: true }`. Absent, `false`, `null`, or any other value means **disabled**; every request and response then keeps its exact old shape.
- `autonomyRecordFile` is optional. Without it the journal is `dirname(allowlistFile)/workspace-autonomy.jsonl`.
- `allowCreateWorkspace` / `allowCreateSession` are still required: the policy relaxes *who may be granted*, not whether the capability is switched on. Both gates answer `403 create_workspace_disabled` / `403 create_session_disabled` before the policy is consulted.

**Effective determination.** `effective` is exactly the conjunction `enabled && allowlistFile configured && workspaceRegistry.create callable && sessionController.create callable && sessionController.projections callable` (`autonomy.js:166-201`). `reason` names the first missing piece: `not_configured`, `disabled`, `allowlist_file_missing`, `workspace_create_unavailable`, `session_create_unavailable`, `session_projections_unavailable`. A configured-but-ineffective policy **fails closed**: a write request that carries task intent gets `403 workspace_autonomy_not_effective` (with `autonomy_reason`) instead of silently falling back to the standard mode.

`GET /v1/health` always declares the truth in `workspace_autonomy` (`configured`, `enabled`, `effective`, `reason`, `require_task`, `roots_mode`, `grant_store`, `record_file`, `operations`). `roots_mode` is `unrestricted` whenever the switch is enabled and `configured_roots` otherwise; that field is a declaration, not an extra capability.

### Endpoints

| Method | Path | Under an effective policy |
| --- | --- | --- |
| POST | `/v1/workspaces` | With `task_id`+`purpose`: register or reuse the canonical directory, take a task-scoped workspace grant, return the 3.3 receipt. Without task intent the old guarded path answers unchanged; a path outside the roots, or an already-registered workspace with no grant, answers `400 task_required`. |
| POST | `/v1/sessions` | With `task_id`+`purpose`: register the path when given, create the Session, prove the preset through `sessionController.projections`, then grant. Without task intent, a request that needs a path / the first write Session / an unrestricted root answers `400 task_required`; a revoked workspace answers `403 workspace_not_allowlisted` (adding a task does not repair it). |
| POST | `/v1/workspaces/revoke` | Removes the workspace grant and every Session grant under it in one atomic write. Available even when the policy is off (it only ever removes authorization), and it is not task-scoped. |
| GET | `/v1/health` | Adds the `workspace_autonomy` block. |
| GET | `/v1/workspaces` | Each row now carries `task_id` (the owning task, `null` for an older grant) next to `id`, `title`, `cwd`. |

Receipts are additive; no old field changed meaning. `POST /v1/workspaces` returns `ok`, `workspace_id`, `workspace{id,title,path}`, `path`, `created`, `reused`, `created_directory`, `task{task_id,purpose,confirmed,previous_task_id}`, `grant{workspace_id,path}`, `autonomy{enabled,effective}`, `started_task:false`, `recorded` (plus `record_error` when the journal append failed). `POST /v1/sessions` returns `session_id`, `workspace_id`, `path`, `agent_preset` + `agent_preset_source`, `access`, `grant{session_id,workspace_id,access,cwd,task_id,source}`, `model`, `revision`, `task_id`, `purpose`, `workspace_created`, `workspace_reused`, `deduplicated`, `started_task:false`, `recorded` (plus `repaired:true` for a grant repair). `POST /v1/workspaces/revoke` returns `workspace_id`, `revoked{workspace,sessions}`, `directory_intact`, `started_task:false`, `revision`, and journals `workspace_revoke` with a `revoked` payload.

Error codes this flow can answer, beyond the pre-existing ones:

| Status | `reason` | When |
| --- | --- | --- |
| 400 | `task_required` | `task_id`/`purpose` missing, blank or too long; also the "this call needs a task" answer for an old-shaped request that only the policy can serve |
| 400 | `invalid_client_request_key` | `client_request_key` does not match `^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$` |
| 403 | `workspace_autonomy_not_effective` | task intent arrived but the policy is configured and not effective (`autonomy_reason` says why) |
| 409 | `workspace_task_mismatch` | the workspace already belongs to another task and `confirm_task` was not set |
| 409 | `idempotency_key_reused` | the key is bound to another operation or other arguments (`previous_operation`, `mismatched`) |
| 409 | `authorization_stale` | the replay's authorization was revoked, downgraded, removed or taken over (`historical` + `current.reason`) |
| 409 | `agent-preset/invalid` | the requested preset does not resolve to that exact id |
| 409 | `agent_preset_unverified` | the Session exists but its projection does not read back the preset; do not retry creation |
| 409 | `session_already_granted` | a repair found the Session already granted |
| 500 | `grant_persist_failed` | the Session exists but the grant write failed; retry with the same key to repair |
| 502 | `workspace_grant_failed` | the workspace is registered but the grant write failed (`manual_reconcile`) |
| 502 | `workspace_unresolved`, `create_returned_no_session_id`, `session/workspace-attach-failed` | the official call half-succeeded; reconcile before retrying |
| 400 | `missing_path`, `invalid_path`, `missing_directory`, `missing_parent`, `not_a_directory`, `unreadable_path`, `create_failed` | path resolution (`autonomy.js:210-259`) |

### Operation record

Every operation is appended to `workspace-autonomy.jsonl` with 17 fixed keys: `at`, `op`, `operation` (`workspace` or `session`), `workspace_id`, `path`, `task_id`, `purpose`, `session_id`, `preset`, `access`, `client_request_key`, `parent_key`, `request_hash`, `request`, `phase`, `result`, `reason` (null when a field does not apply), plus `receipt` on a success line and `revoked` on a revoke line. Lines split into **bindings** (`workspace_create`/`workspace_reuse`/`workspace_grant_failed`, `session_create`/`session_grant`/`session_grant_failed`) that answer a caller's request and own its key, and **evidence** (`workspace_task_confirmed`, `workspace_revoke`) that never binds a key and never downgrades a binding. No bearer, no secret, no message text. A failed append never rolls back a durable grant: the response reports `recorded: false` with `record_error`. `purpose` is stored verbatim, so callers must not put confidential material in it.

### First start

A profile that has never paired anything has an empty or absent allowlist (`{"version":1,"workspaceAllowlist":[],"sessionAllowlist":[]}` or no file at all). The Host only starts a listener for that when all of these hold:

1. the policy is **really effective** (`workspace_autonomy.effective: true`, not merely a flag that exists);
2. a long-lived host secret of at least 32 characters is readable (`secretFile` or `secretEnv`);
3. the official Desktop services are mounted (`sessionController`, `workspaceRegistry`, `sessionQuery`);
4. the bind is `127.0.0.1`;
5. the allowlist file is either absent or a valid, empty one — a zero-byte, unparseable or structurally invalid file stays `allowlist_unreadable`.

Nothing is pre-seeded: the first start writes no grant, and the allowlist file is created by the first successful grant. No armed bootstrap window is needed and none is implied; an armed window still opens the port without a policy, exactly as before, and it is **not** a way to bypass an ineffective policy (`policy.js:51-56`, `index.js:22-47`).

Every other refusal keeps its original reason: default off with an empty allowlist → `no steady allowlist and no armed bootstrap`; missing secret, missing services, non-loopback bind → their existing messages; unreadable allowlist → `allowlist_unreadable`. The startup result (the value `apply` returns, visible in the Desktop log) also reports `autonomy: {configured, enabled, effective, reason}`.

### Isolated-profile verification

Verify in a throwaway profile, never in the production Desktop profile. Replace `<profile>` with your own name and pick ports that no running instance uses (`8765`, `3082`, `3084` and `3088` are commonly taken).

```powershell
# 1. Create the profile from a template WITHOUT starting a service (--dump-config prints and exits).
$dsh = Read-Host 'path to the Desktop runtime dsh.cmd'
& $dsh <profile> --from-default-profile web --dump-config

# 2. Link the plugin and the preset bundle into that profile only.
& $dsh plugin --profile <profile> add "link:<repo>/plugins/dsh-control-bridge-host"
& $dsh plugin --profile <profile> add "link:<repo or preset dir>"

# 3. Add the Host row to the profile's cordis.patch.yml: bind 127.0.0.1, a free port,
#    its own state dir, workspaceAutonomy: true, and an empty allowlist (no bootstrap files).

# 4. Start the isolated profile, then read the policy from another terminal.
& $dsh <profile> --no-open
$env:DSH_BRIDGE_SECRET_FILE = '<state dir>/host.secret'
python desktop.py health --port <port>     # expect workspace_autonomy.effective = true, operations = 0
```

Acceptance in the isolated profile: `workspace_autonomy.effective: true`; the empty allowlist file is still empty after startup (nothing pre-seeded); `create-workspace` with `task_id`+`purpose` on a directory outside `workspaceRoots` returns `started_task:false`; `create-session` with `access:"write"` and `agent_preset:"master-control"` returns a verified receipt; a replay with the same key returns `deduplicated:true`; `revoke-workspace` returns `directory_intact:true` and the directory still exists; a replay after the revoke returns `409 authorization_stale`.

When it is effective, the behaviour that is **not** visible from the shapes alone:

- Every autonomy write must carry `task_id` (1..200) and `purpose` (1..500) after trimming; blank or missing is `400 task_required`. `client_request_key` is optional and only buys replay protection.
- A workspace request canonicalizes the path with `fs.realpathSync.native`, serializes per canonical path, resolves → creates → resolves again for the authoritative id, and takes a workspace grant (`source: 'autonomy'`). The **first** task that takes a workspace keeps it: a later task rewrites neither `task_id` nor `purpose` on the workspace grant (`grants.js:290-305`), and its ownership is recorded on its own Session grant.
- `confirm_task: true` is the only way to take over a workspace owned by another task. It journals `workspace_task_confirmed` with `client_request_key: null` and `parent_key` pointing at the request, so the confirmation is evidence and never answers a later replay.
- The first write Session in a workspace is allowed; `agentPresets.resolve` and the projection proof are never skipped, and the workspace must still carry a grant before a Session may join it (autonomy relaxes the first-write rule, not the grant). A busy Session is never cancelled or reused.
- Retry semantics: a completed `client_request_key` replays its receipt (`deduplicated: true`) **only while the authorization behind it still exists**. A Session that was created but could not be granted is repaired by the same key (`500 grant_persist_failed` + `manual_reconcile`, then `repaired: true`) without creating a second Session; a workspace that was registered but could not be granted is repaired on the same path without a second registration; a Session create that failed after the path was registered is retried by the same key and creates the Session on that one workspace.
- A key answers one operation with one set of arguments. Reusing it for a different operation (workspace vs session) or different `task_id`/`purpose`/`path`/`workspace_id`/`agent_preset`/`access`/`model`/`confirm_task` is `409 idempotency_key_reused` with `previous_operation` and `mismatched`, never a silent replay. The internal workspace registration performed for a Session request does **not** consume the Session's key: it records `client_request_key: null` and points back through `parent_key`.
- A replay is refused when the grant it relied on changed: `409 authorization_stale` with `current` = `revoked` / `missing` / `access_changed` / `task_changed` and a `historical` summary of the old receipt. Withdrawing and replaying therefore cannot resurrect the grant, and a repair cannot re-authorize a revoked workspace.
- The journal is read into memory once when the server is constructed; a damaged line is skipped and its neighbours still count (`autonomy.js:361-375`). A failed append is reported as `recorded:false` with `record_error` and never rolls back a grant that is already durable.

The guarded 0.2.0 path is untouched: without `workspaceAutonomy` every request and response keeps its exact old shape.

## Outbound completion webhook (0.2.0, off by default)

Observation over loopback does not wake a coordinator, so 0.2.0 adds a durable **uplink**: an official terminal outcome (or `needs_input`) is written to a persistent outbox and POSTed to one authenticated HTTPS receiver. It is not the official inbound webhook that creates Sessions, and it is not enabled unless configured:

```yaml
    webhook:
      enabled: true
      url: https://receiver.example/dsh/complete
      secret: <shared HMAC secret>
      allowedHosts: [receiver.example]
      eventTypes: [completed, failed, cancelled, needs_input, unknown]
      maxAttempts: 6
```

- `event_id` is stable (`request_id + type + session + turn`), retries/restarts keep it, and the receiver must dedupe on it.
- Payload is minimal status only: `request_id`, `rpc_id`, `turn`, `terminal`, `completed`, `outcome_scope`, `sequence`, `occurred_at`. No message text, history, title, cwd, workspace name, session id or credential.
- Headers: `x-dsh-event-id`, `x-dsh-event-type`, `x-dsh-timestamp`, `x-dsh-signature: sha256=HMAC-SHA256(secret, timestamp + "." + body)`.
- HTTPS only; userinfo/fragment rejected; optional host allowlist; DNS resolution must be public (SSRF guard). Outbox is atomic and fsynced, with bounded exponential retry.
- `completed`, `failed`, `cancelled`, `needs_input`, `unknown` are distinct; `bridge_timeout` is opt-in and always `completed:false`; `accepted` never produces a completion event.
- No receiver URL or secret exists on this machine, so **no end-to-end delivery has been proven**. `GET /v1/outbox` exposes status metadata only; the loopback query remains the fallback.

The official `SessionSummary` has no `profile` field. This plugin is only mounted in the desktop profile, so `profile: "desktop"` is an installation assumption; rows carry `profile_source: "plugin_profile_assumption"` when the row itself did not say.

## Authorization

One store (`grants.js`) is the single authority for memory and disk:

- every mutation is written atomically (temp file + rename) **before** it becomes visible; a failed write returns 5xx and leaves the in-memory grants unchanged;
- `select` merges into the existing allowlist (a repeated pairing never deletes an earlier grant);
- `POST /v1/revoke` is the only path that removes a grant;
- the file is re-read when its mtime/size changes, so a script that rewrites `allowlist.json` does not need a restart;
- every read endpoint (`/v1/granted`, `/v1/workspaces`, `/v1/sessions`, `/v1/history`, `/v1/resume`, `/v1/access`) authorizes from the same snapshot.

## Resume semantics

`POST /v1/resume` is "accepted, then collected":

1. authorize write access, refuse a running session without cancelling it;
2. resolve the model route: optional `model` is set and read back, otherwise `next` is used; refuse an unknown route, a missing adapter, or a selection that changed since the preflight — all before `prompt()`;
3. record the log watermark, then `prompt(..., mode: "queue")`;
4. poll the log (500 ms growing to 2 s, deadline 120 s) for the turn whose `user/message` carries this request's `source.rpcId`;
5. return `completed: true` with the assistant text of **that** turn, or `completed: false` with `final.reason.kind` of `timeout` / `unattributed_turn` / `model_mismatch` (plus the HTTP-level error captured from `turn/end`, e.g. `NO_ADAPTER`).

`text` never comes from the `prompt()` return value, because the official value carries no text. `POST /v1/wait/stop` only stops this bridge's wait; the accepted prompt stays in the Desktop queue. `POST /v1/cancel` is the official owned-turn cancel: it calls `sessionController.cancel({ sessionId })` only when the log proves the open turn carries this request's `rpcId`, refuses a session without a live Agent (`409 agent_not_attached`, nothing called), re-reads the log immediately before the call and refuses with `409 ownership_changed` if the turn moved, and never rewrites an already finished turn. A cancellation receipt is not a terminal state; the official `turn/end` is.

## Pairing re-arm and live authorization

The pairing window is a file, not process state. `bootstrap.json` (secret, expiry, consumed flag, retired-secret hash) and `bootstrap.secret` are read again on every request, so an operator can re-arm the window and pair another session while Desktop keeps running:

- a window is armed only while its remaining life is at most 60 minutes, it is unexpired and unconsumed, and its secret is at least 32 characters;
- `bootstrap.json` is authoritative; a non-empty `bootstrap.secret` that disagrees with it is an inconsistent window and fails closed, so a stale file cannot shadow a re-armed JSON secret (write both copies, or clear the legacy file);
- `POST /v1/bootstrap/select` is serialized and spends the window compare-and-swap style: only the secret that authenticated the request is retired, and a window re-armed meanwhile stays armed; a failed grant write leaves the window armed;
- the spent-window hash is written in the same atomic file as the grant, so even if the bootstrap-file write itself fails, one window cannot produce a second grant; a spent window retires the secret (the file keeps only its SHA-256), so a replay reads `403 bootstrap_consumed`; expiry and invalid/unreadable JSON fail closed;
- pairing merges one selected session into `allowlist.json`; existing grants are never lost, and revoke stays the only removal path; the response names the written grant in `granted`;
- the long-lived host secret is never rotated by re-arming or pairing;
- `GET /v1/health` reports `bootstrap_status`, `bootstrap_armed`, `bootstrap_consumed`, `bootstrap_retired`, and `bootstrap_expires_at`, so an operator can confirm the re-arm without restarting anything. Health and membership require the host secret; the window reaches only the two bootstrap routes.

`Rearm-DesktopHostBootstrap.ps1` writes only `bootstrap.secret` and `bootstrap.json`, verifies that `host.secret` and `allowlist.json` did not change, and prints the next pairing command. The running Host picks it up on the next request. `Prepare-DesktopHost.ps1` keeps an existing `host.secret` instead of rotating it.

## Compatibility

Target shape: Desktop profile whose host exposes `@deepseek-ai/dsh-api-session-controller` `prompt(request, signal)`, `list(request, signal)`, and `sessionQuery.readSession`, as documented for the 0.2.2 controller. The operator-observed CLI is 0.2.2-rc.5. The installed 0.2.2-rc.5 sources were reviewed for this release; the API-level findings and the fixture-only gaps are in `docs/official-host-contract.md`. Host 0.1.5 had one authorized existing-session resume on that Desktop. The anonymous record and the items still unverified are in `docs/verified-scope.md`. In-process fixtures are not that machine. Workspace autonomy from this branch has fixture evidence only: the live row is stated separately in `docs/verified-scope.md` and is **not** a pass.

## Install and rollback

Quit Desktop from the tray first. The bridge does not quit it. The tray's **Quit DeepSeek Harness** asks the Host about unfinished work before exiting; there is no supported external quit command, so the tray is the only path.

```text
dsh plugin --profile desktop add dsh-control-bridge-host-0.2.2.tgz
```

`Prepare-DesktopHost.ps1` writes secrets and a 20-minute bootstrap file under `desktop-host-local` in the unpacked tree. It does not set a machine environment variable, and it keeps an existing host secret instead of rotating it. An empty allowlist with no armed bootstrap does not open the port, unless the operator's workspace autonomy policy is effective (see **First start** above). After Desktop is open, `Pair-DesktopHost.ps1` lists sessions by title, directory, busy flag, and model. `Pair-DesktopHost.ps1 -Index 1` writes one read grant and revokes the bootstrap secret. That choice does not start a task. Write is refused while the session is busy. To pair another session later, `Rearm-DesktopHostBootstrap.ps1` arms a fresh window; Desktop does not need to be quit or restarted.

Rollback: quit Desktop, run `dsh plugin --profile desktop remove dsh-control-bridge-host`, delete that patch row if one remains, restore the previous `allowlist.json` only if the grants written by this install must be discarded, and reopen Desktop. Never restore an older profile backup over changes the operator made afterwards. Host 0.2.2 was exercised on Windows Desktop. The Codex skill created two verified master-control sessions in the same paired workspace, dispatched a local fixture to one and observed official completion. An existing session also resumed. See the anonymized results in `docs/verified-scope.md` in the source repository.

The listener binds to `127.0.0.1`. Outbound completion webhooks are opt-in.

## Rerun the regression

CI runs exactly these eight files, and the autonomy and first-start suites are loaded by `create.test.js` through `import './autonomy-cases.js'` and `import './startup-cases.js'`. Re-running the same command therefore executes them too — a local run with a different file list would not prove what CI proves:

```text
node --test --test-force-exit plugins/dsh-control-bridge-host/test/host.test.js plugins/dsh-control-bridge-host/test/official-contract.test.js plugins/dsh-control-bridge-host/test/lifecycle.test.js plugins/dsh-control-bridge-host/test/rearm.test.js plugins/dsh-control-bridge-host/test/control.test.js plugins/dsh-control-bridge-host/test/create.test.js plugins/dsh-control-bridge-host/test/paths.test.js plugins/dsh-control-bridge-host/test/webhook.test.js
python -m pytest tests -q
python examples/e2e_fake.py
```

`*-cases.js` files are not `--test` entry points: they are modules that register tests when imported, the same pattern as `first-turn-cases.js`.
