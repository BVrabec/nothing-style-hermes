"""nothing-agents dashboard routes: read and save a profile's subagent team.

Mounted by the dashboard at /api/plugins/nothing-agents/.

  GET  /team?profile=<name>    the team plus whether the agent side is live
  PUT  /team?profile=<name>    save the team (validated, written atomically)
  POST /enable?profile=<name>  copy this plugin into that profile and enable it
                               (the same as `hermes plugins enable`, run for it)

The team file is ``<profile home>/nothing-agents/team.json``. Nothing else in
the profile is written by these routes; the delegation limits ("team rules")
are saved by the page through the dashboard's own PUT /api/config.

A subagent may carry an optional ``provider`` (1.2.0): the provider it runs on
instead of the soul's. Absent or empty means "the soul's", exactly as before.
A provider that is new or changed in a save must be one this profile can use
right now -- checked with the agent side's own call-time resolution, so the tab
and the tool never disagree. Only a provider *name* is stored, never a credential.
"""

from __future__ import annotations

import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any, Dict, List

from fastapi import APIRouter, Body, HTTPException

router = APIRouter()

PLUGIN = "nothing-agents"
COLOURS = {"violet", "indigo", "sky", "teal", "mint", "amber", "coral", "rose", "red", "graphite"}
NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 ._-]{0,31}$")
MAX_SUBAGENTS = 12


def _profile_home(profile: str | None) -> tuple[str, Path]:
    from hermes_cli import profiles as P
    raw = (profile or "default").strip() or "default"
    try:
        name = P.normalize_profile_name(raw)
        P.validate_profile_name(name)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    if not P.profile_exists(name):
        raise HTTPException(status_code=404, detail=f"Profile '{name}' does not exist.")
    return name, Path(P.get_profile_dir(name))


def _team_path(home: Path) -> Path:
    return home / PLUGIN / "team.json"


def _read_team(home: Path) -> Dict[str, Any]:
    try:
        data = json.loads(_team_path(home).read_text(encoding="utf-8"))
        if isinstance(data, dict):
            return {"orchestrator": data.get("orchestrator") or {}, "subagents": data.get("subagents") or []}
    except FileNotFoundError:
        pass
    except Exception:
        raise HTTPException(status_code=500, detail="team.json is unreadable; fix or delete it.")
    return {"orchestrator": {}, "subagents": []}


_AGENT = None


def _agent_module():
    """This plugin's own agent side (``../__init__.py``), loaded by path so the save-time provider check is
    the very code ``call_subagent`` runs -- one rule, not a copy. Importing it only defines functions."""
    global _AGENT
    if _AGENT is None:
        path = Path(__file__).resolve().parent.parent / "__init__.py"
        spec = importlib.util.spec_from_file_location("nothing_agents_agent_side", path)
        if spec is None or spec.loader is None:
            raise RuntimeError("agent side not found")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        _AGENT = module
    return _AGENT


def _installed_version(home: Path) -> str:
    """Version of the agent-side copy installed in that profile (from its plugin.yaml), or ""."""
    try:
        text = (home / "plugins" / PLUGIN / "plugin.yaml").read_text(encoding="utf-8")
    except OSError:
        return ""
    found = re.search(r"^version:\s*['\"]?([0-9][0-9.]*)", text, re.M)
    return found.group(1) if found else ""


def _version_at_least(version: str, floor: tuple) -> bool:
    try:
        return tuple(int(p) for p in version.split(".")[:3]) >= floor
    except ValueError:
        return False


def _agent_side(home: Path) -> Dict[str, Any]:
    installed = (home / "plugins" / PLUGIN / "__init__.py").is_file()
    version = _installed_version(home) if installed else ""
    enabled = False
    try:
        try:
            import hermes_yaml as yaml  # Hermes 0.21+: PyYAML is not installed
        except ImportError:
            import yaml
        cfg = yaml.safe_load((home / "config.yaml").read_text(encoding="utf-8")) or {}
        names = ((cfg.get("plugins") or {}).get("enabled") or []) if isinstance(cfg, dict) else []
        enabled = PLUGIN in [str(n) for n in names]
    except Exception:
        pass
    # An agent-side copy older than 1.2.0 does not know "provider" and would run such a subagent on the
    # soul's account. The tab warns about it; "Turn on" (or copying the plugin again) refreshes the copy.
    return {"installed": installed, "enabled": enabled, "version": version,
            "supports_provider": _version_at_least(version, (1, 2, 0))}


def _text(v: Any, limit: int) -> str:
    s = str(v or "").strip()
    if len(s) > limit:
        raise HTTPException(status_code=400, detail=f"text longer than {limit} characters")
    return s


def _colour(v: Any, default: str) -> str:
    c = str(v or "").strip().lower()
    return c if c in COLOURS else default


TOOLSET_RE = re.compile(r"^[a-z0-9][a-z0-9_.:-]{0,63}$")


def _tools(v: Any) -> List[str]:
    out: List[str] = []
    for t in v if isinstance(v, list) else []:
        name = str(t or "").strip()
        if TOOLSET_RE.match(name) and name not in out:
            out.append(name)
    return out[:32]


def _provider(v: Any, name: str, model: str, known: Dict[str, str]) -> str:
    """A subagent's own provider, validated, or "" for the soul's. Format and "needs a model" are always
    checked. Whether this profile can use it *now* is checked only for a provider that is new or changed
    in this save, so a credential that expired later never makes unrelated edits unsaveable (the tool
    still refuses at call time)."""
    agent = None
    try:
        agent = _agent_module()
        provider = agent.normalize_provider(v)
    except HTTPException:
        raise
    except Exception as exc:
        if agent is None:  # the agent side could not even be loaded
            raise HTTPException(status_code=503, detail=f"cannot check providers here: {exc}")
        raise HTTPException(status_code=400, detail=f"{name!r}: {exc}")
    if not provider:
        return ""
    if not model:
        raise HTTPException(status_code=400, detail=f"{name!r}: choose a model for provider {provider!r}; it would otherwise be sent the soul's model")
    if provider != known.get(name.lower(), ""):
        problem = agent.provider_problem(provider, model)
        if problem:
            raise HTTPException(status_code=400, detail=f"{name!r}: provider {provider!r}: {problem}")
    return provider


def _clean(body: Dict[str, Any], known: Dict[str, str] | None = None) -> Dict[str, Any]:
    known = known or {}
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="expected a JSON object")
    orch_in = body.get("orchestrator") if isinstance(body.get("orchestrator"), dict) else {}
    orch = {"name": _text(orch_in.get("name"), 40), "colour": _colour(orch_in.get("colour"), "violet")}
    subs_in = body.get("subagents") if isinstance(body.get("subagents"), list) else []
    if len(subs_in) > MAX_SUBAGENTS:
        raise HTTPException(status_code=400, detail=f"at most {MAX_SUBAGENTS} subagents per profile")
    subs: List[Dict[str, Any]] = []
    seen = set()
    for s in subs_in:
        if not isinstance(s, dict):
            continue
        name = _text(s.get("name"), 32)
        if not NAME_RE.match(name):
            raise HTTPException(status_code=400, detail=f"name {name!r}: use letters, numbers, space . _ - (max 32)")
        if name.lower() in seen:
            raise HTTPException(status_code=400, detail=f"two subagents are called {name!r}")
        seen.add(name.lower())
        model = _text(s.get("model"), 160)
        entry = {
            "name": name,
            "colour": _colour(s.get("colour"), "sky"),
            "model": model,
            "tools": _tools(s.get("tools")),
            "can_delegate": bool(s.get("can_delegate")),
            "when": _text(s.get("when"), 300),
            "instructions": _text(s.get("instructions"), 2000),
        }
        provider = _provider(s.get("provider"), name, model, known)
        if provider:  # absent in the file means "the soul's provider", so a team that has none stays byte-compatible
            entry["provider"] = provider
        subs.append(entry)
    return {"version": 1, "orchestrator": orch, "subagents": subs}


def _with_provider_field(team: Dict[str, Any]) -> Dict[str, Any]:
    """What the tab receives: every subagent has a ``provider`` ("" = the soul's), also in files saved before 1.2.0."""
    subs = [dict(s, provider=str(s.get("provider") or "")) if isinstance(s, dict) else s for s in team.get("subagents") or []]
    return {**team, "subagents": subs}


@router.get("/team")
def get_team(profile: str = "default"):
    name, home = _profile_home(profile)
    return {"profile": name, **_with_provider_field(_read_team(home)), "agent": _agent_side(home)}


@router.put("/team")
def put_team(profile: str = "default", body: Dict[str, Any] = Body(...)):
    name, home = _profile_home(profile)
    try:
        stored = _read_team(home)
    except HTTPException:  # an unreadable file is replaced by this save; nothing in it counts as already checked
        stored = {"subagents": []}
    known = {str(s.get("name", "")).lower(): str(s.get("provider") or "")
             for s in stored.get("subagents") or [] if isinstance(s, dict)}
    team = _clean(body, known)
    path = _team_path(home)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=".team-", suffix=".json")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(team, fh, indent=2, ensure_ascii=False)
            fh.write("\n")
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)
    return {"profile": name, **_with_provider_field(team), "agent": _agent_side(home)}


@router.post("/enable")
def enable(profile: str = "default"):
    """Install the agent side into a profile: copy this plugin there and enable it."""
    name, home = _profile_home(profile)
    source = Path(__file__).resolve().parent.parent
    target = home / "plugins" / PLUGIN
    if source != target.resolve():
        if target.exists():
            shutil.rmtree(target)
        shutil.copytree(source, target, ignore=shutil.ignore_patterns("__pycache__"))
    exe = shutil.which("hermes")
    cmd = [exe] if exe else [sys.executable, "-m", "hermes_cli.main"]
    env = dict(os.environ, HERMES_HOME=str(home))
    run = subprocess.run(cmd + ["plugins", "enable", PLUGIN, "--no-allow-tool-override"],
                         env=env, capture_output=True, text=True, timeout=60)
    side = _agent_side(home)
    if not side["enabled"]:
        out = (run.stdout + run.stderr).strip()[-400:]
        raise HTTPException(status_code=500, detail=f"enable did not take: {out or 'no output'}")
    return {"profile": name, "agent": side}
