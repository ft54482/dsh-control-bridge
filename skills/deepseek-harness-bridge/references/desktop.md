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
| `create-session` | `workspace_id`, optional `session_id`, `title`, `access`, `model` | 0.2.0 |
| `open` | `path`, optional `action` (`reveal`) | 0.2.0 |

```powershell
python desktop.py history --param session_id=SESSION --param limit=5
python desktop.py resume --data task.json
python desktop.py request --param session_id=SESSION --param request_id=REQUEST
python desktop.py wait --request-id REQUEST --param timeout_ms=20000
python desktop.py stream --request-id REQUEST --last-event-id 0
```

On 0.1.6 `resume` may block until the bridge's wait expires. Keep the command running in the background while checking the same request. For 0.2.0 SSE the helper emits one JSON object per frame with `event`, `id`, and `data`. Keep the last nonempty `id` to reconnect. After a stream ends, read `request` for the official outcome and full result. `stop-wait` affects bridge observation only. `cancel` is for the exact owned active request and final cancellation still requires an official terminal record.

For new workspaces, put the path below an explicitly authorized root. `create_directory:true` permits creating the last path component. For a new session, retain the returned ID before any retry. If creation times out, check discovery and the grants first. Check history access separately from catalog visibility.

An unavailable Host returns a local connection error. A denied grant, disabled feature or unmounted service needs the corresponding Desktop authorization or configuration. For operations and exact wire shapes, see `docs/host-api.md` and `docs/windows-delivery.md` in the bridge repository. An enabled outbox indicates local sender configuration. End-to-end delivery also requires a verified receiver event and user-visible notification.

`health` describes services and grants. It does not certify the runtime version or live acceptance. Inspect the installed plugin manifest for the version. `request` looks up a known request/session pair. The Desktop API does not enumerate the latest bridge requests for a session.
