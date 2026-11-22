.PHONY: test e2e check

PY ?= python3

test:
	$(PY) -m pytest

e2e:
	$(PY) examples/e2e_fake.py

check:
	$(PY) -m dsh_control_bridge check --config examples/config.example.toml --data-dir /tmp/dsh-bridge-check
