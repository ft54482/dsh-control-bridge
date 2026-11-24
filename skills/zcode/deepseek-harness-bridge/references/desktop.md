# Desktop commands

Examples use `desktop.py` from `scripts/`. Use `--data` with a UTF-8 JSON file or `--data -` to read a UTF-8 JSON object from stdin. A file keeps multiline prompts and Windows paths out of shell interpolation. For queries, use repeatable `--param KEY=VALUE`.

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
| `create-workspace` | `path`, optional `title`, `create_directory` | 0.2.0 |
| `create-session` | `workspace_id`, optional `title`, `access`, `model`, `agent_preset`. Harness assigns a fresh session ID. | 0.2.1 with verified preset creation |
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

1. Check `health` for `preset_create_verified: true` and identify the target with `workspaces`. Use Host 0.2.2 for an entirely skill-driven first turn in a new master-control session. Enable `allowCreateSession`. A verified session can be created in a paired workspace under the existing `workspaceRoots`; for a paired workspace outside them, add **only its exact ID** to `presetSessionWorkspaceIds`. The registered directory must match the paired directory. A new write session additionally requires an existing write grant in that workspace. Keep the roots for filesystem operations as configured. Host 0.2.1 only supports preset creation under its configured roots; older Hosts can continue existing authorized sessions.
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

On 0.1.6 `resume` may block until the bridge's wait expires. Keep the command running in the background while checking the same request. For 0.2.0 SSE the helper emits one JSON object per frame with `event`, `id`, and `data`. Keep the last nonempty `id` to reconnect. After a stream ends, read `request` for the official outcome and full result. `stop-wait` affects bridge observation only. `cancel` is for the exact owned active request and final cancellation still requires an official terminal record.

For new workspaces, put the path below an explicitly authorized root. `create_directory:true` permits creating the last path component. For a new session, retain the returned ID before any retry. If creation times out, check discovery and the grants first. Check history access separately from catalog visibility.

An unavailable Host returns a local connection error. A denied grant, disabled feature or unmounted service needs the corresponding Desktop authorization or configuration. For operations and exact wire shapes, see `docs/host-api.md` and `docs/windows-delivery.md` in the bridge repository. An enabled outbox indicates local sender configuration. End-to-end delivery also requires a verified receiver event and user-visible notification.

`health` describes services and grants. It does not certify the runtime version or live acceptance. Inspect the installed plugin manifest for the version. `request` looks up a known request/session pair. The Desktop API does not enumerate the latest bridge requests for a session.
