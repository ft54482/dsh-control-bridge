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

It does not call `selectModel`, so it does not replace the session's recorded provider. The model shown for a session is the session's own recorded selection from the `modelSelection` projection (`next ?? lastUsed`); only when a session has no recorded selection does it fall back to the host's `agentDefaultModel.currentSelection()`, and that fallback is labelled `model_source: "agent_default"`. A session with neither is `model_source: "unresolved"` with a `null` model — it is never presented as resolved. The plugin does not read `.credentials.yaml` and does not read the Desktop launch token.

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
2. record the log watermark, then `prompt(..., mode: "queue")`;
3. poll the log (500 ms growing to 2 s, deadline 120 s) for the turn whose `user/message` carries this request's `source.rpcId`;
4. return `completed: true` with the assistant text of **that** turn, or `completed: false` with `final.reason.kind` of `timeout` / `unattributed_turn`.

`text` never comes from the `prompt()` return value, because the official value carries no text. `POST /v1/cancel` only stops this bridge's wait; the accepted prompt stays in the Desktop queue and the plugin never calls the official `sessionController.cancel` (that would cancel the operator's own turn).

## Compatibility

Target shape: Desktop profile whose host exposes `@deepseek-ai/dsh-api-session-controller` `prompt(request, signal)`, `list(request, signal)`, and `sessionQuery.readSession`, as documented for the 0.2.2 controller. The operator-observed CLI is 0.2.2-rc.5. The 0.1.4 code was verified against the official TypeScript sources inside `app.asar` and against in-process fixtures; it has not yet been installed over a live Desktop (see the repository report).

## Install and rollback

Quit Desktop from the tray first. The bridge does not quit it. The tray's **Quit DeepSeek Harness** asks the Host about unfinished work before exiting; there is no supported external quit command, so the tray is the only path.

```text
dsh plugin --profile desktop add dsh-control-bridge-host-0.1.4.tgz
```

`Prepare-DesktopHost.ps1` writes secrets and a 20-minute bootstrap file under `desktop-host-local` in the unpacked tree. It does not set a machine environment variable. An empty allowlist with no armed bootstrap does not open the port. After Desktop is open, `Pair-DesktopHost.ps1` lists sessions by title, directory, busy flag, and model. `Pair-DesktopHost.ps1 -Index 1` writes one read grant and revokes the bootstrap secret. That choice does not start a task. Write is refused while the session is busy.

Rollback: quit Desktop, run `dsh plugin --profile desktop remove dsh-control-bridge-host`, delete that patch row if one remains, restore the previous `allowlist.json` only if the grants written by 0.1.4 must be discarded, and reopen Desktop. Never restore an older profile backup over changes the operator made afterwards.

The listener is `127.0.0.1` only. It has no outbound call.
