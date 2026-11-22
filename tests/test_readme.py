import hashlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HERO = ROOT / "docs" / "assets" / "hero.jpg"
HERO_SHA256 = "c4488da680a4578d0ed76f7da8728726a3191aa42972730d2593a2e65725233e"


def test_readme_opens_with_the_exact_hero():
    readme = (ROOT / "README.md").read_text(encoding="utf-8")
    first = readme.lstrip().splitlines()[0]
    assert first.startswith("<img ")
    assert 'src="docs/assets/hero.jpg"' in first
    assert 'width="100%"' in first
    assert "alt=" in first
    assert "DSH Control Bridge" in first
    data = HERO.read_bytes()
    assert data[:3] == b"\xff\xd8\xff"
    assert data[-2:] == b"\xff\xd9"
    assert hashlib.sha256(data).hexdigest() == HERO_SHA256


def test_readme_covers_the_two_paths_and_instances():
    readme = (ROOT / "README.md").read_text(encoding="utf-8")
    for phrase in (
        "ordinary_session",
        "superagent",
        "local-desktop",
        "lab-server",
        "broadcast-cs",
        "draft",
        "mandate",
    ):
        assert phrase in readme
    assert "xAI" not in readme
    lowered = readme.lower()
    assert "production-ready" not in lowered
    assert "official deepseek" not in lowered
