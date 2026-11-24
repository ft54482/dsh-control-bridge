# Desktop commands

Examples use `desktop.py` from `scripts/`. Use `--data` with a UTF-8 JSON file or `--data -` to read a UTF-8 JSON object from stdin. A file keeps multiline prompts and Windows paths out of shell interpolation. For queries, use repeatable `--param KEY=VALUE`.

The helper reads the bearer from the file named by `DSH_BRIDGE_SECRET_FILE`, then from `secret_file` in a private `connection.json` beside the script, then from `~/.dsh/state/desktop-host-local/host.secret`, in that order. It talks to `127.0.0.1:8765` unless you pass `--port`; pass it on **every** call (read, create, resume, revoke) when the Host uses another port. `--timeout` defaults to 135 s.

| Command | Parameters or JSON body | Minimum Host |
| --- | --- | --- |
| `health`, `granted`, `workspaces`, `membership` | None | 0.1.6 |
| `sessions` | `workspace_id` | 0.1.6 |
| `history` | `session_id`, optional `offset`, `limit` | 0.1.6 |
| `models` | `session_id` | 0.1.6 |
| `request` | `request_id`, `session_id` | 0.1.6 |
| `resume` | `session_id`, `request_id`, `text`, optional `model` object | 0.1.6 |
| `cancel`, `stop-wait` | `session_id`, `request_id` | 0.1.6 |
| `set-model` | `session_id`, `provider`, `model`, optional `reasoning_effort` | 0.1.6 |
| `set-access` | `session_id`, explicit `access` (`read` or `write`) for an existing grant | 0.1.6 |
| `discover` | Optional `workspace_id`, `kind`, `status`, `offset`, `limit` | 0.2.0 |
| `model-catalog`, `outbox` | Optional `limit` for `outbox` | 0.2.0 |
| `events`, `wait`, `stream` | `--request-id ID`, optional `timeout_ms` for `events` and `wait`, `after_seq` for `events`, `--last-event-id N` for `stream` | 0.2.0 |
| `create-workspace` | `path`, optional `title`, `create_directory`; under the autonomy policy also `task_id`, `purpose`, optional `confirm_task`, `client_request_key` | 0.2.0 (task fields: this release) |
| `create-session` | `workspace_id` or `path`, optional `title`, `access`, `model`, `agent_preset`; under the autonomy policy also `task_id`, `purpose`, optional `confirm_task`, `client_request_key`. Harness assigns a fresh session ID. | 0.2.1 with verified preset creation (task fields: this release) |
| `revoke-workspace` | `workspace_id` (required, nonempty) | this release |
| `open` | `path`, optional `action` (`reveal`) | 0.2.0 |

```powershell
python desktop.py discover --param workspace_id=WORKSPACE --param kind=top --param limit=25
python desktop.py granted
python desktop.py history --param session_id=SESSION --param offset=0 --param limit=5
python desktop.py resume --data task.json
python desktop.py request --param session_id=SESSION --param request_id=REQUEST
python desktop.py wait --request-id REQUEST --param timeout_ms=20000
python desktop.py stream --request-id REQUEST --last-event-id 0
```

The uppercase IDs stand for values returned by your Host. For a continuation, match the task against the authorized history, check that the session belongs to the intended workspace, is idle and grants `write`, then use the **same session ID** in `task.json`. Use a fresh request ID and the authorized task text for that turn. If history reading failed, resolve the grant or service error before drawing a conclusion about prior work.

## New work in master-control mode

The preset is a Harness profile dependency shared by that profile's workspaces. In the same Harness profile, open **Plugins → Add plugin** and install your trusted local preset bundle. When the plugin manager tools are available, you can also use `install_bundle` and check `list_plugins`. Open a blank session in the target workspace and verify **主控模式** appears in its preset picker. The bundle must register `master-control` as the preset ID. Installing the Codex skill supplies its bridge commands. The preset's persona and tool permissions come from the Harness installation.

The Codex helper adds `agent_preset: "master-control"` even if its `create-session` input contains only `workspace_id`, and verifies the resulting session. Direct callers of the Host's HTTP `POST /v1/sessions` retain its existing behavior when they omit `agent_preset`. Use the helper for the Codex workflow.

1. Check `health` for `preset_create_verified: true` and identify the target with `workspaces`. Use Host 0.2.2 for an entirely skill-driven first turn in a new master-control session. Enable `allowCreateSession`. A verified session can be created in a paired workspace under the existing `workspaceRoots`; for a paired workspace outside them, add **only its exact ID** to `presetSessionWorkspaceIds`. The registered directory must match the paired directory. A new write session additionally requires an existing write grant in that workspace. Keep the roots for filesystem operations as configured. Host 0.2.1 only supports preset creation under its configured roots; older Hosts can continue existing authorized sessions. **Exception:** when the operator has enabled `workspaceAutonomy` and `health.workspace_autonomy.effective` is `true`, a task-scoped request relaxes exactly those two requirements (pre-existing write grant, root containment) and nothing else — see [Task-scoped autonomy](#task-scoped-autonomy).
2. Create a UTF-8 `new-session.json` locally with the body below. Replace `WORKSPACE` with the confirmed workspace ID. Choose `write` when you intend to submit a task. Omitted access defaults to `read`.

   ```json
   {"workspace_id":"WORKSPACE","access":"write","agent_preset":"master-control"}
   ```

3. Run `python desktop.py create-session --data new-session.json`. Keep the returned `session_id`. Require a successful response with the intended `workspace_id`, `agent_preset: "master-control"` and `agent_preset_source: "session_projection"`. This verifies the selected preset recorded by Harness. Creation itself does not submit the task.
4. If creation reports a missing preset, an unavailable capability, a mismatched selection, or an uncertain outcome, stop before sending a prompt. If a session ID was returned, retain it and reconcile it with the workspace and grants before any retry. After verified creation, use that ID, the authorized task and a new request ID in `task.json`:

   ```json
   {"session_id":"SESSION","request_id":"NEW-REQUEST-ID","text":"Summarize the repository layout."}
   ```

**Manual option for older Hosts.** In Harness Desktop, create a blank session in the intended workspace and select **主控模式** in that session's preset picker. Reopen the same session and verify the preset label beside its title displays **主控模式** or `master-control`. Pair that exact session and confirm its ID and write grant before using the existing-session `resume` flow. This route requires observed Desktop confirmation. An installation default or the unconfirmed selection in the picker cannot verify the individual session.

## Task-scoped autonomy

This section applies only when the operator has enabled `workspaceAutonomy` in the Host plugin and `GET /v1/health` reports `workspace_autonomy.effective: true`. Without an effective policy the commands keep their 0.2.2 behaviour for callers that carry no task intent; a call that carries `task_id`/`purpose` on such a Host is refused with `403 workspace_autonomy_not_effective` (including a Host that never configured the switch), so the task fields are not "ignored" by the guarded path.

### Health gate

`health` always declares the policy:

```json
"workspace_autonomy": {"configured": true, "enabled": true, "effective": true, "reason": null,
  "require_task": true, "roots_mode": "unrestricted", "grant_store": "file",
  "record_file": "<state dir>/workspace-autonomy.jsonl", "operations": 0}
```

`effective` is the conjunction `enabled && allowlistFile configured && workspaceRegistry.create callable && sessionController.create callable && sessionController.projections callable`. `reason` names the first missing piece: `not_configured`, `disabled`, `allowlist_file_missing`, `workspace_create_unavailable`, `session_create_unavailable`, `session_projections_unavailable`. A task-intent write is refused with `403 workspace_autonomy_not_effective` whenever `effective` is not `true` — `not_configured` included. The helper checks the same thing and exits 1 with `workspace_autonomy_not_effective` before sending a write.

### `create-workspace` with a task

```json
{"path":"D:\\ws-lab\\outside\\alpha","task_id":"TASK","purpose":"PURPOSE","create_directory":true,"client_request_key":"KEY"}
```

- `task_id` 1..200 chars and `purpose` 1..500 chars after trimming; blank or missing is `400 task_required`. `purpose` is stored verbatim in the operation journal.
- `path` must be absolute; the Host resolves it with `fs.realpathSync.native`. A missing leaf is created only with `create_directory:true`, and only one level under an existing parent (`400 missing_parent` otherwise).
- `workspace_id` is the registry's authority after create; the receipt repeats it in `workspace_id`, `workspace`, `path` and `grant`.
- Receipt: `ok`, `workspace_id`, `workspace{id,title,path}`, `path`, `created`, `reused`, `created_directory`, `task{task_id,purpose,confirmed,previous_task_id}`, `grant{workspace_id,path}`, `autonomy{enabled,effective}`, `started_task:false`, `recorded`.
- The helper verifies `ok`, `started_task:false`, one identity across `workspace_id`/`workspace.id`/`grant.workspace_id` and `workspace.path == path`; anything else exits 1 with `workspace_receipt_unverified` and `manual_reconcile`.

### `create-session` with a task

```json
{"path":"D:\\ws-lab\\outside\\alpha","task_id":"TASK","purpose":"PURPOSE","agent_preset":"master-control","access":"write","client_request_key":"KEY"}
```

- Name either `path` (registered first, then the Session is created) or `workspace_id`. `access` defaults to `read`; `write` is explicit.
- The helper always sends `agent_preset` (default `master-control`) for `create-session` and rejects `session_id` in a create body; `access` must be `read` or `write`.
- Order inside the Host: register/grant the workspace → validate the requested model → `sessionController.create` → prove `agentPreset` through `sessionController.projections` → grant the Session. A preset that does not resolve to that exact id is `409 agent-preset/invalid`; a projection that does not read back the preset is `409 agent_preset_unverified` (the Session exists; inspect it in Desktop, do not retry creation).
- Receipt adds `task_id`, `purpose`, `agent_preset`, `agent_preset_source:"session_projection"`, `grant{session_id,workspace_id,access,cwd,task_id,source}`, `model`, `revision`, `workspace_created`, `workspace_reused`, `deduplicated:false`, `started_task:false`, `recorded` (+ `repaired:true` when the call repaired a missing grant).
- The helper verifies the preset receipt and, when `task_id` is present, also `task_id` equality plus one identity across `session_id`, `workspace_id`, `access`, `grant(session_id,workspace_id,access)`; a mismatch exits 1 with `task_receipt_unverified`.

### `revoke-workspace`

```json
{"workspace_id":"WORKSPACE"}
```

Removes the workspace grant and every Session grant under it in one atomic write; returns `workspace_id`, `revoked{workspace,sessions}`, `directory_intact`, `started_task:false`, `revision`. It never deletes a directory, never cancels a turn, and the helper refuses an unverified receipt (`revoke_receipt_unverified`).

### Task ownership, busy Sessions, idempotency

- A different `task_id` on a workspace that already belongs to one is `409 workspace_task_mismatch` (`existing_task_id`, `task_id`); pass `confirm_task:true` to take it over. The takeover journals `workspace_task_confirmed`, the workspace grant keeps the first task, and the new task is recorded on the Session grant.
- A busy Session is never cancelled or reused.
- `client_request_key` is global and bound to one operation plus one argument set (`task_id`, `purpose`, `path`, `workspace_id`, `agent_preset`, `access`, `model`, `confirm_task`). Same key with another operation or other arguments → `409 idempotency_key_reused`. Same key, same arguments, authorization intact → `200` with `deduplicated:true`. Same key after revoke / downgrade / task change → `409 authorization_stale` with `historical` and a top-level `current` string.

### Error codes and exit codes

Host reasons this flow can return: `task_required`, `invalid_client_request_key`, `workspace_autonomy_not_effective`, `workspace_task_mismatch`, `workspace_grant_failed`, `grant_persist_failed`, `missing_workspace_id`, `workspace_revoke_failed`, `agent-preset/invalid`, `agent_preset_unverified`, `idempotency_key_reused`, `authorization_stale`, plus the pre-existing path/registry codes. The full table is in [host-api.md](../../../docs/host-api.md).

`desktop.py` exit codes: `0` success, `1` an HTTP error / `ok:false` / an unverified receipt, `2` invalid local input or a transport error. Every response is one JSON object on stdout; a 2xx body that fails receipt verification is rewritten into the failure shape above.

<!-- ZCode mirror: the skills/zcode/** copy arrives with the feat/zcode-skills branch (PR14) and is not part of this change. After it merges, mirror these semantics there; do not edit PR14 files from this branch. -->

On 0.1.6 `resume` may block until the bridge's wait expires. Keep the command running in the background while checking the same request. For 0.2.0 SSE the helper emits one JSON object per frame with `event`, `id`, and `data`. Keep the last nonempty `id` to reconnect. After a stream ends, read `request` for the official outcome and full result. `stop-wait` affects bridge observation only. `cancel` is for the exact owned active request and final cancellation still requires an official terminal record.

For new workspaces, put the path below an explicitly authorized root — unless the autonomy policy is effective, where a task-scoped request may name any absolute directory this account can write. `create_directory:true` permits creating the last path component. For a new session, retain the returned ID before any retry. If creation times out, check discovery and the grants first. Check history access separately from catalog visibility.

An unavailable Host returns a local connection error. A denied grant, disabled feature or unmounted service needs the corresponding Desktop authorization or configuration. For operations and exact wire shapes, see `docs/host-api.md` and `docs/windows-delivery.md` in the bridge repository. An enabled outbox indicates local sender configuration. End-to-end delivery also requires a verified receiver event and user-visible notification.

`health` describes services and grants. It does not certify the runtime version or live acceptance. Inspect the installed plugin manifest for the version. `request` looks up a known request/session pair. The Desktop API does not enumerate the latest bridge requests for a session.
