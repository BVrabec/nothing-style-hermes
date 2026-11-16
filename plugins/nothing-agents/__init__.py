"""nothing-agents: named subagents for a Hermes profile.

The team lives in ``$HERMES_HOME/nothing-agents/team.json`` (one file per
profile, written by the dashboard tab). This side does two things:

* a system-prompt section that tells the soul who is on its team and when to
  call each one (frozen into every new session, like any plugin section);
* the ``call_subagent`` tool, which hands the work to the named subagent with
  that subagent's model, allowed toolsets (never more than the soul has) and
  role, its standing instructions in the context, and waits for its report.
  Effort, timeouts, depth and approvals stay Hermes's own (``delegation:``).

Where the subagent runs
-----------------------
* No ``provider`` on the subagent (the default, and every team saved before
  1.2.0): it is launched through Hermes's public ``ctx.subagent_lifecycle`` API
  and runs on the soul's provider, exactly as before.
* A ``provider`` on the subagent (1.2.0): the lifecycle API has no provider
  field (its child is always built on the parent's provider), so this side
  builds the child itself the way ``delegate_task`` does -- the credential
  bundle for that provider is resolved *at call time* from the active
  profile's own credential store with ``resolve_runtime_provider`` and passed
  to Hermes's own child builder as ``override_*`` arguments -- and runs it with
  the host's own child lifecycle. The parent is never touched.

That path never falls back: a provider that cannot be resolved, that resolves
to a different provider than the one asked for, or that comes without a
credential or endpoint ends in a tool error naming the provider and **no child
is created**. Credentials live only in memory for the duration of the call:
never in ``team.json``, never in a tool result, never in a log line.
"""

from __future__ import annotations

import json
import logging
import re
from pathlib import Path
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

TEAM_FILE = ("nothing-agents", "team.json")
SECTION_ID = "nothing-agents.team"

# A provider id as Hermes spells them: ``anthropic``, ``openrouter``, ``zai``, ``custom:my-endpoint``,
# ``anthropic@azure``. ``auto`` means "whatever the profile is on", which is exactly the silent
# inheritance a per-subagent provider exists to avoid, so it is not accepted.
PROVIDER_RE = re.compile(r"^[a-z0-9][a-z0-9_.:@-]{0,63}$")
# Providers addressed by their SDK rather than a URL: a resolved bundle may legitimately carry no base_url.
_NATIVE_SDK_PROVIDERS = frozenset({"bedrock", "vertex", "google", "google-genai"})


def _home() -> Path:
    from hermes_constants import get_hermes_home
    return Path(get_hermes_home())


def load_team(home: Optional[Path] = None) -> Dict[str, Any]:
    path = (home or _home()).joinpath(*TEAM_FILE)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {"orchestrator": {}, "subagents": []}
    except Exception as exc:  # unreadable file: behave as an empty team
        logger.warning("nothing-agents: cannot read %s: %s", path, exc)
        return {"orchestrator": {}, "subagents": []}
    if not isinstance(data, dict):
        return {"orchestrator": {}, "subagents": []}
    subs = [s for s in data.get("subagents") or [] if isinstance(s, dict) and str(s.get("name") or "").strip()]
    return {"orchestrator": data.get("orchestrator") or {}, "subagents": subs}


def _find(team: Dict[str, Any], name: str) -> Optional[Dict[str, Any]]:
    want = (name or "").strip().lower()
    for s in team["subagents"]:
        if str(s.get("name", "")).strip().lower() == want:
            return s
    return None


class ProviderError(Exception):
    """A subagent's own provider cannot be used. The message is safe to show: it never holds a credential."""


def normalize_provider(raw: Any) -> str:
    """A provider id in canonical form, ``""`` for none. Raises :class:`ProviderError` for a value that is
    present but unusable: quietly treating a typo as "inherit" would send the work to the soul's account."""
    if raw is None:
        return ""
    if not isinstance(raw, str):
        raise ProviderError("its provider setting is not text")
    p = raw.strip().lower()
    if not p:
        return ""
    if p == "auto" or not PROVIDER_RE.match(p):
        raise ProviderError(f"{raw.strip()!r} is not a usable provider name")
    return p


def declared_provider(sub: Dict[str, Any]) -> str:
    """The subagent's own provider, or ``""`` when it follows the soul (today's behaviour)."""
    return normalize_provider(sub.get("provider"))


def render_section(_session_info: Any = None) -> str:
    team = load_team()
    subs: List[Dict[str, Any]] = team["subagents"]
    if not subs:
        return ""
    lines = [
        "## Your subagents",
        "You lead a small team of named subagents. When a task clearly fits one of them, hand it over with "
        "the `call_subagent` tool (name, goal, context) instead of a generic `delegate_task`. It runs on that "
        "subagent's own model and tools, and its report comes back as the tool result. If `call_subagent` is "
        "not in your tool list, run it through `tool_call` (name \"call_subagent\"). Do simple things yourself.",
        "",
    ]
    for s in subs:
        when = str(s.get("when") or "").strip() or "no rule set; use your judgement"
        model = str(s.get("model") or "").strip() or "your model"
        own = str(s.get("provider") or "").strip().lower()
        if own and own != "auto":
            model = f"{model} on {own}"
        line = f"- **{s['name']}** ({model}): {when}"
        lines.append(line if len(line) <= 300 else line[:297] + "...")
    text = "\n".join(lines)
    return text if len(text) <= 3900 else text[:3897] + "..."


CALL_SUBAGENT_SCHEMA = {
    "name": "call_subagent",
    "description": (
        "Hand a task to one of your named subagents (listed under 'Your subagents' in your instructions). "
        "It runs on that subagent's own model, tools and standing instructions; this call waits for it "
        "and returns its report."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "name": {"type": "string", "description": "The subagent's name, exactly as listed."},
            "goal": {"type": "string", "description": "What it should accomplish. Self-contained: it does not see this conversation."},
            "context": {"type": "string", "description": "Background it needs: paths, constraints, prior findings."},
        },
        "required": ["name", "goal"],
    },
}


_CTX = None  # the PluginContext, kept for its public subagent_lifecycle service


def _summary(res) -> Dict[str, Any]:
    state = getattr(getattr(res, "terminal_state", None), "value", str(getattr(res, "terminal_state", "")))
    out: Dict[str, Any] = {"state": state}
    if getattr(res, "summary", None):
        out["summary"] = res.summary
    if getattr(res, "error_message", None):
        out["error"] = res.error_message
    usage = getattr(res, "usage_metadata", None) or {}
    if usage.get("api_calls"):
        out["api_calls"] = usage["api_calls"]
    return out


# ---- a subagent on its own provider -----------------------------------------------------------

_KEY_SHAPES = re.compile(r"(sk-[A-Za-z0-9_\-]{12,}|(?i:bearer)\s+[A-Za-z0-9._\-]{12,})")


def _scrub(value: Any, secrets: Any = ()) -> str:
    """Text that is safe to return or log: the credential this call resolved, and anything shaped like an
    API key or bearer token, is replaced. Defence in depth: nothing here is expected to contain one."""
    text = str(value)
    for secret in secrets:
        if isinstance(secret, str) and len(secret) >= 6:
            text = text.replace(secret, "[redacted]")
    return _KEY_SHAPES.sub("[redacted]", text)


def _serves_provider(runtime: Dict[str, Any], requested: str) -> bool:
    """True only when the runtime that came back really is the provider that was asked for.

    ``resolve_runtime_provider`` ends in an OpenRouter / bare-custom fallback that always yields a runtime
    (with the profile's OpenRouter key). Asked for a provider that is not set up, it can hand that back
    instead of raising -- which would put the subagent on the soul's account again. So the answer is only
    trusted when it names the requested provider (or its canonical id), or is ``custom`` for a request that
    genuinely is a custom endpoint."""
    got = str(runtime.get("provider") or "").strip().lower()
    if not got:
        return False
    if got == requested:
        return True
    try:
        from hermes_cli.auth import resolve_provider
        if got == str(resolve_provider(requested) or "").strip().lower():
            return True
    except Exception:
        pass
    if got == "custom":
        try:
            from hermes_cli.runtime_provider import expand_direct_api_alias, has_named_custom_provider
            return (requested == "custom" or has_named_custom_provider(requested)
                    or expand_direct_api_alias(requested, None)[0] == "custom")
        except Exception:
            return False
    return False


def resolve_provider_bundle(provider: str, model: str) -> Dict[str, Any]:
    """The credential bundle for a subagent's own provider, resolved now from the active profile.

    Raises :class:`ProviderError` (message safe to show) when the provider cannot be resolved, resolves to
    another provider, or comes back without a credential or an endpoint. Never returns a fallback."""
    try:
        from hermes_cli.runtime_provider import resolve_runtime_provider
    except Exception:
        raise ProviderError("this Hermes cannot resolve providers at call time (hermes_cli.runtime_provider is missing)") from None
    try:
        runtime = resolve_runtime_provider(requested=provider, target_model=model or None)
    except Exception as exc:
        raise ProviderError(f"it cannot be resolved for this profile: {_scrub(exc)}") from None
    if not isinstance(runtime, dict):
        raise ProviderError("it did not resolve to a runtime")
    secrets = (runtime.get("api_key"),)
    if not _serves_provider(runtime, provider):
        raise ProviderError(
            f"it is not set up for this profile (Hermes offered {str(runtime.get('provider') or 'nothing')!r} instead); "
            "run 'hermes auth' for that provider, or pick another")
    api_key = runtime.get("api_key")
    if not (callable(api_key) or (isinstance(api_key, str) and api_key.strip())):
        raise ProviderError("it resolved but has no credential (run 'hermes auth' for that provider)")
    command = runtime.get("command")
    base_url = str(runtime.get("base_url") or "").strip()
    if not base_url and not command and provider not in _NATIVE_SDK_PROVIDERS:
        raise ProviderError("it resolved without an endpoint (base_url), so there is nowhere to send the work")
    resolved = str(runtime.get("provider") or "").strip().lower()
    return {
        "provider": provider if resolved == "custom" else resolved,
        "model": (model or str(runtime.get("model") or "").strip()) or None,
        "base_url": base_url or None,
        "api_key": api_key,
        "api_mode": runtime.get("api_mode") or None,  # derived for THAT provider; never read from the parent
        "request_overrides": dict(runtime.get("request_overrides") or {}),
        "command": command or None,
        "args": list(runtime.get("args") or []),
        "_secrets": secrets,
    }


def provider_problem(provider: str, model: str = "") -> Optional[str]:
    """Why the active profile cannot use ``provider`` right now, or ``None`` when it can. This is the very
    resolution ``call_subagent`` performs, so the dashboard can tell the operator at save time what the
    tool would say at call time. The answer never contains a credential."""
    try:
        resolve_provider_bundle(provider, model)
    except ProviderError as exc:
        return str(exc)
    return None


def _norm_url(value: Any) -> str:
    return str(value or "").strip().rstrip("/").lower()


def _run_on_own_provider(sub: Dict[str, Any], provider: str, goal: str, context: str, tools: tuple, role: str) -> str:
    """Build the subagent's child on its own provider and run it. See the module docstring."""
    from tools.registry import tool_error
    who = sub["name"]
    model = str(sub.get("model") or "").strip()
    try:
        bundle = resolve_provider_bundle(provider, model)
    except ProviderError as exc:
        return tool_error(f"{who} could not start: provider {provider!r}: {exc}. No subagent was started; "
                          "it does not fall back to your own provider.")
    secrets = bundle["_secrets"]
    if not bundle["model"]:
        return tool_error(f"{who} could not start: it has provider {provider!r} but no model, and your model "
                          f"would be sent to that provider. Set a model for {who}. No subagent was started.")
    try:
        from agent.subagent_lifecycle import get_active_subagent_parent
        from tools.delegate_tool import DEFAULT_MAX_ITERATIONS, _build_child_preserving_parent_tools, _run_child_lifecycle
    except Exception as exc:
        return tool_error(f"{who} could not start: this Hermes cannot build a subagent on its own provider "
                          f"({type(exc).__name__}); update nothing-agents or Hermes. No subagent was started.")
    parent = get_active_subagent_parent()
    if parent is None:
        return tool_error(f"{who} could not start: no active Hermes parent session is available.")
    if tools:  # the same rules the lifecycle API applies to a launch request
        from toolsets import TOOLSETS
        unknown = sorted(set(tools) - set(TOOLSETS))
        if unknown:
            return tool_error(f"{who} could not start: Unknown toolsets: {', '.join(unknown)}.")
        enabled = getattr(parent, "enabled_toolsets", None)
        if enabled is not None and not set(tools).issubset(set(enabled)):
            return tool_error(f"{who} could not start: Requested toolsets would broaden parent permissions.")

    logger.info("nothing-agents: %s runs on provider %s, model %s", who, bundle["provider"], bundle["model"])
    try:
        child = _build_child_preserving_parent_tools(
            task_index=0, goal=goal, context=context, toolsets=list(tools) if tools else None,
            model=bundle["model"], max_iterations=DEFAULT_MAX_ITERATIONS, task_count=1, parent_agent=parent, role=role,
            override_provider=bundle["provider"], override_base_url=bundle["base_url"],
            override_api_key=bundle["api_key"], override_api_mode=bundle["api_mode"],
            override_request_overrides=bundle["request_overrides"],
            override_acp_command=bundle["command"], override_acp_args=bundle["args"] or None,
        )
    except Exception as exc:
        return tool_error(f"{who} could not start on provider {provider!r}: {_scrub(exc, secrets)}. "
                          "No subagent was started.")

    # Belt and braces: whatever a future Hermes does with the overrides, a child that is not on the
    # endpoint it was asked for is never run -- that would be the parent's account again, silently.
    if bundle["base_url"] and _norm_url(getattr(child, "base_url", "")) != _norm_url(bundle["base_url"]):
        try:
            child.close()
        except Exception:
            pass
        return tool_error(f"{who} could not start: Hermes built it on {getattr(child, 'base_url', None)!r} instead of "
                          f"provider {provider!r}'s endpoint, so it was not run. No work was sent anywhere.")

    try:
        raw = _run_child_lifecycle(0, goal, child, parent)
        raw = raw if isinstance(raw, dict) else {}
        status = str(raw.get("status", "error"))
        out: Dict[str, Any] = {"state": "INTERRUPTED" if status == "interrupted" else "SUCCEEDED" if status == "completed" else "FAILED"}
        if raw.get("summary"):
            out["summary"] = _scrub(raw["summary"], secrets)[:32000]
        if raw.get("error"):
            out["error"] = _scrub(raw["error"], secrets)[:32000]
        if raw.get("api_calls"):
            out["api_calls"] = raw["api_calls"]
    except Exception as exc:
        out = {"state": "FAILED", "error": _scrub(f"{type(exc).__name__}: {exc}", secrets)[:32000]}
    return json.dumps({"subagent": who, "model": getattr(child, "model", None) or bundle["model"],
                       "provider": bundle["provider"], **out}, ensure_ascii=False)


def call_subagent(args: Dict[str, Any], **_kw) -> str:
    """Hand the task to the named subagent -- on the soul's provider, or on its own when it has one -- and wait."""
    from tools.registry import tool_error
    name = str(args.get("name") or "").strip()
    goal = str(args.get("goal") or "").strip()
    if not name or not goal:
        return tool_error("call_subagent needs a name and a goal.")
    team = load_team()
    sub = _find(team, name)
    if sub is None:
        known = ", ".join(s["name"] for s in team["subagents"]) or "none"
        return tool_error(f"No subagent named {name!r}. Your subagents: {known}.")

    try:
        provider = declared_provider(sub)
    except ProviderError as exc:
        return tool_error(f"{sub['name']} could not start: provider: {exc}. No subagent was started.")

    if not provider and (_CTX is None or not hasattr(_CTX, "subagent_lifecycle")):
        return tool_error("This Hermes has no subagent lifecycle API; update Hermes to use named subagents.")

    lead = str((team.get("orchestrator") or {}).get("name") or "your orchestrator").strip()
    standing = [f"You are {sub['name']}, a named subagent working for {lead}."]
    if str(sub.get("instructions") or "").strip():
        standing.append("Standing instructions:\n" + str(sub["instructions"]).strip())
    if str(args.get("context") or "").strip():
        standing.append(str(args["context"]).strip())
    context = "\n\n".join(standing)[:32000]
    tools = tuple(str(t) for t in (sub.get("tools") or []) if str(t).strip())
    role = "orchestrator" if sub.get("can_delegate") else "leaf"

    if provider:
        return _run_on_own_provider(sub, provider, goal[:16000], context, tools, role)

    # No provider on the subagent: Hermes's public lifecycle API, on the soul's provider, as before.
    from agent.subagent_lifecycle import SubagentLaunchRequest, SubagentLifecycleError
    request = SubagentLaunchRequest(
        goal=goal[:16000], context=context,
        role=role,
        model=str(sub.get("model") or "").strip() or None,
        allowed_toolsets=tools or None,
        metadata={"plugin": "nothing-agents", "subagent": sub["name"]},
    )
    service = _CTX.subagent_lifecycle
    try:
        handle = service.launch(request)
    except SubagentLifecycleError as exc:
        return tool_error(f"{sub['name']} could not start: {exc}")
    service.wait(handle)
    result = service.result(handle)
    return json.dumps({"subagent": sub["name"], "model": getattr(handle, "model", None), **_summary(result)}, ensure_ascii=False)


def register(ctx) -> None:
    global _CTX
    _CTX = ctx
    ctx.register_tool(
        name="call_subagent", toolset="nothing-agents", schema=CALL_SUBAGENT_SCHEMA,
        handler=call_subagent, description="Hand a task to a named subagent", emoji="🧩",
    )
    if hasattr(ctx, "register_system_prompt_section"):
        ctx.register_system_prompt_section(SECTION_ID, render_section, position="after_memory", max_chars=4000)
