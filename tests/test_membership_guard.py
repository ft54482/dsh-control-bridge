"""Workspace membership comparison. Subagents are classified, not dropped or hoisted."""

from dsh_control_bridge.membership_guard import compare_membership


def _snapshot():
    children = [{"id": f"child-{index}", "parent": "session-parent"} for index in range(31)]
    return {
        "status": "ok",
        "workspaces": [
            {
                "id": "ws-broadcast",
                "top_level": ["s1", "s2", "s3", "s4", "s5", "s6"],
                "subagent": children,
                "unreadable": [],
            }
        ],
    }


def test_nested_subagents_are_not_missing_and_must_not_move_to_the_root():
    before = _snapshot()
    assert compare_membership(before, _snapshot())["ok"] is True
    hoisted = _snapshot()
    moved = hoisted["workspaces"][0]["subagent"].pop(0)
    hoisted["workspaces"][0]["top_level"].append(moved["id"])
    result = compare_membership(before, hoisted)
    assert result["ok"] is False
    assert result["hoisted"][0]["session_id"] == "child-0"
    lost = _snapshot()
    lost["workspaces"][0]["top_level"] = ["s1"]
    missing = compare_membership(before, lost)
    assert missing["ok"] is False
    assert any(item["session_id"] == "s2" for item in missing["missing"])


def test_a_failed_read_is_not_an_empty_registry():
    result = compare_membership(_snapshot(), {"status": "read_failed", "workspaces": []})
    assert result["ok"] is False
    assert result["reason"] == "read_failed"
