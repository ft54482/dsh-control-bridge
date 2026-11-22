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
- `agents.get(sessionId).model.current()/select()` for the session-scoped model choice
- `llm.listProviders()`, `llm.listModels()`, `llm.resolveCallConfig()` to refuse an unavailable route before sending

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

`text` never comes from the `prompt()` return value, because the official value carries no text. `POST /v1/cancel` only stops this bridge's wait; the accepted prompt stays in the Desktop queue and the plugin never calls the official `sessionController.cancel` (that would cancel the operator's own turn).

## Compatibility

Target shape: Desktop profile whose host exposes `@deepseek-ai/dsh-api-session-controller` `prompt(request, signal)`, `list(request, signal)`, and `sessionQuery.readSession`, as documented for the 0.2.2 controller. The operator-observed CLI is 0.2.2-rc.5. Host 0.1.5 had one authorized existing-session resume on that Desktop. The anonymous record and the items still unverified are in `docs/verified-scope.md`. In-process fixtures are not that machine.

## Install and rollback

Quit Desktop from the tray first. The bridge does not quit it. The tray's **Quit DeepSeek Harness** asks the Host about unfinished work before exiting; there is no supported external quit command, so the tray is the only path.

```text
dsh plugin --profile desktop add dsh-control-bridge-host-0.1.5.tgz
```

`Prepare-DesktopHost.ps1` writes secrets and a 20-minute bootstrap file under `desktop-host-local` in the unpacked tree. It does not set a machine environment variable. An empty allowlist with no armed bootstrap does not open the port. After Desktop is open, `Pair-DesktopHost.ps1` lists sessions by title, directory, busy flag, and model. `Pair-DesktopHost.ps1 -Index 1` writes one read grant and revokes the bootstrap secret. That choice does not start a task. Write is refused while the session is busy.

Rollback: quit Desktop, run `dsh plugin --profile desktop remove dsh-control-bridge-host`, delete that patch row if one remains, restore the previous `allowlist.json` only if the grants written by this install must be discarded, and reopen Desktop. Never restore an older profile backup over changes the operator made afterwards. The machine-verified package is 0.1.5. A documentation commit does not replace that package.

The listener is `127.0.0.1` only. It has no outbound call.
