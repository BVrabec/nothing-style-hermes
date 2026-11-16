"""nothing-hud backend — authoritative spend figures for the Analytics hero.

Mounted by the dashboard at /api/plugins/nothing-hud/ (behind its auth gate).

GET /spend asks OpenRouter for the key's usage and the account credit, the same
two calls ~/.hermes/scripts/spend_report.py makes for /spend, and returns only
the figures. The key never leaves this process. Results are cached for 60s.

Honcho's spend (the memory service's own OpenRouter key) is read with a separate
OpenRouter *Management* key kept in ~/.hermes/openrouter-usage.key (mode 600, NOT
in .env, so it never reaches the agent's environment). A Management key cannot make
model requests; it can only list keys. This code asks for the key list, picks ONE
key by name (Honcho), and returns six numbers from it. No other key's name or
figures, and no key value or hash, ever leaves this process.
"""

import json
import os
import time
import urllib.request
from pathlib import Path

from fastapi import APIRouter

router = APIRouter()

_API = "https://openrouter.ai/api/v1"
_TTL_S = 60
_cache = {"at": 0.0, "body": None}

# The one extra key shown next to Hermes's own, matched by its name in OpenRouter.
_MEMORY_KEY_NAME = "honcho"
_USAGE_KEY_FILE = "openrouter-usage.key"


def _hermes_home() -> Path:
    try:
        from hermes_constants import get_hermes_home

        return Path(get_hermes_home())
    except Exception:
        return Path(os.environ.get("HERMES_HOME") or Path.home() / ".hermes")


def _api_key():
    key = os.environ.get("OPENROUTER_API_KEY")
    if key:
        return key.strip()
    try:
        for line in (_hermes_home() / ".env").read_text(errors="ignore").splitlines():
            if line.startswith("OPENROUTER_API_KEY="):
                return line.split("=", 1)[1].strip().strip('"').strip("'") or None
    except OSError:
        pass
    return None


def _get(path: str, key: str) -> dict:
    req = urllib.request.Request(_API + path, headers={"Authorization": "Bearer " + key})
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.load(resp).get("data") or {}


def _num(value):
    try:
        return round(float(value), 4)
    except (TypeError, ValueError):
        return None


def _usage_key():
    """The Management key, from its own root-only file; None when absent or unreadable."""
    path = _hermes_home() / _USAGE_KEY_FILE
    try:
        key = path.read_text(errors="ignore").strip()
    except OSError:
        return None
    return key or None


def _memory_usage() -> dict:
    """Honcho's figures, or {"reason": ...}. Whitelists fields; never returns other keys."""
    mgmt = _usage_key()
    if not mgmt:
        return {"reason": "no-usage-key"}
    try:
        req = urllib.request.Request(_API + "/keys", headers={"Authorization": "Bearer " + mgmt})
        with urllib.request.urlopen(req, timeout=15) as resp:
            rows = json.load(resp).get("data") or []
    except Exception:
        return {"reason": "unreachable"}
    for row in rows if isinstance(rows, list) else []:
        if isinstance(row, dict) and str(row.get("name") or "").strip().lower() == _MEMORY_KEY_NAME and not row.get("disabled"):
            return {
                "today": _num(row.get("usage_daily")),
                "week": _num(row.get("usage_weekly")),
                "month": _num(row.get("usage_monthly")),
                "cap": _num(row.get("limit")),
                "capLeft": _num(row.get("limit_remaining")),
            }
    return {"reason": "not-found"}


def _fetch() -> dict:
    key = _api_key()
    if not key:
        return {"ok": False, "reason": "no-key"}
    try:
        kd = _get("/key", key)
        cd = _get("/credits", key)
    except Exception:
        return {"ok": False, "reason": "unreachable"}
    credits = _num(cd.get("total_credits"))
    used = _num(cd.get("total_usage"))
    mem = _memory_usage()
    return {
        "honcho": mem if "reason" not in mem else None,
        "honchoReason": mem.get("reason"),
        "ok": True,
        "today": _num(kd.get("usage_daily")),
        "week": _num(kd.get("usage_weekly")),
        "month": _num(kd.get("usage_monthly")),
        "lifetime": _num(kd.get("usage")),
        "cap": _num(kd.get("limit")),
        "capLeft": _num(kd.get("limit_remaining")),
        "reset": kd.get("limit_reset"),
        "credits": credits,
        "creditLeft": round(credits - used, 4) if credits is not None and used is not None else None,
        "asOf": int(time.time()),
    }


@router.get("/spend")
def spend():  # sync: FastAPI runs it in a worker thread, so urllib cannot block the loop
    now = time.time()
    if _cache["body"] is None or now - _cache["at"] > _TTL_S:
        _cache["body"] = _fetch()
        _cache["at"] = now
    return _cache["body"]


# ---- the /login page in the Nothing style ------------------------------------
#
# Hermes renders /login itself (plain HTML, before any theme or plugin loads)
# and has no styling hook for it. While a Nothing Neu theme is selected, this
# wraps the renderer the login route calls and adds ONE stylesheet link (plus
# data-nh-mode on <html> for dark/white). The form, its fields, the provider
# list and the sign-in script are Hermes's own and unchanged. The stylesheet
# is served from /dashboard-plugins/, which the auth gate already allows
# before sign-in. Anything unexpected → the stock page is returned as is.

_LOGIN_THEMES = {"nothing-neu": "dark", "nothing-neu-light": "light"}


def _login_mode():
    try:
        from hermes_cli.config import load_config_readonly
        theme = ((load_config_readonly() or {}).get("dashboard") or {}).get("theme")
    except Exception:
        return None
    return _LOGIN_THEMES.get(str(theme or "").strip())


def _style_login(html_out, prefix=""):
    mode = _login_mode()
    if not mode or not isinstance(html_out, str) or "</head>" not in html_out or "nh-login-css" in html_out:
        return html_out
    href = f"{prefix or ''}/dashboard-plugins/nothing-hud/dist/login.css"
    link = f'<link id="nh-login-css" rel="stylesheet" href="{href}">\n</head>'
    html_out = html_out.replace("</head>", link, 1)
    return html_out.replace('<html lang="en">', f'<html lang="en" data-nh-mode="{mode}">', 1)


def _install_login_style():
    try:
        from hermes_cli.dashboard_auth import routes as _routes
    except Exception:
        return  # no auth gate in this Hermes: nothing to style
    original = getattr(_routes, "render_login_html", None)
    if original is None or getattr(original, "_nothing_hud", False):
        return

    def render_login_html(*args, **kwargs):
        html_out = original(*args, **kwargs)
        try:
            return _style_login(html_out, kwargs.get("prefix", ""))
        except Exception:
            return html_out

    render_login_html._nothing_hud = True
    _routes.render_login_html = render_login_html


_install_login_style()
