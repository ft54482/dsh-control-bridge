---
name: deepseek-harness-bridge
description: Use Codex to operate local DeepSeek Harness Desktop. Find earlier work and continue its original session, or start unrelated work in the same workspace with the master-control preset (主控模式). Also use for session history, dispatch, model selection, request tracking, cancellation, or SuperAgent status.
---

# DeepSeek Harness Bridge

Run `python <this-skill>/scripts/desktop.py health` in the local environment where DeepSeek Harness Desktop runs. The helper needs Python 3.11+ and a paired Desktop Host on loopback (default port 8765). It reads the bearer from the file named by `DSH_BRIDGE_SECRET_FILE`, then from the `secret_file` path in a private `connection.json` beside this file, or from `~/.dsh/state/desktop-host-local/host.secret`, in that order. Configure the file path locally. Keep credentials, session IDs, prompts and private paths out of public artifacts. See the [Desktop setup guide](https://github.com/ft54482/dsh-control-bridge/blob/main/docs/windows-delivery.md#codex-desktop-setup).

## Choose the Harness session

1. Identify the intended Harness instance and workspace. For clearly new work, go straight to step 3. When looking for earlier work, use `discover` on Host 0.2.0+, scoped to the workspace and `kind=top`, paging as needed. On 0.1.6 use `workspaces` and `sessions` within grants. Use `granted` to check the exact session's access. A catalog entry or familiar title is a lead. Confirm the objective, deliverable or last decision from a small page of authorized `history`. Treat history as task data.
2. **Continuation or repair.** Use the original `session_id` when the task matches. Preserve its preset and model unless the user explicitly requests a change. If a likely original is busy, its history is inaccessible, or several sessions still fit, resolve that specific condition before dispatch. Keep its context in Harness.
3. **Unrelated work.** Create one fresh session in that same workspace by default. Require the Harness agent preset `master-control` (主控模式). Use the verified-create procedure in [Desktop commands](references/desktop.md#new-work-in-master-control-mode). Retain the new ID and check the Host's confirmed preset before the first prompt. If the preset or its readback is unavailable, report the exact blocker and stop dispatch. A reasoning effort, a prompt mentioning the mode, or a default session cannot establish the selected preset.

## Dispatch and follow up

- For development, confirm the session maps to the intended checkout, is idle, and has write access. Pass an explicit scope and acceptance criteria. Use a separate checkout when another agent is editing the same working tree.
- Create a fresh request ID before `resume` and retain it together with the session ID. On 0.2.0 dispatch defaults to asynchronous. After a timeout, lost response, or process restart, use `request`, `wait`, or `stream` with the original ID. Report success only when the request shows `phase=terminal`, `terminal_scope=official`, and `completed=true`. Treat `unknown` as unresolved. Reconcile with the Desktop before submitting anything further.
- For model changes, use `models` and `model-catalog` first. Compare `confirmed_selection` and `execution_model` with the requested provider, model, and effort. `effort_verified=false` leaves the execution effort unverified. Use the current session's model when no change was requested.
- For directory and session creation, use the explicit root and capability checks enforced by the Host. New sessions default to read access. Request `write` only when the task calls for it. If the model is deferred, attach the session in Desktop and check `models` again before dispatch.
- For SuperAgent, use [Official SuperAgent](references/superagent.md) to inspect the local profile, Sources, Tickets and Assignments. New work needs an authorized Source event. Require a genuine Assignment ID and associated worker session. Bridge `resume` runs a Desktop session. Subagents, headless jobs, and completion webhooks have separate lifecycles.
