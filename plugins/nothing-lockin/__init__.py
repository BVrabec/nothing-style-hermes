"""nothing-lockin, agent side (round 4): tell the profile's AI where its folder is.

The dashboard half (dashboard/plugin_api.py) gives every profile one folder and
remembers it in <dashboard HERMES_HOME>/nothing-lockin/folders.json, keyed by the
profile name. A profile's own agent runs with HERMES_HOME=<root>/profiles/<name>
(the default profile runs with <root> itself), so this side finds the shared file
from there. It adds one short system-prompt section naming the folder and what the
person does with it in Lock In. No tool is added: the AI uses its normal file and
terminal tools. Nothing is written. The section is empty (nothing is added) when
the profile has no folder yet.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any, Optional, Tuple

logger = logging.getLogger(__name__)

SECTION_ID = "nothing-lockin.folder"


def _home() -> Path:
    from hermes_constants import get_hermes_home
    return Path(get_hermes_home())


def locate(home: Path) -> Tuple[Path, str]:
    """(shared root, profile name) for an agent whose HERMES_HOME is ``home``."""
    if home.parent.name == "profiles":
        return home.parent.parent, home.name
    return home, "default"


def profile_folder(home: Optional[Path] = None) -> Optional[str]:
    home = home or _home()
    root, name = locate(home)
    try:
        data = json.loads((root / "nothing-lockin" / "folders.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    path = data.get(name) if isinstance(data, dict) else None
    return path.strip() if isinstance(path, str) and path.strip() else None


def render_section(_session_info: Any = None, home: Optional[Path] = None) -> str:
    try:
        path = profile_folder(home)
    except Exception as exc:  # never break a chat over this
        logger.warning("nothing-lockin: cannot find the profile folder: %s", exc)
        return ""
    if not path:
        return ""
    return "\n".join([
        "## Your folder",
        f"This profile has its own folder: `{path}`. It is where the person keeps the files you work on "
        "together, and they see it in Lock In (file tree, text editor, image, PDF, Word and Excel viewers). "
        "When they mention a document, a spreadsheet or \"my files\", look there first. Put the files you "
        "create there, unless they say otherwise. Word and Excel files are view-only for them, so you make "
        "the changes (save the result in place or as a new file) and tell them to reopen it. Do not delete or "
        "overwrite their files without saying so first. Work inside this folder unless asked to go elsewhere.",
    ])


def register(ctx) -> None:
    if hasattr(ctx, "register_system_prompt_section"):
        ctx.register_system_prompt_section(SECTION_ID, render_section, position="after_memory", max_chars=1200)
