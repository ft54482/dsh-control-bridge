# dsh-control-bridge-host

MIT. A Desktop-profile bundle for `dsh-control-bridge`. It is not a DeepSeek product.

The loopback bearer and the choice to call `sessionController` inside the Host, instead of the browser token, follow the MIT-licensed project [ft54482/dsh-agent-bridge](https://github.com/ft54482/dsh-agent-bridge). This package is a separate implementation and does not include that project's code.

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

Paths are realpath-checked inside `workspaceRoots`: the root itself, sibling prefixes, `..`, and symlink escapes are refused. No delete endpoint is exposed.

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

Target shape: Desktop profile whose host exposes `@deepseek-ai/dsh-api-session-controller` `prompt(request, signal)`, `list(request, signal)`, and `sessionQuery.readSession`, as documented for the 0.2.2 controller. The operator-observed CLI is 0.2.2-rc.5. The installed 0.2.2-rc.5 sources were reviewed for this release; the API-level findings and the fixture-only gaps are in `docs/official-host-contract.md`. Host 0.1.5 had one authorized existing-session resume on that Desktop. The anonymous record and the items still unverified are in `docs/verified-scope.md`. In-process fixtures are not that machine.

## Install and rollback

Quit Desktop from the tray first. The bridge does not quit it. The tray's **Quit DeepSeek Harness** asks the Host about unfinished work before exiting; there is no supported external quit command, so the tray is the only path.

```text
dsh plugin --profile desktop add dsh-control-bridge-host-0.2.0.tgz
```

`Prepare-DesktopHost.ps1` writes secrets and a 20-minute bootstrap file under `desktop-host-local` in the unpacked tree. It does not set a machine environment variable, and it keeps an existing host secret instead of rotating it. An empty allowlist with no armed bootstrap does not open the port. After Desktop is open, `Pair-DesktopHost.ps1` lists sessions by title, directory, busy flag, and model. `Pair-DesktopHost.ps1 -Index 1` writes one read grant and revokes the bootstrap secret. That choice does not start a task. Write is refused while the session is busy. To pair another session later, `Rearm-DesktopHostBootstrap.ps1` arms a fresh window; Desktop does not need to be quit or restarted.

Rollback: quit Desktop, run `dsh plugin --profile desktop remove dsh-control-bridge-host`, delete that patch row if one remains, restore the previous `allowlist.json` only if the grants written by this install must be discarded, and reopen Desktop. Never restore an older profile backup over changes the operator made afterwards. The machine-verified package is still 0.1.5. Host 0.2.0 adds the durable request journal, long-poll/SSE delivery, global discovery, per-session effort control, and opt-in create/open on top of 0.1.6's request ledger and re-armable pairing window. Those 0.2.0 paths are fixture-tested only; no live Desktop install or live acceptance has been done.

The listener is `127.0.0.1` only. It has no outbound call.
