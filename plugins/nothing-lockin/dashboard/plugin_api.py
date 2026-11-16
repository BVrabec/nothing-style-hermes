"""nothing-lockin routes: which folder belongs to which profile, and Word/Excel preview.

Mounted at /api/plugins/nothing-lockin/.

  GET /folder?profile=<name>        the profile's folder (created on first use)
  GET /preview?profile=&path=       read-only content of a .docx or .xlsx in that folder

Each profile gets ONE folder under ~/profiles in the dashboard user's home
directory, named after the profile's display name the first time (default
profile "Personal" → ~/profiles/personal, i.e. the owner's folder on the
host). The choice is remembered in ONE shared folders.json, keyed by profile
name, so renaming a profile later never moves or orphans its files. Reading and
writing the files themselves goes through Hermes's own /api/files and /api/fs
routes.

folders.json always lives at the default profile's own Hermes home
(<HERMES_HOME>/nothing-lockin/folders.json), never at a non-default profile's own
Hermes home (<HERMES_HOME>/profiles/<name>) even when a request is scoped to that
profile: a non-default profile's agent (plugins/nothing-lockin/__init__.py) walks
back up to that same shared file to tell its own AI where its folder is, so the
dashboard side has to agree on where it lives or a non-default profile's folder
would be invisible to its own agent (see _shared_hermes_home()).

An older version of this plugin put each profile's folder directly in the home
directory (e.g. /root/personal). The first /folder call for such a profile now
moves that directory on disk into ~/profiles and updates folders.json to match,
automatically and once; nothing else needs to change for existing profiles.

/preview exists because a browser cannot show Word or Excel files. It uses only the
standard library (an .docx/.xlsx is a zip of XML), so nothing is installed and no
script is loaded from the internet. It returns plain data (text, numbers, table
cells), never HTML or links, and the page draws it. It only opens .docx and .xlsx
files that sit inside the profile's own folder, and it is bounded: 25 MB file size,
a cap on how much XML it will unpack (zip bombs), no XML entity definitions, 1000
rows and 60 columns per sheet, 4000 blocks per document. Macros are never touched.
"""

from __future__ import annotations

import datetime
import io
import json
import os
import re
import tempfile
import zipfile
import xml.etree.ElementTree as ET
from decimal import ROUND_HALF_UP, Decimal
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from fastapi import APIRouter, HTTPException

router = APIRouter()


def _hermes_home() -> Path:
    try:
        from hermes_constants import get_hermes_home
        return Path(get_hermes_home())
    except Exception:
        return Path(os.environ.get("HERMES_HOME") or Path.home() / ".hermes")


def _shared_hermes_home() -> Path:
    """The one Hermes home folders.json lives in, regardless of which profile's dashboard
    view is making the call. A non-default profile's own Hermes home is
    ``<root>/profiles/<name>`` (the default profile's agent runs with ``<root>`` itself); the
    agent side (``plugins/nothing-lockin/__init__.py``'s ``locate()``) already walks back up to
    ``<root>`` to find this same file, so the dashboard side has to resolve to that same place
    or a non-default profile's folder would be invisible to its own agent.
    """
    home = _hermes_home()
    if home.parent.name == "profiles":
        return home.parent.parent
    return home


def _store() -> Path:
    return _shared_hermes_home() / "nothing-lockin" / "folders.json"


def _load() -> Dict[str, str]:
    try:
        data = json.loads(_store().read_text(encoding="utf-8"))
        return {str(k): str(v) for k, v in data.items()} if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _save(data: Dict[str, str]) -> None:
    path = _store()
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=".folders-", suffix=".json")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(data, fh, indent=2)
            fh.write("\n")
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def _slug(text: str) -> str:
    s = re.sub(r"[^a-z0-9_-]+", "-", text.strip().lower()).strip("-")
    return s[:48] or "profile"


def _profile(name: str) -> Dict[str, str]:
    from hermes_cli import profiles as P
    raw = (name or "default").strip() or "default"
    try:
        canon = P.normalize_profile_name(raw)
        P.validate_profile_name(canon)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    if not P.profile_exists(canon):
        raise HTTPException(status_code=404, detail=f"Profile '{canon}' does not exist.")
    display = ""
    try:
        for info in P.list_profiles():
            if getattr(info, "name", None) == canon:
                display = str(getattr(info, "display_name", "") or "")
                break
    except Exception:
        pass
    return {"name": canon, "display": display or canon}


def _profiles_root() -> Path:
    return Path.home() / "profiles"


def _migrate_legacy(target: Path, home: Path, profiles_root: Path) -> Tuple[Path, bool]:
    """A legacy entry points at a folder that sits directly in *home* (the pre-~/profiles
    convention). Move it into *profiles_root* the first time we see it and report whether we
    did. Pure w.r.t. its arguments (no Path.home() of its own) so it can be unit-tested without
    a real $HOME or a real Hermes profile; self-disabling, since a migrated path's parent is no
    longer *home*.
    """
    if target.parent != home or target.name == "profiles":
        return target, False
    new_target = profiles_root / target.name
    if target.exists() and not new_target.exists():
        new_target.parent.mkdir(parents=True, exist_ok=True)
        target.rename(new_target)
        return new_target, True
    if not target.exists():
        # Nothing to move; just adopt the new location going forward.
        return new_target, True
    return target, False


@router.get("/folder")
def folder(profile: str = "default"):
    prof = _profile(profile)
    data = _load()
    path = data.get(prof["name"])
    if not path:
        path = str(_profiles_root() / _slug(prof["display"]))
        data[prof["name"]] = path
        _save(data)
    target, migrated = _migrate_legacy(Path(path), Path.home(), _profiles_root())
    if migrated:
        path = str(target)
        data[prof["name"]] = path
        _save(data)

    created = False
    if not target.exists():
        target.mkdir(parents=True, exist_ok=True)
        created = True
    if not target.is_dir():
        raise HTTPException(status_code=409, detail=f"{path} exists and is not a folder")
    result = {"profile": prof["name"], "display": prof["display"], "path": str(target), "created": created}
    if migrated:
        result["migrated"] = True
    return result


# ---- chat folders (round 6) ---------------------------------------------------
# Hermes keeps the conversations; this only remembers how the person sorted them: named folders
# per profile and which folder each conversation (by session id) sits in. Kept in
# <HERMES_HOME>/nothing-lockin/chats.json so every browser and device sees the same sorting.
# Nothing here reads or changes a conversation.

_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_MAX_CHAT_FOLDERS = 100
_MAX_ASSIGN = 5000


def _chats_store() -> Path:
    return _hermes_home() / "nothing-lockin" / "chats.json"


def _chats_load() -> Dict[str, Any]:
    try:
        data = json.loads(_chats_store().read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _clean_org(raw: Any) -> Dict[str, Any]:
    """Return a safe {folders:[{id,name}], assign:{sid:folderId}} from untrusted input, or raise 400."""
    if not isinstance(raw, dict):
        raise HTTPException(status_code=400, detail="expected an object")
    folders_in, assign_in = raw.get("folders", []), raw.get("assign", {})
    if not isinstance(folders_in, list) or not isinstance(assign_in, dict):
        raise HTTPException(status_code=400, detail="folders must be a list and assign an object")
    if len(folders_in) > _MAX_CHAT_FOLDERS or len(assign_in) > _MAX_ASSIGN:
        raise HTTPException(status_code=413, detail="too many folders or chats")
    folders: List[Dict[str, str]] = []
    seen = set()
    for f in folders_in:
        if not isinstance(f, dict):
            raise HTTPException(status_code=400, detail="bad folder")
        fid, name = f.get("id"), f.get("name")
        if not isinstance(fid, str) or not _ID.match(fid) or fid in seen:
            raise HTTPException(status_code=400, detail="bad folder id")
        if not isinstance(name, str) or not name.strip() or len(name.strip()) > 60:
            raise HTTPException(status_code=400, detail="a folder name must be 1-60 characters")
        seen.add(fid)
        folders.append({"id": fid, "name": name.strip()})
    assign: Dict[str, str] = {}
    for sid, fid in assign_in.items():
        if not isinstance(sid, str) or not _ID.match(sid) or fid not in seen:
            continue          # a chat pointing at a folder that is gone is simply unfiled
        assign[sid] = fid
    return {"folders": folders, "assign": assign}


@router.get("/chatorg")
def chatorg_get(profile: str = "default"):
    prof = _profile(profile)
    mine = _chats_load().get(prof["name"])
    try:
        return _clean_org(mine) if mine else {"folders": [], "assign": {}}
    except HTTPException:
        return {"folders": [], "assign": {}}


@router.put("/chatorg")
def chatorg_put(body: Dict[str, Any], profile: str = "default"):
    prof = _profile(profile)
    org = _clean_org(body)
    data = _chats_load()
    data[prof["name"]] = org
    path = _chats_store()
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=".chats-", suffix=".json")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(data, fh, indent=2)
            fh.write("\n")
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)
    return org


# ---- terminal janitor (round 8) -----------------------------------------------
# Hermes keeps every chat terminal (a Python agent plus a node UI, roughly 0.35 GB together) alive after the
# browser lets go of it, and only closes it after 30 minutes. This janitor, which runs inside the dashboard,
# closes such a terminal sooner, but only when ALL of these hold:
#   * no browser is attached to it (its tab is closed, or the page was left),
#   * it has been detached for DETACHED_GRACE seconds,
#   * and it has looked idle for QUIET_FOR seconds: printing only its clock, using almost no processor and running no
#     tools of its own (see _look). A terminal that is working shows one of those and is left alone.
# When the machine is short of memory the two waits become short. Nothing is lost: conversations live in
# Hermes's session store. Before closing, the janitor notes which conversation the terminal was in, so the
# Lock In tab that owned it picks that conversation up again (see /terminals/claim). It only ever looks at
# and closes keep-alive terminals through the registry Hermes itself uses; if that is not there (another
# Hermes version) it does nothing.

import asyncio
import logging
import time

_log = logging.getLogger("nothing-lockin")
DETACHED_GRACE = 600.0      # seconds nobody has been viewing the terminal
QUIET_FOR = 120.0           # seconds it has looked idle (see _look)
TIGHT_GRACE = 180.0         # the same two waits when memory is short
TIGHT_QUIET = 60.0
TIGHT_BELOW_PCT = 20.0      # "short" = less than this share of memory available
EVERY = 30.0                # seconds between looks
BUSY_BYTES_PER_S = 150.0    # an idle terminal prints about 40-55 bytes a second (its clock); more than this is work
BUSY_CPU = 0.04             # share of one processor (all of the terminal's processes together) that means work
NORMAL_PROCS = 2            # an idle chat terminal is two processes (the node UI and its Python agent)
_TOKEN = re.compile(r"^[A-Za-z0-9_-]{8,64}$")
_MAX_NOTES = 200

_J: Dict[str, Any] = {"task": None, "seen": {}, "closed": 0, "last_tick": None, "last_error": None, "tight": False}


def _janitor_conf() -> Dict[str, Any]:
    """Optional <HERMES_HOME>/nothing-lockin/janitor.json: {"enabled": true, "grace": 120, "quiet": 90, "every": 30}."""
    conf = {"enabled": True, "grace": DETACHED_GRACE, "quiet": QUIET_FOR, "every": EVERY}
    try:
        raw = json.loads((_hermes_home() / "nothing-lockin" / "janitor.json").read_text(encoding="utf-8"))
        if isinstance(raw, dict):
            if raw.get("enabled") is False:
                conf["enabled"] = False
            for k, low in (("grace", 10), ("quiet", 10), ("every", 5)):
                v = raw.get(k)
                if isinstance(v, (int, float)) and not isinstance(v, bool) and low <= v <= 86400:
                    conf[k] = float(v)
    except (OSError, ValueError):
        pass
    return conf


def _registry():
    try:
        from hermes_cli.web_server_chat import PTY_REGISTRY
        return PTY_REGISTRY if hasattr(PTY_REGISTRY, "_sessions") and hasattr(PTY_REGISTRY, "_attach_lock") else None
    except Exception:
        return None


def _mem_available_pct() -> Optional[float]:
    try:
        vals = {}
        with open("/proc/meminfo", encoding="utf-8") as fh:
            for line in fh:
                k, _, rest = line.partition(":")
                if k in ("MemTotal", "MemAvailable"):
                    vals[k] = float(rest.split()[0])
        return 100.0 * vals["MemAvailable"] / vals["MemTotal"] if vals.get("MemTotal") else None
    except Exception:
        return None


_CLK = os.sysconf("SC_CLK_TCK") if hasattr(os, "sysconf") else 100


def _proc_table() -> Dict[int, Tuple[int, float]]:
    """{pid: (parent pid, cpu seconds used so far)} for every process (Linux /proc; empty elsewhere)."""
    table: Dict[int, Tuple[int, float]] = {}
    try:
        names = os.listdir("/proc")
    except OSError:
        return table
    for n in names:
        if not n.isdigit():
            continue
        try:
            with open(f"/proc/{n}/stat", encoding="utf-8", errors="replace") as fh:
                rest = fh.read().rpartition(")")[2].split()
            table[int(n)] = (int(rest[1]), (int(rest[11]) + int(rest[12])) / _CLK)
        except (OSError, IndexError, ValueError):
            continue
    return table


def _tree_of(session: Any, table: Dict[int, Tuple[int, float]]) -> Tuple[int, float]:
    """(number of processes, cpu seconds so far) in a terminal's process tree: the PTY leader and everything under it."""
    try:
        leader = int(session.bridge.pid)
    except Exception:
        return (0, 0.0)
    if leader not in table:
        return (0, 0.0)
    kids: Dict[int, List[int]] = {}
    for pid, (ppid, _) in table.items():
        kids.setdefault(ppid, []).append(pid)
    seen, todo, cpu = set(), [leader], 0.0
    while todo:
        pid = todo.pop()
        if pid in seen:
            continue
        seen.add(pid)
        cpu += table.get(pid, (0, 0.0))[1]
        todo.extend(kids.get(pid, []))
    return (len(seen), cpu)


def _notes_path() -> Path:
    return _hermes_home() / "nothing-lockin" / "terminals.json"


def _notes_load() -> Dict[str, Any]:
    try:
        data = json.loads(_notes_path().read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _notes_save(data: Dict[str, Any]) -> None:
    path = _notes_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=".terminals-", suffix=".json")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(data, fh)
            fh.write("\n")
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def _sid_of(session: Any, key: str) -> Optional[str]:
    """The conversation a terminal is in: from Hermes's active-session marker, else the key's resume target."""
    try:
        f = getattr(session, "active_session_file", None)
        if f is not None:
            sid = str(json.loads(Path(f).read_text(encoding="utf-8-sig")).get("session_id") or "").strip()
            if sid:
                return sid
    except Exception:
        pass
    parts = key.split("\0")
    return parts[2] if len(parts) >= 3 and parts[2] else None


def _note(key: str, sid: Optional[str]) -> None:
    token = key.split("\0")[0]
    if not sid or not _TOKEN.match(token) or not _ID.match(sid):
        return
    notes = _notes_load()
    notes[token] = {"sid": sid, "at": time.time()}
    if len(notes) > _MAX_NOTES:
        for old in sorted(notes, key=lambda t: float((notes[t] or {}).get("at") or 0))[: len(notes) - _MAX_NOTES]:
            notes.pop(old, None)
    _notes_save(notes)


def _appended(prev_tail: Optional[bytes], prev_len: Optional[int], snap: bytes) -> Optional[int]:
    """How many bytes the terminal has printed since the last look, or None when that cannot be told (first look, or the
    terminal's buffer, which keeps only its newest megabyte, has started to drop old output: then the processor and the
    process count decide)."""
    if prev_tail is None or prev_len is None or prev_len < len(prev_tail) or len(snap) < prev_len:
        return None
    return len(snap) - prev_len if snap[prev_len - len(prev_tail):prev_len] == prev_tail else None


def _look(rec: Dict[str, Any], s: Any, table: Dict[int, Tuple[int, float]], now: float) -> bool:
    """Update what is known about one terminal; True when it looks BUSY right now (printing a lot, using the processor,
    or running tools of its own). An idle chat terminal prints a tiny clock tick every second and uses almost no processor."""
    snap = s.buffer.snapshot() if getattr(s, "buffer", None) is not None else b""
    n, cpu = _tree_of(s, table)
    prev_at = rec.get("at")
    first = prev_at is None
    dt = max(now - prev_at, 0.001) if not first else 0.0
    grown = _appended(rec.get("tail"), rec.get("len"), snap)
    rec["tail"], rec["len"] = snap[-256:], len(snap)
    rec["at"] = now
    rate = None if first or grown is None else grown / dt
    cpu_rate = None if first or "cpu" not in rec else max(0.0, cpu - rec["cpu"]) / dt
    rec["cpu"] = cpu
    rec["procs"], rec["rate"], rec["cpuRate"] = n, rate, cpu_rate
    if first:
        return True
    return bool((rate is not None and rate > BUSY_BYTES_PER_S) or (cpu_rate is not None and cpu_rate > BUSY_CPU) or n > NORMAL_PROCS)


async def _janitor_tick(now: Optional[float] = None) -> List[str]:
    """One look. Returns the keys of the terminals it closed."""
    reg = _registry()
    conf = _janitor_conf()
    if reg is None or not conf["enabled"]:
        return []
    now = time.monotonic() if now is None else now
    pct = _mem_available_pct()
    tight = pct is not None and pct < TIGHT_BELOW_PCT
    _J["tight"] = tight
    grace = min(conf["grace"], TIGHT_GRACE) if tight else conf["grace"]
    quiet = min(conf["quiet"], TIGHT_QUIET) if tight else conf["quiet"]
    seen = _J["seen"]
    sessions = dict(reg._sessions)
    for gone in [k for k in seen if k not in sessions]:
        seen.pop(gone, None)
    table = _proc_table()
    victims = []
    for key, s in sessions.items():
        rec = seen.setdefault(key, {})
        if _look(rec, s, table, now) or "busyAt" not in rec:
            rec["busyAt"] = now
        if getattr(s, "attached", True) or getattr(s, "last_detached_at", None) is None:
            continue
        if now - s.last_detached_at < grace or now - rec["busyAt"] < quiet:
            continue
        victims.append((key, s))
    closed = []
    for key, s in victims:
        try:
            _note(key, _sid_of(s, key))
            async with reg._attach_lock:
                if reg._sessions.get(key) is not s or s.attached:      # someone came back in the meantime
                    continue
                reg._sessions.pop(key, None)
            seen.pop(key, None)
            await s.close()
            closed.append(key)
            _J["closed"] += 1
        except Exception as exc:                                       # one bad terminal must not stop the rest
            _J["last_error"] = f"{type(exc).__name__}: {exc}"
            _log.warning("lock in janitor: could not close a terminal: %s", exc)
    _J["last_tick"] = time.time()
    return closed


async def _janitor_loop() -> None:
    while True:
        await asyncio.sleep(_janitor_conf()["every"])
        try:
            await _janitor_tick()
        except Exception as exc:
            _J["last_error"] = f"{type(exc).__name__}: {exc}"


def _janitor_start() -> None:
    t = _J["task"]
    if t is None or t.done():
        _J["task"] = asyncio.get_running_loop().create_task(_janitor_loop())


@router.get("/janitor")
async def janitor_status():
    """Starts the janitor (the page calls this once when it loads) and says how it is doing. Read-only otherwise."""
    _janitor_start()
    reg = _registry()
    conf = _janitor_conf()
    pct = _mem_available_pct()
    now = time.monotonic()
    rows = []
    for key, s in (dict(reg._sessions).items() if reg is not None else []):
        rec = _J["seen"].get(key)
        rows.append({"attached": bool(getattr(s, "attached", False)),
                     "detachedFor": None if getattr(s, "last_detached_at", None) is None else round(now - s.last_detached_at),
                     "quietFor": None if not rec or "busyAt" not in rec else round(now - rec["busyAt"]),
                     "hasConversation": _sid_of(s, key) is not None,
                     "processes": (rec or {}).get("procs"),
                     "bytesPerSecond": None if (rec or {}).get("rate") is None else round(rec["rate"]),
                     "cpuShare": None if (rec or {}).get("cpuRate") is None else round(rec["cpuRate"], 3)})
    return {"running": bool(_J["task"] and not _J["task"].done()), "supported": reg is not None, "enabled": conf["enabled"],
            "graceSeconds": conf["grace"], "quietSeconds": conf["quiet"], "tight": _J["tight"],
            "memoryAvailablePct": None if pct is None else round(pct, 1), "terminals": rows,
            "closed": _J["closed"], "lastError": _J["last_error"]}


@router.post("/terminals/claim")
def terminals_claim(body: Dict[str, Any]):
    """For Lock In chat tabs whose terminal the janitor closed: which conversation each one was in.
    A note is handed out once and then deleted."""
    tokens = body.get("tokens") if isinstance(body, dict) else None
    if not isinstance(tokens, list) or len(tokens) > 50 or not all(isinstance(t, str) and _TOKEN.match(t) for t in tokens):
        raise HTTPException(status_code=400, detail="tokens must be a list of up to 50 attach tokens")
    notes = _notes_load()
    out = {}
    for t in tokens:
        n = notes.pop(t, None)
        if isinstance(n, dict) and isinstance(n.get("sid"), str) and _ID.match(n["sid"]):
            out[t] = n["sid"]
    if out:
        _notes_save(notes)
    return {"sids": out}


# ---- Word / Excel preview ---------------------------------------------------

_MAX_FILE = 25 * 1024 * 1024        # bigger files are not previewed
_MAX_XML = 40 * 1024 * 1024         # most XML we unpack from one part (zip-bomb guard)
_MAX_BLOCKS = 4000                  # paragraphs + tables per document
_MAX_ROWS, _MAX_COLS, _MAX_SHEETS = 1000, 60, 40

_W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
_M = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
_R = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
_PR = "{http://schemas.openxmlformats.org/package/2006/relationships}"


class _Bad(Exception):
    """The file cannot (or must not) be read; the message is safe to show."""


class _TooBig(_Bad):
    pass


class _Limited(io.RawIOBase):
    """Reads a zip member but stops at a size limit and refuses XML entity definitions."""

    def __init__(self, fh, limit: int):
        self._fh, self._left, self._first = fh, limit, True

    def readable(self) -> bool:
        return True

    def readinto(self, b) -> int:
        data = self.read(len(b))
        b[: len(data)] = data
        return len(data)

    def read(self, n: int = -1) -> bytes:
        n = 65536 if n is None or n < 0 else min(n, 1 << 20)
        data = self._fh.read(n)
        self._left -= len(data)
        if self._left < 0:
            raise _TooBig("This file unpacks to more than the viewer will read.")
        if self._first and data:
            self._first = False
            if b"<!ENTITY" in data or b"<!DOCTYPE" in data[:2048] and b"[" in data[:2048]:
                raise _Bad("This file contains XML definitions the viewer will not read.")
        return data


def _open(zf: zipfile.ZipFile, name: str, limit: int = _MAX_XML) -> _Limited:
    try:
        info = zf.getinfo(name)
    except KeyError:
        raise _Bad("This is not a complete document (a required part is missing).")
    if info.file_size > limit:
        raise _TooBig("This file unpacks to more than the viewer will read.")
    return _Limited(zf.open(info), limit)


def _parse(zf: zipfile.ZipFile, name: str) -> ET.Element:
    return ET.parse(_open(zf, name)).getroot()


def _on(el: Optional[ET.Element], ns: str = _W) -> bool:
    """A Word on/off property (<w:b/>, <w:b w:val="0"/>)."""
    if el is None:
        return False
    return str(el.get(ns + "val", "1")).lower() not in ("0", "false", "off")


# -- .docx

def _docx_styles(zf) -> Dict[str, Dict[str, Any]]:
    out: Dict[str, Dict[str, Any]] = {}
    if "word/styles.xml" not in zf.namelist():
        return out
    for st in _parse(zf, "word/styles.xml").iter(_W + "style"):
        sid = st.get(_W + "styleId")
        name = st.find(_W + "name")
        num = st.find(_W + "pPr/" + _W + "numPr")
        out[sid] = {
            "name": (name.get(_W + "val") if name is not None else sid or "").lower(),
            "num": (num.find(_W + "numId").get(_W + "val") if num is not None and num.find(_W + "numId") is not None else None),
            "ilvl": (num.find(_W + "ilvl").get(_W + "val") if num is not None and num.find(_W + "ilvl") is not None else None),
        }
    return out


def _docx_numbering(zf) -> Dict[Tuple[str, str], str]:
    """(numId, ilvl) → number format ('bullet', 'decimal', …)."""
    if "word/numbering.xml" not in zf.namelist():
        return {}
    root = _parse(zf, "word/numbering.xml")
    abstract: Dict[str, Dict[str, str]] = {}
    for a in root.findall(_W + "abstractNum"):
        lv = {}
        for l in a.findall(_W + "lvl"):
            f = l.find(_W + "numFmt")
            lv[l.get(_W + "ilvl", "0")] = f.get(_W + "val") if f is not None else "decimal"
        abstract[a.get(_W + "abstractNumId", "")] = lv
    out: Dict[Tuple[str, str], str] = {}
    for n in root.findall(_W + "num"):
        ref = n.find(_W + "abstractNumId")
        for ilvl, fmt in abstract.get(ref.get(_W + "val") if ref is not None else "", {}).items():
            out[(n.get(_W + "numId", ""), ilvl)] = fmt
    return out


def _runs(p: ET.Element) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    for r in p.iter(_W + "r"):
        txt = []
        for c in r:
            if c.tag == _W + "t":
                txt.append(c.text or "")
            elif c.tag == _W + "tab":
                txt.append("\t")
            elif c.tag in (_W + "br", _W + "cr"):
                txt.append("\n")
            elif c.tag == _W + "noBreakHyphen":
                txt.append("-")
            elif c.tag in (_W + "drawing", _W + "pict", _W + "object"):
                txt.append("[image]")
        s = "".join(txt)
        if not s:
            continue
        pr = r.find(_W + "rPr")
        fmt = {"b": _on(pr.find(_W + "b")) if pr is not None else False,
               "i": _on(pr.find(_W + "i")) if pr is not None else False,
               "u": (pr.find(_W + "u") is not None and pr.find(_W + "u").get(_W + "val") != "none") if pr is not None else False,
               "k": _on(pr.find(_W + "strike")) if pr is not None else False}
        if out and all(bool(out[-1].get(k)) == v for k, v in fmt.items()):
            out[-1]["x"] += s
        else:
            out.append(dict({k: 1 for k, v in fmt.items() if v}, x=s))
    return out


def _docx(zf) -> Dict[str, Any]:
    styles, numfmt = _docx_styles(zf), _docx_numbering(zf)
    body = _parse(zf, "word/document.xml").find(_W + "body")
    if body is None:
        raise _Bad("This document has no text body.")
    blocks: List[Dict[str, Any]] = []
    counters: Dict[Tuple[str, str], int] = {}
    state = {"trunc": False, "paras": 0, "tables": 0}

    def para(p: ET.Element) -> None:
        runs = _runs(p)
        if not runs:
            return
        ppr = p.find(_W + "pPr")
        sid = ppr.find(_W + "pStyle").get(_W + "val") if ppr is not None and ppr.find(_W + "pStyle") is not None else None
        st = styles.get(sid, {})
        name = st.get("name", "")
        blk: Dict[str, Any] = {"t": "p", "runs": runs}
        m = re.match(r"heading\s*(\d)", name)
        if m:
            blk["h"] = max(1, min(int(m.group(1)), 6))
        elif name == "title":
            blk["h"] = 1
        elif ppr is not None and ppr.find(_W + "outlineLvl") is not None:
            try:
                blk["h"] = min(int(ppr.find(_W + "outlineLvl").get(_W + "val")) + 1, 6)
            except (TypeError, ValueError):
                pass
        num = ppr.find(_W + "numPr") if ppr is not None else None
        nid = ilvl = None
        if num is not None:
            nid = num.find(_W + "numId").get(_W + "val") if num.find(_W + "numId") is not None else None
            ilvl = num.find(_W + "ilvl").get(_W + "val") if num.find(_W + "ilvl") is not None else None
        if nid is None:
            nid, ilvl = st.get("num"), st.get("ilvl")
        if nid and nid != "0" and "h" not in blk:
            ilvl = ilvl or "0"
            bullet = numfmt.get((nid, ilvl), "bullet") == "bullet"
            try:
                depth = int(ilvl)
            except ValueError:
                depth = 0
            key = (nid, ilvl)
            for k in [k for k in counters if k[0] == nid and k[1] > ilvl]:
                counters.pop(k)
            counters[key] = counters.get(key, 0) + 1
            blk["li"] = {"l": min(depth, 8), "o": 0 if bullet else counters[key]}
        jc = ppr.find(_W + "jc") if ppr is not None else None
        if jc is not None and jc.get(_W + "val") in ("center", "right"):
            blk["a"] = jc.get(_W + "val")
        blocks.append(blk)
        state["paras"] += 1

    def table(tbl: ET.Element) -> None:
        rows = []
        for tr in tbl.findall(_W + "tr"):
            cells = []
            for tc in tr.findall(_W + "tc"):
                text = "\n".join("".join(r["x"] for r in _runs(p)) for p in tc.iter(_W + "p"))
                span = tc.find(_W + "tcPr/" + _W + "gridSpan")
                try:
                    s = int(span.get(_W + "val")) if span is not None else 1
                except (TypeError, ValueError):
                    s = 1
                cells.append({"x": text.strip("\n"), "s": max(1, min(s, 60))})
            rows.append(cells)
            if len(rows) >= 500:
                state["trunc"] = True
                break
        if rows:
            blocks.append({"t": "tbl", "rows": rows})
            state["tables"] += 1

    def walk(parent: ET.Element) -> None:
        for el in parent:
            if len(blocks) >= _MAX_BLOCKS:
                state["trunc"] = True
                return
            if el.tag == _W + "p":
                para(el)
            elif el.tag == _W + "tbl":
                table(el)
            elif el.tag == _W + "sdt":
                inner = el.find(_W + "sdtContent")
                if inner is not None:
                    walk(inner)

    walk(body)
    return {"kind": "docx", "blocks": blocks, "truncated": state["trunc"],
            "paragraphs": state["paras"], "tables": state["tables"]}


# -- .xlsx

_BUILTIN_FMT = {1: "0", 2: "0.00", 3: "#,##0", 4: "#,##0.00", 9: "0%", 10: "0.00%"}
_BUILTIN_DATE = set(range(14, 23)) | set(range(27, 37)) | set(range(45, 48)) | set(range(50, 59))


def _plain_code(code: str) -> str:
    """A number format with quoted text, [..] parts and escapes removed (to look for date letters)."""
    c = re.sub(r'"[^"]*"', "", code)
    c = re.sub(r"\[[^\]]*\]", "", c)
    return re.sub(r"\\.|_.|\*.", "", c)


def _is_date(code: str) -> bool:
    c = _plain_code(code).lower()
    return c != "general" and re.search(r"[ymdhs]", c) is not None


def _general(v: float) -> str:
    if v == int(v) and abs(v) < 1e15:
        return str(int(v))
    return "%.15g" % v


def _fmt_number(v: float, code: Optional[str]) -> str:
    if not code or code.lower() == "general" or code == "@":
        return _general(v)
    sections = code.split(";")
    pick, neg = sections[0], v < 0
    if neg and len(sections) > 1:
        pick, neg = sections[1], False       # the format carries its own minus/brackets
    s = re.sub(r"\[\$([^\]\-]*)[^\]]*\]", r"\1", pick)
    s = re.sub(r"\[[^\]]*\]", "", s)
    s = re.sub(r'"([^"]*)"', r"\1", s)
    s = re.sub(r"\*.", "", s)
    s = re.sub(r"_.", " ", s)
    s = re.sub(r"\\(.)", r"\1", s)
    m = re.search(r"[#0?][#0?,]*(?:\.[0#?]*)?", s)
    if not m or re.search(r"[eE][+-]", s):
        return _general(v)
    prefix, num, suffix = s[: m.start()], m.group(0), s[m.end():]
    if "%" in prefix + suffix:
        v *= 100
    decimals = len(num.split(".")[1]) if "." in num else 0
    q = Decimal(repr(abs(v))).quantize(Decimal(1).scaleb(-decimals), rounding=ROUND_HALF_UP)
    int_fmt = num.split(".")[0]
    if "," in int_fmt:
        body = format(q, ",f")
    else:   # "000" means at least three integer digits
        ip, dot, fp = format(q, "f").partition(".")
        body = ip.zfill(int_fmt.count("0")) + dot + fp
    out = ("-" if neg and q != 0 else "") + prefix + body + suffix
    return out.strip()


def _xlsx_date(v: float, date1904: bool, code: str) -> str:
    c = _plain_code(code).lower()
    has_time = "h" in c or "s" in c or "am/pm" in c
    has_date = "y" in c or "d" in c or ("m" in c and not has_time)
    base = datetime.datetime(1904, 1, 1) if date1904 else datetime.datetime(1899, 12, 30)
    d = base + datetime.timedelta(days=v)
    if has_date and has_time:
        return d.strftime("%Y-%m-%d %H:%M")
    if has_time:
        return d.strftime("%H:%M:%S") if "s" in c else d.strftime("%H:%M")
    return d.strftime("%Y-%m-%d")


def _col(ref: str) -> int:
    n = 0
    for ch in re.match(r"[A-Za-z]*", ref or "").group(0):
        n = n * 26 + (ord(ch.upper()) - 64)
    return n


def _si_text(si: ET.Element) -> str:
    parts = []
    for c in si:
        if c.tag == _M + "t":
            parts.append(c.text or "")
        elif c.tag == _M + "r":
            parts.extend(t.text or "" for t in c.findall(_M + "t"))
    return "".join(parts)


def _xlsx(zf) -> Dict[str, Any]:
    names = set(zf.namelist())
    wb = _parse(zf, "xl/workbook.xml")
    wpr = wb.find(_M + "workbookPr")
    date1904 = wpr is not None and str(wpr.get("date1904", "0")).lower() in ("1", "true")
    rels: Dict[str, str] = {}
    if "xl/_rels/workbook.xml.rels" in names:
        for r in _parse(zf, "xl/_rels/workbook.xml.rels").iter(_PR + "Relationship"):
            t = r.get("Target", "")
            rels[r.get("Id", "")] = t.lstrip("/") if t.startswith("/") else "xl/" + t
    shared: List[str] = []
    if "xl/sharedStrings.xml" in names:
        for _ev, el in ET.iterparse(_open(zf, "xl/sharedStrings.xml"), events=("end",)):
            if el.tag == _M + "si":
                shared.append(_si_text(el))
                el.clear()
                if len(shared) > 400000:
                    raise _TooBig("This workbook has more text than the viewer will read.")
    custom: Dict[int, str] = {}
    xf_fmt: List[int] = []
    if "xl/styles.xml" in names:
        st = _parse(zf, "xl/styles.xml")
        for nf in st.iter(_M + "numFmt"):
            try:
                custom[int(nf.get("numFmtId"))] = nf.get("formatCode", "")
            except (TypeError, ValueError):
                pass
        xfs = st.find(_M + "cellXfs")
        for xf in (xfs if xfs is not None else []):
            try:
                xf_fmt.append(int(xf.get("numFmtId", "0")))
            except ValueError:
                xf_fmt.append(0)

    def code_of(style: int) -> Optional[str]:
        fid = xf_fmt[style] if 0 <= style < len(xf_fmt) else 0
        return custom.get(fid) or ("date" if fid in _BUILTIN_DATE else _BUILTIN_FMT.get(fid))

    def cell_value(c: ET.Element) -> Optional[List[str]]:
        t = c.get("t")
        v = c.find(_M + "v")
        raw = v.text if v is not None and v.text is not None else None
        if t == "inlineStr":
            is_ = c.find(_M + "is")
            return [_si_text(is_), "s"] if is_ is not None else None
        if raw is None or raw == "":
            return None
        if t == "s":
            try:
                return [shared[int(raw)], "s"]
            except (ValueError, IndexError):
                return None
        if t in ("str",):
            return [raw, "s"]
        if t == "b":
            return ["TRUE" if raw.strip() not in ("0", "false") else "FALSE", "b"]
        if t == "e":
            return [raw, "e"]
        if t == "d":
            return [raw, "d"]
        try:
            num = float(raw)
        except ValueError:
            return [raw, "s"]
        if num != num or num in (float("inf"), float("-inf")):
            return [raw, "s"]
        try:
            style = int(c.get("s", "0"))
        except ValueError:
            style = 0
        code = code_of(style)
        if code and (code == "date" or _is_date(code)):
            try:
                return [_xlsx_date(num, date1904, "yyyy-mm-dd" if code == "date" else code), "d"]
            except (OverflowError, ValueError):
                pass
        return [_fmt_number(num, code), "n"]

    sheets_meta = []
    for s in wb.iter(_M + "sheet"):
        sheets_meta.append({"name": s.get("name", "Sheet"), "state": s.get("state", "visible"),
                            "path": rels.get(s.get(_R + "id", ""))})
    shown = [s for s in sheets_meta if s["state"] == "visible"] or sheets_meta
    out_sheets = []
    for meta in shown[:_MAX_SHEETS]:
        rows: List[List[Any]] = []
        ncols, trunc, cols_trunc = 0, False, False
        if meta["path"] in names:
            last_row = 0
            for _ev, el in ET.iterparse(_open(zf, meta["path"], _MAX_XML * 4), events=("end",)):
                if el.tag != _M + "row":
                    continue
                try:
                    rnum = int(el.get("r"))
                except (TypeError, ValueError):
                    rnum = last_row + 1
                last_row = rnum
                cells: Dict[int, List[str]] = {}
                nxt = 0
                for c in el.findall(_M + "c"):
                    ci = _col(c.get("r", "")) or nxt + 1
                    nxt = ci
                    val = cell_value(c)
                    if val is None:
                        continue
                    if ci > _MAX_COLS:
                        cols_trunc = True
                        continue
                    cells[ci] = val
                el.clear()
                if not cells:
                    continue
                if len(rows) >= _MAX_ROWS:
                    trunc = True
                    break
                top = max(cells)
                ncols = max(ncols, top)
                rows.append([rnum, [cells.get(i) for i in range(1, top + 1)]])
        out_sheets.append({"name": meta["name"], "rows": rows, "ncols": ncols,
                           "truncated": trunc, "colsTruncated": cols_trunc})
    return {"kind": "xlsx", "sheets": out_sheets, "sheetsTruncated": len(shown) > _MAX_SHEETS}


@router.get("/preview")
def preview(path: str, profile: str = "default"):
    prof = _profile(profile)
    root_s = _load().get(prof["name"])
    if not root_s:
        raise HTTPException(status_code=404, detail="Open Lock In for this profile first.")
    if not os.path.isabs(path or ""):
        raise HTTPException(status_code=400, detail="Path must be absolute")
    try:
        target = Path(path).resolve(strict=True)
        root = Path(root_s).resolve()
    except (FileNotFoundError, NotADirectoryError):
        raise HTTPException(status_code=404, detail="File not found")
    except (OSError, RuntimeError, ValueError):
        raise HTTPException(status_code=400, detail="Invalid path")
    if root not in target.parents:
        raise HTTPException(status_code=403, detail="That file is outside this profile's folder")
    if not target.is_file():
        raise HTTPException(status_code=400, detail="Path is not a file")
    kind = {".docx": "docx", ".xlsx": "xlsx"}.get(target.suffix.lower())
    if not kind:
        raise HTTPException(status_code=415, detail="Only .docx and .xlsx files can be previewed")
    if target.stat().st_size > _MAX_FILE:
        raise HTTPException(status_code=413, detail="File is too large to preview (over 25 MB)")
    try:
        with zipfile.ZipFile(target) as zf:
            data = _docx(zf) if kind == "docx" else _xlsx(zf)
    except _TooBig as exc:
        raise HTTPException(status_code=413, detail=str(exc))
    except _Bad as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    except (zipfile.BadZipFile, ET.ParseError, OSError, RuntimeError, ValueError, KeyError, AttributeError, OverflowError):
        raise HTTPException(status_code=422, detail="This file could not be read. It may be damaged, password-protected or not a real ." + kind + " file.")
    data["name"] = target.name
    data["size"] = target.stat().st_size
    return data
