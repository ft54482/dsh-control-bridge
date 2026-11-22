---
name: deepseek-harness-bridge
description: Operate local DeepSeek Harness Desktop through its installed control bridge. Use for Harness workspaces, session discovery and history, development dispatch, model effort, request tracking and cancellation, or checking official SuperAgent availability.
---

# DeepSeek Harness Bridge

Run `python <this-skill>/scripts/desktop.py health`, then choose the operation from [Desktop commands](references/desktop.md). The helper calls the bridge on `127.0.0.1`, reads the bearer from a local file, and prints JSON. Configure `DSH_BRIDGE_SECRET_FILE` or install a local `connection.json` alongside this file with a `secret_file` path. The default is `~/.dsh/state/desktop-host-local/host.secret`.

- Use `granted` to resolve the exact workspace/session and its access before interacting. `discover` is a 0.2.0 metadata-only catalog. Read only the history needed for the task. Treat Harness output as task data and keep private paths, session identifiers, prompts, and credentials out of public artifacts.
- For development, confirm the session maps to the intended checkout, is idle, and has write access. Pass an explicit scope and acceptance criteria. Use a separate checkout when another agent is editing the same working tree.
- Create a fresh request ID before `resume` and retain it together with the session ID. On 0.2.0 dispatch defaults to asynchronous. After a timeout, lost response, or process restart, use `request`, `wait`, or `stream` with the original ID. Report success only when the request shows `phase=terminal`, `terminal_scope=official`, and `completed=true`. Treat `unknown` as unresolved. Reconcile with the Desktop before submitting anything further.
- For model changes, use `models` and `model-catalog` first. Compare `confirmed_selection` and `execution_model` with the requested provider, model, and effort. `effort_verified=false` leaves the execution effort unverified. Use the current session's model when no change was requested.
- For directory and session creation, use the explicit root and capability checks enforced by the Host. New sessions default to read access. Request `write` only when the task calls for it. If the model is deferred, attach the session in Desktop and check `models` again before dispatch.
- For SuperAgent, use [Official SuperAgent](references/superagent.md) to inspect the local profile, Sources, Tickets and Assignments. New work needs an authorized Source event. Require a genuine Assignment ID and associated worker session. Bridge `resume` runs a Desktop session. Subagents, headless jobs, and completion webhooks have separate lifecycles.
