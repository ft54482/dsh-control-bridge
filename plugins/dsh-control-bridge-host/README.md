# dsh-control-bridge-host

MIT. A Desktop-profile bundle for `dsh-control-bridge`. It is not a DeepSeek product.

The loopback bearer and the choice to call `sessionController` inside the Host, instead of the browser token, follow the MIT-licensed project [ft54482/dsh-agent-bridge](https://github.com/ft54482/dsh-agent-bridge). This package is a separate implementation and does not include that project's code.

## What it calls

Inside a Desktop Host that has already mounted the official services, the plugin uses:

- `workspaceRegistry.list` to list allowlisted workspaces
- `sessionController.list` to list allowlisted sessions
- `sessionQuery.readSession` to page history
- `sessionController.prompt(request, AbortSignal)` with `mode: "queue"` to continue that same session id

It does not call `selectModel`, so it does not replace the session's recorded provider. An example-provider / example-model selection already stored on the session stays the host's selection. The plugin does not read `.credentials.yaml` and does not read the Desktop launch token.

`sessionController` is part of the Desktop Host because Desktop runs the Web Host. The headless profile does not mount it. If the service is missing, `apply` returns without listening and without throwing, so a headless profile is not crashed and is not described as Desktop.

## Compatibility

Target shape: Desktop profile whose host exposes `@deepseek-ai/dsh-api-session-controller` `prompt(request, signal)`, `list`, and `sessionQuery.readSession`, as documented for the 0.2.2 controller (`events` replaced `page` in 0.2.2-rc.1). The operator-observed CLI is 0.2.2-rc.5. This repository has not attached to a live Desktop process. A passing Web-profile load is not Desktop verification.

## Install and rollback

Quit Desktop from the tray first. The bridge does not quit it.

```text
dsh plugin --profile desktop add dsh-control-bridge-host-0.1.1.tgz
```

`Prepare-DesktopHost.ps1` writes secrets and a 20-minute bootstrap file under `desktop-host-local` in the unpacked tree. It does not set a machine environment variable. An empty allowlist with no armed bootstrap does not open the port. After Desktop is open, `Pair-DesktopHost.ps1` lists sessions by title, directory, busy flag, profile, and model. `Pair-DesktopHost.ps1 -Index 1` writes one read grant and revokes the bootstrap secret. That choice does not start a task. Write is refused while the session is busy.

Rollback: quit Desktop, run `dsh plugin --profile desktop remove dsh-control-bridge-host`, delete that patch row if one remains, and reopen Desktop.

The listener is `127.0.0.1` only. It has no outbound call.
