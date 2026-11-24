<img src="docs/assets/hero.jpg" alt="DSH Control Bridge — Codex / Grok Bot → DeepSeek Harness" width="100%">

# DSH Control Bridge

[<img src="docs/assets/languages/zh.png" alt="简体中文" height="26">](README.md) [<img src="docs/assets/languages/en.png" alt="English" height="26">](README.en.md) [<img src="docs/assets/languages/fr.png" alt="Français" height="26">](README.fr.md) [<img src="docs/assets/languages/ja.png" alt="日本語" height="26">](README.ja.md) [<img src="docs/assets/languages/ko.png" alt="한국어" height="26">](README.ko.md) [<img src="docs/assets/languages/de.png" alt="Deutsch" height="26">](README.de.md)

Project introductions and quick starts are available in six languages through the badges above. Detailed operating guides are currently mainly in Chinese. Commands, parameters and protocol fields retain their original spelling.

Let Codex, Grok Bot or your own coordinator assign work to a specific DeepSeek Harness workspace and track the results. **Already using Codex and Harness Desktop on the same computer? Start with the Codex skill and Desktop Host.** This path connects to the local Host and lets you operate it through natural-language requests in Codex after setup.

[Super Agent Cockpit](plugins/dsh-superagent-cockpit/README.md) · [Codex skill v0.2.3](https://github.com/ft54482/dsh-control-bridge/releases/tag/skill-v0.2.3) · [ZCode skills](skills/zcode/README.md) · [Desktop Host v0.2.2](https://github.com/ft54482/dsh-control-bridge/releases/tag/v0.2.2) · [Documentation index](docs/README.md) · [Ports and troubleshooting](docs/ports.md) · [Windows live acceptance](docs/verified-scope.md)

**The ZCode skills are finished (2026-11-25).** See the ZCode quick start below for installation and for what has been verified.

## Choose an entry point

| Your environment and goal | What to install or run | First check |
| --- | --- | --- |
| Use Codex Desktop to continue earlier work or open a master-control session for a new task | Install the **skill** in Codex and the **Host plugin** in the Harness desktop profile | Run `health` and `granted` through the skill. [Setup and pairing](docs/windows-delivery.md#codex-desktop-setup) |
| Use ZCode to continue a Desktop session, open a master-control session, or dispatch SuperAgent tickets | Copy the two **ZCode skill** directories into `~/.zcode/skills/`; the Host plugin is the same as on the Codex path | Run `desktop.py health` from the skill, then its three behaviour tests. [ZCode quick start](skills/zcode/README.md) |
| Use your own bot or script for multiple instances, an inbox, task approvals and auditing | Install the Python **coordinator** and operate it through the `dsh-bridge` CLI. Start `serve` when you need to receive signed HTTP events | Complete the draft, send and submission flow with fake first. [Coordinator guide](docs/coordinator.md) |
| Use an existing tool client to read the inbox or draft tasks through MCP | Have the client launch the same Python coordinator's `mcp` subcommand. v0.2.2 uses `Content-Length` message framing, which the client must support | Call `tools/list` with a compatible client. Clients that only support newline-delimited JSON can use the CLI first. [MCP configuration and tools](docs/coordinator.md) |
| Run independent ordinary Harness sessions in a terminal or CI | Configure the Python coordinator's `headless_cli` adapter and a separate headless profile | Check the configuration with the default `spawn = false` first. [Headless CLI](docs/headless-cli.md) |
| View task slots and each instance's tickets in Harness Desktop | Install the optional **Super Agent Cockpit** and start the bundled aggregator for multiple instances | The top area shows tasks from the master-control registry alongside the active session count. Instance cards show ticket executor occupancy. [Download and setup](plugins/dsh-superagent-cockpit/README.md) |
| Already have SuperAgent deployed and want to dispatch and track tickets from Codex | Use the skill's `github_source.py` to check the target instance, GitHub repository and sender account | Start with `precheck`. After sending an authorized Issue or comment, use the same plan to trace the Ticket, Assignment and worker outcome. [Operating guide](skills/deepseek-harness-bridge/references/superagent.md#github-source) |

See [components and runtime locations](docs/README.md#仓库里的几个名字) for the directory layout.

## Codex Desktop quick start

1. **Install the skill.** Extract the standalone skill ZIP into your personal `~/.agents/skills/` directory. Paired users can reuse their existing Host and grants. A first installation also needs the compatible v0.2.2 Host TGZ and the portable source ZIP containing the Windows installation scripts, or an existing source checkout. [Skill ZIP](https://github.com/ft54482/dsh-control-bridge/releases/download/skill-v0.2.3/deepseek-harness-bridge-0.2.3-skill.zip) · [Host, portable package and SHA-256](https://github.com/ft54482/dsh-control-bridge/releases/tag/v0.2.2)
2. **Install the Host and pair.** Use Python 3.11+. Follow the Windows guide to install the Host into the desktop profile you actually use, choose an idle session in the target workspace, and configure the skill with the path to the long-lived credential file. Choose `read` for history access or `write` for dispatch. [Setup and pairing](docs/windows-delivery.md#codex-desktop-setup)
3. **Check the connection.** Ask Codex to “use `$deepseek-harness-bridge` to check the local connection and list authorized sessions.” To create master-control sessions, also confirm that the same profile has the `master-control` preset installed, the Host allows session creation, and `health` returns `preset_create_verified=true`. Tell Codex about any custom port. [Non-default port example](docs/ports.md#desktop-host)
4. **Choose the session for the task.** Ask to “find the earlier export-fix session and continue the failing cases,” or “open a new master-control session in the same workspace for this independent task.” After creation, the skill reads back the preset from the actual session, dispatches the task and tracks the official terminal state by request ID. [Session commands and acceptance fields](skills/deepseek-harness-bridge/references/desktop.md#new-work-in-master-control-mode)

## ZCode quick start

**Status: finished (2026-11-25).** SuperAgent dispatch and Desktop master-control sessions were both verified on a Windows machine running two instances: a first SuperAgent ticket and a follow-up on the same ticket both ended `completed`, and on the Desktop path a new session was created, sent a prompt and read back `completed` in under half a minute. The repository was left unchanged. Not yet verified: the new-Issue dispatch path. The full list is in [Windows live acceptance](docs/verified-scope.md).

1. **Prerequisites.** Python 3.11+. The Host plugin is installed and paired in Harness Desktop, exactly as on the Codex path. Dispatching SuperAgent tickets also needs a deployed SuperAgent and a GitHub CLI that is logged in. To create sessions in a workspace, that workspace must be in the Host's creation scope; otherwise the answer is `403 outside_allowed_roots`.
2. **Install the dispatch skill.** Copy `skills/zcode/deepseek-harness-bridge/` into `~/.zcode/skills/`, copy its `connection.example.json` to `connection.json`, and fill in the paths, ports and SuperAgent instances of your machine. The file holds paths and ports only; the credential itself stays with the Host.
3. **Install the coordinator skill (optional).** Clone this repository outside every skills directory, copy `skills/zcode/dsh-control-bridge/` into `~/.zcode/skills/`, and copy `local.example.json` to `local.json` with the path of that checkout.
4. **Check, then use it.** Start a new ZCode session. Run `python ~/.zcode/skills/deepseek-harness-bridge/scripts/desktop.py health`, then the three behaviour tests in the skill's `tests/` directory; all of them must pass. After that you can ask ZCode to “dispatch this task to SuperAgent”, or to “find the session that did such-and-such last time and continue it”.

The ZCode skills build on the upstream clients of Codex skill v0.2.3 and add four helper scripts: one prepares a SuperAgent ticket and looks up the port of the instance by repository, one waits for a ticket to end, one sends a brief to a Desktop session, and one compiles the session list. [ZCode skills](skills/zcode/README.md)

## Using different ports

| Service to connect to | Default connection | Settings to update |
| --- | --- | --- |
| Harness Desktop Host | `127.0.0.1:8765` | The Host plugin's `port`, pairing's `--url`, and `--port` on every skill call |
| Python coordinator signed-event endpoint | `127.0.0.1:8787` | Start with `serve --port` and update the sender's `/v1/events` URL |
| SuperAgent management service | The helper defaults to `127.0.0.1:3082` | Read the target profile's actual listening port and pass it to `superagent.py --port PORT state` |
| Coordinator MCP | A local subprocess's standard input and output | Configure the launch command, configuration file and data directory. No TCP port is required |

Configure the services used by your selected entry point. The fake examples' `:9` and `:10` are placeholders. The full guide demonstrates pairing with a non-default port and diagnosing the wrong service, incorrect credentials and unauthorized workspaces. [Ports and troubleshooting](docs/ports.md)

## Python coordinator quick start

Run these commands from the repository root with Python 3.11+. The fake example simulates the full flow locally without Harness credentials or model credits.

```sh
python -m pip install -e .
python examples/e2e_fake.py
dsh-bridge --config examples/config.example.toml check
```

The example deliberately gives both `local-desktop` and `lab-server` a `broadcast-cs` workspace. Dispatch targets are identified by both instance and workspace. Task records distinguish ordinary sessions, `ordinary_session`, and long-running tasks, `superagent`. The default is `draft`; sending requires an operator-provided `mandate`. The fake ticket/run identifiers demonstrate the flow. Track real Assignments through the corresponding SuperAgent management service. [Coordinator commands and approval](docs/coordinator.md) · [Adapter capabilities](docs/adapters.md)

[Development and contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [MIT license](LICENSE)
