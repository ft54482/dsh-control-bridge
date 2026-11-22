# Contributing

Issues and pull requests are welcome. The project language for docs is Chinese, with a short English overview in the README. Code, errors, and tests are in English.

## Development

Python 3.11 or newer. Runtime dependencies are the standard library. Tests use the pinned pytest in `requirements-dev.txt`.

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
pytest
python examples/e2e_fake.py
```

CI runs the same two commands and does not contact a real Harness.

## Secrets

Do not commit tokens, webhook secrets, customer data, production URLs, or a filled-in credentials file. Examples stay placeholders. If a change needs a new config field, reject inline secrets the way `config.py` already does.

## Scope

Keep the bridge small. A change that dispatches without a mandate, treats a webhook body as an instruction, or invents an unpublished Harness endpoint does not belong here. Adapter work should add a documented call behind the existing interface and a test that still passes with the fake adapter.
