#!/usr/bin/env python3
"""PreToolUse hook: block Bash/Read/Grep on files CLAUDE.md says must go
through serena (TypeScript, Python, HTML, CSS source).

CLAUDE.md's "Agent Protocol: Tool Use" section requires serena MCP tools for
all code analysis/retrieval/modification on these file types, and explicitly
forbids falling back to generic filesystem tools even when serena seems
unavailable (in that case, stop and ask for the MCP server to be restarted,
per CLAUDE.md, rather than silently using this hook's blocked path as an
excuse to route around the requirement). This hook exists because memory
alone did not prevent a repeat lapse in session 5c8ca85e-52f6-492e-82ea-
6732709cab4b: fixing it in a file makes the guidance a nudge; enforcing it in
a hook makes it a fact, per shipwright's "tooling catches what memory won't"
philosophy (shipwright:python-guidelines).

Generated build/vendor output is exempt (node_modules, dist, coverage,
.vite) -- the serena mandate is about source code a developer navigates and
edits, not compiled artifacts nobody hand-edits.
"""

import json
import re
import sys

FLAGGED_EXTS = ("ts", "tsx", "py", "html", "css")
EXT_PATTERN = re.compile(r"\.(?:" + "|".join(FLAGGED_EXTS) + r")\b")

READ_UTILS = ("cat", "grep", "rg", "sed", "awk", "head", "tail")
UTIL_PATTERN = re.compile(r"(?:^|[|;&]\s*)(?:" + "|".join(READ_UTILS) + r")\b")

EXEMPT_MARKERS = ("node_modules", "/dist/", "dist/", "coverage/", ".vite/")

SERENA_NOTE = (
    "This project's CLAUDE.md requires serena MCP tools for TypeScript, "
    "Python, HTML, and CSS source files (see 'Agent Protocol: Tool Use'). "
    "Load serena via ToolSearch (\"serena get_symbols\") if its tools "
    "aren't already available, then use get_symbols_overview/find_symbol/"
    "search_for_pattern instead. If serena tools genuinely don't appear, "
    "stop and ask the user to check the plugin rather than falling back "
    "to this tool."
)


def is_exempt(text: str) -> bool:
    return any(marker in text for marker in EXEMPT_MARKERS)


def deny(reason: str) -> None:
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": reason,
        },
    }))


def main() -> None:
    try:
        payload = json.load(sys.stdin)
    except (json.JSONDecodeError, ValueError):
        return

    tool_name = payload.get("tool_name", "")
    tool_input = payload.get("tool_input") or {}

    if tool_name == "Bash":
        command = tool_input.get("command", "") or ""
        if is_exempt(command):
            return
        if UTIL_PATTERN.search(command) and EXT_PATTERN.search(command):
            deny(
                "Blocked: this Bash command reads a flagged source file "
                f"directly instead of via serena. {SERENA_NOTE}"
            )
            return

    elif tool_name == "Read":
        file_path = tool_input.get("file_path", "") or ""
        if is_exempt(file_path):
            return
        if EXT_PATTERN.search(file_path):
            deny(
                "Blocked: use serena to read this file instead of the Read "
                f"tool. {SERENA_NOTE}"
            )
            return

    elif tool_name == "Grep":
        path = tool_input.get("path", "") or ""
        glob = tool_input.get("glob", "") or ""
        if is_exempt(path) or is_exempt(glob):
            return
        if EXT_PATTERN.search(path) or EXT_PATTERN.search(glob):
            deny(
                "Blocked: use serena's search_for_pattern instead of Grep "
                f"for this file type. {SERENA_NOTE}"
            )
            return


if __name__ == "__main__":
    main()
