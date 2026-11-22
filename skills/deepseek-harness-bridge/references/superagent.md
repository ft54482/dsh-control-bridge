# Official SuperAgent

Use `scripts/superagent.py` for the official local management API. Defaults to loopback port `3082`. Pass `--port` before the command to select an authorized isolated profile's management port. This API and the Desktop bridge have separate state and authorization.

```powershell
python superagent.py state
python superagent.py sources
python superagent.py tickets --state working --limit 10
python superagent.py tickets --state ended --limit 10
python superagent.py ticket TICKET_ID
```

The client shows status metadata and omits summaries, repository paths, and account details. List filters are `open`, `person`, `working`, `idle`, `ended`. For Assignment evidence, record the Ticket ID, Assignment ID, Assignment `state` and `ref` (the worker session), and final outcome where available. A historical Assignment establishes query access only.

To initiate new work, use an authorized Source in the intended profile. A real source event triggers Eval, which may create a Ticket and schedule an Assignment. The GitHub Source can evaluate a permitted actor's `@agent` mention in a configured repository. Check the test profile's Source, actor authorization and worker capacity before sending an authorized event. Correlate the new event to the resulting Ticket and Assignment. Refer to the [official domain model](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/001-domain.md) and [authorization rules](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/002-authorization.md).
