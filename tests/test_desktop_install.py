"""A superagent --no-open process is not the Desktop shell."""

from dsh_control_bridge.desktop_install import classify_process, install_blocked


def test_superagent_no_open_does_not_block_and_desktop_still_does():
    superagent = {
        "image": r"D:\Apps\DeepSeek Harness\DeepSeek Harness.exe",
        "command_line": r'"D:\Apps\DeepSeek Harness\DeepSeek Harness.exe" --profile superagent --no-open',
    }
    assert classify_process(superagent["image"], superagent["command_line"]) == "other_profile"
    blocked, _reason = install_blocked([superagent])
    assert blocked is False

    shell = {"image": "DeepSeek Harness.exe", "command_line": r"C:\Program\DeepSeek Harness.exe"}
    host = {
        "image": "DeepSeek Harness.exe",
        "command_line": "DeepSeek Harness.exe --profile desktop",
    }
    unknown = {"image": "DeepSeek Harness.exe", "command_line": None}
    assert classify_process(shell["image"], shell["command_line"]) == "desktop_shell"
    assert classify_process(host["image"], host["command_line"]) == "desktop_host"
    assert classify_process(unknown["image"], unknown["command_line"]) == "unknown"
    assert install_blocked([superagent, shell])[0] is True
    assert install_blocked([unknown])[0] is True
    assert install_blocked([{"image": "python.exe", "command_line": "python -m pytest"}])[0] is False
