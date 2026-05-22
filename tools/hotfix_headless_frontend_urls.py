from __future__ import annotations

from pathlib import Path


ROOT = Path("/opt/machine-darts-headless/frontend/assets")
HTTP_EXPR = "location.origin"
WS_EXPR = '(location.protocol==="https:"?"wss://":"ws://")+location.host'
WS_TEMPLATE = '${location.protocol==="https:"?"wss":"ws"}://${location.host}'


def patch_text(text: str) -> str:
    replacements = {
        '"http://127.0.0.1:8000"': HTTP_EXPR,
        '"http://localhost:8000"': HTTP_EXPR,
        "'http://127.0.0.1:8000'": HTTP_EXPR,
        "'http://localhost:8000'": HTTP_EXPR,
        '"ws://127.0.0.1:8000"': WS_EXPR,
        '"ws://localhost:8000"': WS_EXPR,
        "'ws://127.0.0.1:8000'": WS_EXPR,
        "'ws://localhost:8000'": WS_EXPR,
        "ws://127.0.0.1:8000": WS_TEMPLATE,
        "ws://localhost:8000": WS_TEMPLATE,
    }
    out = text
    for old, new in replacements.items():
        out = out.replace(old, new)
    out = out.replace("returnlocation.origin", "return location.origin")
    out = out.replace(
        '"${location.protocol===\\"https:\\"?\\"wss\\":\\"ws\\"}://${location.host}',
        '`${location.protocol==="https:"?"wss":"ws"}://${location.host}',
    )
    out = out.replace(
        '"${location.protocol==="https:"?"wss":"ws"}://${location.host}',
        '`${location.protocol==="https:"?"wss":"ws"}://${location.host}',
    )
    out = out.replace(
        '${location.host}/ws/detection"',
        '${location.host}/ws/detection`',
    )
    out = out.replace(
        '${location.host}/ws/detection/events"',
        '${location.host}/ws/detection/events`',
    )
    return out


def main() -> None:
    changed = 0
    for path in ROOT.glob("*.js"):
        text = path.read_text(encoding="utf-8")
        next_text = patch_text(text)
        if next_text != text:
            path.write_text(next_text, encoding="utf-8")
            changed += 1
            print(f"patched {path}")
    print(f"changed={changed}")


if __name__ == "__main__":
    main()
