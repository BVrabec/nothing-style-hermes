/*
 * nothing-agents — the Subagents tab (/subagents).
 *
 * One map per profile: the profile's soul (the orchestrator) on top, its
 * named subagents in rows below, joined by dashed lines. Click the soul for
 * its panel (model, SOUL.md, what it is connected to, team rules); click a
 * subagent to edit it (name, colour, model, when it is called, instructions).
 *
 * Storage: the team is this plugin's own file per profile (GET/PUT
 * /api/plugins/nothing-agents/team). Team rules are Hermes's own
 * `delegation:` settings, saved through the dashboard's PUT /api/config.
 * SOUL.md is read and written through the dashboard's own profile API.
 *
 * Plain IIFE, no build step: React and fetchJSON come from the plugin SDK.
 */
(function () {
  "use strict";

  var SDK = window.__HERMES_PLUGIN_SDK__;
  var REG = window.__HERMES_PLUGINS__;
  if (!SDK || !REG || !SDK.React) return;

  var h = SDK.React.createElement;
  var useState = SDK.hooks.useState;
  var useEffect = SDK.hooks.useEffect;
  var useRef = SDK.hooks.useRef;
  var API = "/api/plugins/nothing-agents";

  // ---- palette: the Neu themes' accents plus five that sit beside them ----
  var PALETTE = ["violet", "indigo", "sky", "teal", "mint", "amber", "coral", "rose", "red", "graphite"];
  var HEX = {
    dark: { violet: "#A58BFF", indigo: "#8C9BFF", sky: "#6CB8FF", teal: "#4FD6D0", mint: "#5ED3A8",
      amber: "#F2B84B", coral: "#FF8A65", rose: "#FF7AA8", red: "#E5383B", graphite: "#9A9CA6" },
    light: { violet: "#7A5CFA", indigo: "#4F5FD6", sky: "#2F7FD8", teal: "#128C87", mint: "#1FA67A",
      amber: "#C98A12", coral: "#D9582B", rose: "#D6407A", red: "#D71921", graphite: "#5E6170" },
  };
  function mode() {
    return getComputedStyle(document.documentElement).getPropertyValue("--neu-mode").trim() === "light" ? "light" : "dark";
  }
  function useMode() {
    var s = useState(mode());
    useEffect(function () {
      var mo = new MutationObserver(function () { s[1](mode()); });
      mo.observe(document.head, { childList: true, subtree: true, characterData: true });
      mo.observe(document.documentElement, { attributes: true });
      return function () { mo.disconnect(); };
    }, []);
    return s[0];
  }
  function hex(m, c) { return HEX[m][c] || HEX[m].violet; }

  // ---- dot-matrix avatar, mirror-symmetric, seeded by the name ----------
  function seedBytes(str) {
    var x = 2166136261 >>> 0, out = [];
    for (var i = 0; i < str.length; i++) { x ^= str.charCodeAt(i); x = Math.imul(x, 16777619) >>> 0; }
    for (var j = 0; j < 48; j++) { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; out.push(x & 255); }
    return out;
  }
  function Avatar(props) {
    var n = props.n || 11, px = props.px, step = px / n, half = (n + 1) >> 1;
    var b = seedBytes(String(props.name || "?").toLowerCase());
    var dots = [];
    for (var y = 0; y < n; y++) {
      for (var x = 0; x < half; x++) {
        var on = (b[(y * half + x) % b.length] >> ((x + y) % 8)) & 1;
        if ((y === 0 || y === n - 1) && x < 2) on = 0;
        if ((y === 1 || y === n - 2) && x === 0) on = 0;
        if (y === 3 && x === half - 3) on = 1;
        var xs = x === n - 1 - x ? [x] : [x, n - 1 - x];
        for (var k = 0; k < xs.length; k++) {
          dots.push(h("circle", { key: y + "-" + xs[k], cx: (step * (xs[k] + 0.5)).toFixed(1), cy: (step * (y + 0.5)).toFixed(1),
            r: (step * (on ? 0.36 : 0.22)).toFixed(1), fill: on ? props.colour : "currentColor",
            opacity: on ? 1 : 0.16, style: on ? { filter: "drop-shadow(0 0 2px " + props.colour + ")" } : null }));
        }
      }
    }
    return h("svg", { className: "nha-av", width: px, height: px, viewBox: "0 0 " + px + " " + px, "aria-hidden": "true" }, dots);
  }

  // ---- data helpers -----------------------------------------------------
  function shownProfile() {
    var p = new URLSearchParams(window.location.search).get("profile");
    return p && p.trim() ? p.trim() : null;
  }
  function useProfile() {
    var url = useState(shownProfile());
    var act = useState(null);
    useEffect(function () {
      var id = setInterval(function () { url[1](shownProfile()); }, 1000);
      SDK.fetchJSON("/api/profiles/active").then(function (d) { act[1]((d && (d.active || d.current)) || "default"); })
        .catch(function () { act[1]("default"); });
      return function () { clearInterval(id); };
    }, []);
    return url[0] || act[0];
  }
  function get(path) { return SDK.fetchJSON(path); }
  function send(path, method, body) {
    return SDK.fetchJSON(path, { method: method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  }
  function q(profile) { return "?profile=" + encodeURIComponent(profile); }
  function errText(e) {
    var m = e && (e.detail || e.message) ? String(e.detail || e.message) : String(e);
    return m.length > 200 ? m.slice(0, 197) + "…" : m;
  }
  function list(d, keys) {
    if (Array.isArray(d)) return d;
    for (var i = 0; d && i < keys.length; i++) if (Array.isArray(d[keys[i]])) return d[keys[i]];
    return [];
  }
  function shortModel(id) { var x = String(id || ""); return x.indexOf("/") >= 0 ? x.slice(x.lastIndexOf("/") + 1) : x; }
  // A subagent's model as shown on the map and in the roster; "· provider" only when it has its own.
  // Files saved before 1.2.0 have no provider field at all: absent reads as "the soul's".
  function modelText(s) { return (shortModel(s.model) || "same model") + (s.provider ? " · " + s.provider : ""); }
  // The provider to store for a model picked from a provider's list: none when it is the lead's own
  // (today's behaviour, follows the lead), the picked provider otherwise.
  function ownProvider(model, slug, leadProvider) { return model && slug && slug !== leadProvider ? slug : ""; }
  function providerHint(provider, lead, leadProvider) {
    return provider ? "runs on its own " + provider + " account, not " + lead + "'s"
      : "runs on " + lead + "'s provider" + (leadProvider ? " · " + leadProvider : "");
  }
  // Hermes never hands these to a subagent (ask-the-user, memory, spawning, scheduling).
  var CHILD_BLOCKED = ["clarify", "memory", "delegation", "cronjob", "nothing-agents"];
  function two(n) { return n < 10 ? "0" + n : String(n); }
  function cap(s) { s = String(s || ""); return s.charAt(0).toUpperCase() + s.slice(1); }

  var TEMPLATES = {
    blank: { when: "", instructions: "", tools: [] },
    researcher: { tools: ["web", "browser"], when: "Anything that needs looking up: prices, docs, news, comparing options.",
      instructions: "Search, read the sources, and answer with short sourced bullets. Never buy, sign up or send anything." },
    writer: { tools: ["file"], when: "Drafting or rewriting text: messages, emails, posts, summaries.",
      instructions: "Write clearly and briefly in my voice. Return the draft only; never send it yourself." },
    coder: { tools: ["terminal", "file", "code_execution"], when: "Code changes, scripts, debugging and anything in the terminal.",
      instructions: "Make the smallest change that works, run it to check, and report what you changed and how you tested it." },
  };

  // ---- colour dropdown ----------------------------------------------------
  function ColourPick(props) {
    var open = useState(false), m = props.mode;
    var ref = useRef(null);
    useEffect(function () {
      if (!open[0]) return undefined;
      var close = function (e) { if (ref.current && !ref.current.contains(e.target)) open[1](false); };
      document.addEventListener("mousedown", close);
      return function () { document.removeEventListener("mousedown", close); };
    }, [open[0]]);
    var dot = function (c) { return h("i", { style: { background: hex(m, c), boxShadow: "0 0 8px " + hex(m, c) } }); };
    return h("div", { className: "nha-cdrop", ref: ref },
      h("button", { type: "button", className: "nha-cbtn nha-raised-sm", "aria-haspopup": "listbox", "aria-expanded": open[0] ? "true" : "false",
        onClick: function () { open[1](!open[0]); } }, dot(props.value), props.value, " ▾"),
      open[0] ? h("div", { className: "nha-cpop nha-raised", role: "listbox" }, PALETTE.map(function (c) {
        return h("button", { key: c, type: "button", role: "option", "aria-selected": c === props.value ? "true" : "false",
          className: c === props.value ? "on" : "", onClick: function () { props.onChange(c); open[1](false); } }, dot(c), c);
      })) : null);
  }

  // ---- the map ------------------------------------------------------------
  function TeamMap(props) {
    var ref = useRef(null);
    var size = useState(900);
    useEffect(function () {
      var el = ref.current;
      if (!el) return undefined;
      var ro = new ResizeObserver(function () { size[1](el.clientWidth || 900); });
      ro.observe(el);
      size[1](el.clientWidth || 900);
      return function () { ro.disconnect(); };
    }, []);
    var W = size[0], m = props.mode, subs = props.subs;
    var phone = W < 560;
    var perRow = Math.max(1, Math.min(Math.max(subs.length, 1), Math.floor((W - 40) / (phone ? 130 : 170))));
    var rows = Math.max(1, Math.ceil(Math.max(subs.length, 1) / perRow));
    var oy = phone ? 92 : 122, oR = phone ? 52 : 66;              // orchestrator disc centre and radius
    var top = phone ? 300 : 330, rowH = phone ? 175 : 190, sR = phone ? 34 : 44;
    var H = top + rows * rowH + (phone ? 40 : 30);
    var pos = subs.map(function (s, i) {
      var r = Math.floor(i / perRow), inRow = Math.min(perRow, subs.length - r * perRow), c = i % perRow;
      return { x: W / 2 + (c - (inRow - 1) / 2) * ((W - 40) / perRow), y: top + r * rowH };
    });
    var lead = props.orch;
    var edges = pos.map(function (p, i) {
      var y0 = oy + oR + (phone ? 78 : 6), y1 = p.y - sR - 6, mid = (y0 + y1) / 2;
      return h("path", { key: i, d: "M" + W / 2 + " " + y0 + " C " + W / 2 + " " + mid + ", " + p.x + " " + mid + ", " + p.x + " " + y1,
        stroke: hex(m, subs[i].colour), className: "nha-edge" });
    });
    return h("section", { className: "nha-map nha-pressed", ref: ref, style: { height: H + "px" } },
      h("svg", { className: "nha-edges", width: W, height: H, viewBox: "0 0 " + W + " " + H }, edges,
        !subs.length ? h("path", { d: "M" + W / 2 + " " + (oy + oR + (phone ? 78 : 6)) + " L " + W / 2 + " " + (top - sR - 6), className: "nha-edge nha-edge-ghost" }) : null),
      h("button", { type: "button", className: "nha-node nha-orch" + (phone ? " nha-orch-phone" : "") + (props.sel === -1 ? " sel" : ""),
        style: { left: W / 2 + "px", top: (oy - oR) + "px", "--oR": oR + "px" }, onClick: function () { props.onSelect(-1); } },
        h("span", { className: "nha-disc nha-raised", style: { width: oR * 2 + "px", height: oR * 2 + "px" } },
          h(Avatar, { name: lead.name, colour: hex(m, lead.colour), px: Math.round(oR * 1.45), n: 13 })),
        h("span", { className: "nha-orch-label" },
          h("b", null, lead.name), h("span", { className: "nha-label" }, "orchestrator · " + props.profile),
          props.model ? h("span", { className: "nha-label nha-nowrap", style: { color: hex(m, "violet") } }, props.model) : null)),
      subs.map(function (s, i) {
        return h("button", { key: s.name + i, type: "button", className: "nha-node" + (props.sel === i ? " sel" : ""),
          style: { left: pos[i].x + "px", top: (pos[i].y - sR) + "px" }, onClick: function () { props.onSelect(i); } },
          h("span", { className: "nha-disc nha-raised", style: { width: sR * 2 + "px", height: sR * 2 + "px" } },
            h(Avatar, { name: s.name, colour: hex(m, s.colour), px: Math.round(sR * 1.45) })),
          h("span", { className: "nha-nodetext" },
            h("b", null, s.name),
            h("span", { className: "nha-label nha-when" }, s.when || "no rule yet"),
            h("span", { className: "nha-label nha-model", title: (s.model || "") + (s.provider ? " on " + s.provider : ""), style: { color: hex(m, s.colour) } }, modelText(s))));
      }),
      !subs.length ? h("button", { type: "button", className: "nha-node nha-ghost", style: { left: W / 2 + "px", top: (top - sR) + "px" },
        onClick: props.onNew },
        h("span", { className: "nha-disc nha-pressed", style: { width: sR * 2 + "px", height: sR * 2 + "px" } }, "+"),
        h("b", null, "Add the first subagent"),
        h("span", { className: "nha-label" }, "a helper " + lead.name + " can hand work to")) : null,
      h("div", { className: "nha-legend" },
        h("span", null, h("i", { style: { background: hex(m, "violet") } }), "delegates to · dashed"),
        h("span", null, "click any agent to edit it")));
  }

  // ---- panels -------------------------------------------------------------
  function Field(props) {
    return h("label", { className: "nha-field" + (props.className ? " " + props.className : "") },
      h("span", { className: "nha-label" }, props.label), props.children,
      props.hint ? h("span", { className: "nha-label nha-hint" }, props.hint) : null);
  }

  // A themed stand-in for the browser's own confirm() box (destructive actions only, one at a time).
  function Confirm(props) {
    var box = useRef(null);
    useEffect(function () {
      var el = box.current && box.current.querySelector("[data-ok]");
      if (el) el.focus();
    }, []);
    var onKey = function (e) {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); props.onCancel(); }
      else if (e.key === "Enter" && e.target.tagName !== "BUTTON") { e.preventDefault(); props.onOk(); }
      else if (e.key === "Tab" && box.current) {
        var f = [].slice.call(box.current.querySelectorAll("button")), i = f.indexOf(document.activeElement);
        if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); } else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
      }
    };
    return h("div", { className: "nha-confirm-wrap", onMouseDown: function (e) { if (e.target === e.currentTarget) props.onCancel(); } },
      h("div", { className: "nha-confirm nha-raised", role: "dialog", "aria-modal": "true", "aria-label": props.title || "confirm", ref: box, onKeyDown: onKey },
        h("span", { className: "nha-label" }, props.title || "confirm"),
        h("div", { className: "nha-confirm-msg" }, props.message),
        h("div", { className: "nha-acts nha-confirm-acts" },
          h("button", { type: "button", className: "nha-btn nha-raised-sm", disabled: !!props.busy, onClick: props.onCancel }, props.cancelLabel || "Cancel"),
          h("button", { type: "button", className: "nha-btn nha-raised-sm nha-danger", "data-ok": "1", disabled: !!props.busy, onClick: props.onOk },
            props.busy ? (props.busyLabel || "working…") : (props.okLabel || "OK")))));
  }

  // ---- model dropdown ------------------------------------------------------
  // groups: [{ slug, name, models: [...] }]. value: model id ("" = inherit when allowInherit).
  // onChange(model, providerSlug). Searchable; "other model id" for anything not listed.
  function ModelPicker(props) {
    var open = useState(false), qy = useState(""), other = useState("");
    var ref = useRef(null);
    useEffect(function () {
      if (!open[0]) return undefined;
      var close = function (e) { if (ref.current && !ref.current.contains(e.target)) open[1](false); };
      var esc = function (e) { if (e.key === "Escape") open[1](false); };
      document.addEventListener("mousedown", close); document.addEventListener("keydown", esc);
      return function () { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", esc); };
    }, [open[0]]);
    var needle = qy[0].trim().toLowerCase();
    var pick = function (model, slug) { props.onChange(model, slug); open[1](false); qy[1](""); };
    var groups = (props.groups || []).map(function (g) {
      return { slug: g.slug, name: g.name, models: (g.models || []).filter(function (x) { return !needle || x.toLowerCase().indexOf(needle) >= 0; }) };
    }).filter(function (g) { return g.models.length; });
    var label = props.value ? props.value : (props.allowInherit ? "same as " + props.lead : "choose a model");
    return h("div", { className: "nha-mpick", ref: ref },
      h("button", { type: "button", className: "nha-in nha-pressed nha-mbtn", "aria-haspopup": "listbox", "aria-expanded": open[0] ? "true" : "false",
        onClick: function () { open[1](!open[0]); } },
        h("span", { className: "nha-mval" + (props.value ? "" : " nha-dim") }, label),
        props.provider ? h("span", { className: "nha-label" }, props.provider) : null,
        h("span", { className: "nha-label" }, "▾")),
      open[0] ? h("div", { className: "nha-mpop nha-raised", role: "listbox" },
        h("input", { className: "nha-in nha-pressed", placeholder: "search models…", value: qy[0], autoFocus: true,
          onChange: function (e) { qy[1](e.target.value); } }),
        h("div", { className: "nha-mlist" },
          props.allowInherit && !needle ? h("button", { type: "button", className: "nha-mopt" + (!props.value ? " on" : ""), onClick: function () { pick("", null); } },
            "same as " + props.lead) : null,
          groups.map(function (g) {
            return h("div", { key: g.slug, className: "nha-mgroup" },
              h("div", { className: "nha-label nha-mhead" }, g.name || g.slug),
              g.models.map(function (x) {
                var on = x === props.value && (!props.provider || props.provider === g.slug);
                return h("button", { key: g.slug + x, type: "button", className: "nha-mopt" + (on ? " on" : ""), onClick: function () { pick(x, g.slug); } }, x);
              }));
          }),
          !groups.length ? h("div", { className: "nha-label nha-mhead" }, needle ? "no model matches" : "no models listed for this provider") : null),
        h("div", { className: "nha-mother" },
          h("input", { className: "nha-in nha-pressed", placeholder: "other model id, e.g. vendor/model", value: other[0],
            onChange: function (e) { other[1](e.target.value); },
            onKeyDown: function (e) { if (e.key === "Enter" && other[0].trim()) pick(other[0].trim(), props.otherProvider || null); } }),
          h("button", { type: "button", className: "nha-btn nha-raised-sm", disabled: !other[0].trim(),
            onClick: function () { pick(other[0].trim(), props.otherProvider || null); } }, "Use"))) : null);
  }

  // Toolsets the subagent may use; none ticked = everything its lead has.
  function Tools(props) {
    var m = props.mode, on = props.value || [];
    var all = props.toolsets || [];
    var names = all.map(function (t) { return t.name; });
    on.forEach(function (n) { if (names.indexOf(n) < 0) { names.push(n); all = all.concat([{ name: n, label: n }]); } });
    var toggle = function (n) {
      var next = on.indexOf(n) >= 0 ? on.filter(function (x) { return x !== n; }) : on.concat([n]);
      props.onChange(next);
    };
    return h("div", { className: "nha-field" },
      h("span", { className: "nha-label" }, "tools it may use" + (on.length ? "" : " · all of its lead's")),
      h("div", { className: "nha-tools" }, all.map(function (t) {
        var sel = on.indexOf(t.name) >= 0;
        return h("button", { key: t.name, type: "button", title: t.label || t.name, className: "nha-tool " + (sel ? "nha-pressed on" : "nha-raised-sm"),
          onClick: function () { toggle(t.name); }, style: sel ? { color: hex(m, props.tone) } : null },
          sel ? h("i", { style: { background: hex(m, props.tone), boxShadow: "0 0 6px " + hex(m, props.tone) } }) : null, t.name);
      })));
  }

  function SubPanel(props) {
    var s = props.sub, m = props.mode;
    var f = useState({ name: s.name, colour: s.colour, model: s.model || "", provider: s.provider || "", tools: (s.tools || []).slice(), can_delegate: !!s.can_delegate, when: s.when || "", instructions: s.instructions || "" });
    var v = f[0];
    var set = function (k) { return function (e) { var n = Object.assign({}, v); n[k] = e && e.target ? (e.target.type === "checkbox" ? e.target.checked : e.target.value) : e; f[1](n); }; };
    var dirty = ["name", "colour", "model", "provider", "when", "instructions"].some(function (k) { return (v[k] || "") !== (s[k] || ""); })
      || v.can_delegate !== !!s.can_delegate || v.tools.join(",") !== (s.tools || []).join(",");
    return h("aside", { className: "nha-panel nha-raised" },
      h("div", { className: "nha-head" },
        h("span", { className: "nha-disc nha-raised", style: { width: "84px", height: "84px" } }, h(Avatar, { name: v.name || s.name, colour: hex(m, v.colour), px: 60 })),
        h("div", { className: "nha-head-text" },
          h("input", { className: "nha-title-in", value: v.name, onChange: set("name"), "aria-label": "Name", maxLength: 32 }),
          h("span", { className: "nha-label" }, "subagent of " + props.lead),
          h(ColourPick, { mode: m, value: v.colour, onChange: set("colour") }))),
      h(Field, { label: "model", hint: providerHint(v.provider, props.lead, props.leadProvider) },
        h(ModelPicker, { value: v.model, provider: v.provider, groups: props.allGroups || props.subGroups, allowInherit: true, lead: props.lead,
          otherProvider: v.provider || props.leadProvider,
          onChange: function (mm, slug) { var n = Object.assign({}, v, { model: mm, provider: ownProvider(mm, slug, props.leadProvider) }); f[1](n); } })),
      v.provider && props.agent && props.agent.supports_provider === false
        ? h("div", { className: "nha-err" }, "This profile's agent side is " + (props.agent.version || "older") + ", before 1.2.0, and would still run " + (v.name || s.name) +
            " on " + props.lead + "'s provider. Update it first (the banner above).") : null,
      h(Tools, { mode: m, value: v.tools, toolsets: props.toolsets, tone: v.colour, onChange: set("tools") }),
      h(Field, { label: "when " + props.lead + " calls it" },
        h("textarea", { className: "nha-in nha-pressed", rows: 2, value: v.when, onChange: set("when"), maxLength: 300, placeholder: "e.g. anything that needs looking up" })),
      h(Field, { label: "instructions", hint: "given to it every time it is called" },
        h("textarea", { className: "nha-in nha-pressed", rows: 4, value: v.instructions, onChange: set("instructions"), maxLength: 2000, placeholder: "How it should work and report back…" })),
      h("label", { className: "nha-check" }, h("input", { type: "checkbox", checked: v.can_delegate, onChange: set("can_delegate") }),
        h("span", null, "can lead its own subagents", props.depth < 2 ? h("span", { className: "nha-label nha-hint" }, " · needs levels deep 2+ in " + props.lead + "'s team rules") : null)),
      props.err ? h("div", { className: "nha-err" }, props.err) : null,
      h("div", { className: "nha-acts" },
        h("button", { type: "button", className: "nha-btn nha-primary", disabled: !dirty || props.busy, onClick: function () { props.onSave(v); } }, props.busy ? "saving…" : "Save"),
        h("button", { type: "button", className: "nha-btn nha-raised-sm", disabled: props.busy, onClick: props.onCopy }, "Copy"),
        h("button", { type: "button", className: "nha-btn nha-raised-sm nha-danger", disabled: props.busy, onClick: props.onDelete }, "Delete")),
      h("span", { className: "nha-label nha-hint" }, "changes reach " + props.lead + " in its next new chat"));
  }

  var EFFORTS = [["", "inherit"], ["low", "low"], ["medium", "medium"], ["high", "high"], ["xhigh", "x-high"]];

  function OrchPanel(props) {
    var m = props.mode, d = props.deleg || {}, o = props.orch;
    var f = useState({ name: o.name, colour: o.colour,
      max_spawn_depth: d.max_spawn_depth == null ? 1 : d.max_spawn_depth,
      child_timeout_seconds: d.child_timeout_seconds == null ? 0 : d.child_timeout_seconds,
      reasoning_effort: d.reasoning_effort || "",
      inherit_mcp_toolsets: d.inherit_mcp_toolsets !== false,
      model: props.model || "", provider: props.leadProvider || "" });
    var v = f[0];
    var set = function (k, num) {
      return function (e) { var n = Object.assign({}, v); var x = e && e.target ? (e.target.type === "checkbox" ? e.target.checked : e.target.value) : e;
        n[k] = num ? Math.max(0, parseInt(x, 10) || 0) : x; f[1](n); };
    };
    var rows = props.conn.map(function (c, i) {
      return h(c.href ? "a" : "div", { key: i, href: c.href, className: "nha-crow nha-pressed" },
        h("i", { style: { background: hex(m, c.tone), boxShadow: "0 0 8px " + hex(m, c.tone) } }),
        h("span", null, c.label), h("span", { className: "nha-label" }, c.meta));
    });
    var num = function (k, label, min, max, hint) {
      return h(Field, { label: label, hint: hint, className: "nha-mini" }, h("input", { className: "nha-in nha-pressed", type: "number", min: min, max: max, value: v[k], onChange: set(k, true) }));
    };
    return h("aside", { className: "nha-panel nha-raised" },
      h("div", { className: "nha-head" },
        h("span", { className: "nha-disc nha-raised", style: { width: "84px", height: "84px" } }, h(Avatar, { name: v.name, colour: hex(m, v.colour), px: 60, n: 13 })),
        h("div", { className: "nha-head-text" },
          h("input", { className: "nha-title-in", value: v.name, onChange: set("name"), "aria-label": "Name", maxLength: 40 }),
          h("span", { className: "nha-label" }, "orchestrator · " + props.profileLabel + " profile"),
          h(ColourPick, { mode: m, value: v.colour, onChange: set("colour") }))),
      h(Field, { label: "model" + (props.leadProvider ? " · " + props.leadProvider : "") },
        h(ModelPicker, { value: v.model, provider: v.provider, groups: props.allGroups, lead: v.name, otherProvider: v.provider,
          onChange: function (mm, slug) { var n = Object.assign({}, v, { model: mm, provider: slug || v.provider }); f[1](n); } })),
      h("button", { type: "button", className: "nha-crow nha-raised-sm nha-crow2", onClick: props.onSoul },
        h("span", null, "Personality · SOUL.md"), h("span", { className: "nha-label nha-link" }, "edit →")),
      h("div", { className: "nha-field" }, h("span", { className: "nha-label" }, "connected to"), h("div", { className: "nha-conn" }, rows)),
      h("div", { className: "nha-field" }, h("span", { className: "nha-label" }, "team rules · every subagent in this profile"),
        h("div", { className: "nha-three" },
          h(Field, { label: "effort", className: "nha-mini" }, h("select", { className: "nha-in nha-pressed", value: v.reasoning_effort, onChange: set("reasoning_effort") },
            EFFORTS.map(function (e) { return h("option", { key: e[0], value: e[0] }, e[1]); }))),
          num("child_timeout_seconds", "time limit s", 0, 86400, "0 = none"),
          num("max_spawn_depth", "levels deep", 1, 3)),
        h("label", { className: "nha-check" }, h("input", { type: "checkbox", checked: v.inherit_mcp_toolsets, onChange: set("inherit_mcp_toolsets") }),
          h("span", null, "subagents may also use " + v.name + "'s MCP tools"))),
      props.err ? h("div", { className: "nha-err" }, props.err) : null,
      h("div", { className: "nha-acts" },
        h("button", { type: "button", className: "nha-btn nha-primary", disabled: props.busy, onClick: function () { props.onSave(v); } }, props.busy ? "saving…" : "Save"),
        h("a", { className: "nha-btn nha-raised-sm", href: "/chat" + q(props.profile) }, "Chat")));
  }

  // ---- drawers ------------------------------------------------------------
  function Drawer(props) {
    return h("div", { className: "nha-drawer-wrap" },
      h("div", { className: "nha-scrim", onClick: props.onClose }),
      h("aside", { className: "nha-drawer nha-raised", role: "dialog", "aria-label": props.title },
        h("div", { className: "nha-row" },
          h("div", null, h("div", { className: "nha-label" }, props.kicker), h("div", { className: "nha-dtitle" }, props.title)),
          h("button", { type: "button", className: "nha-iconbtn nha-raised-sm", "aria-label": "Close", onClick: props.onClose }, "✕")),
        props.children));
  }

  function NewDrawer(props) {
    var m = props.mode;
    var used = props.subs.map(function (s) { return s.colour; });
    var free = PALETTE.filter(function (c) { return c !== "violet" && used.indexOf(c) < 0; })[0] || "sky";
    var f = useState({ name: "", colour: free, model: "", provider: "", tools: [], tpl: "blank", when: "", instructions: "" });
    var v = f[0];
    var set = function (k) { return function (e) { var n = Object.assign({}, v); n[k] = e && e.target ? e.target.value : e; f[1](n); }; };
    var avail = (props.toolsets || []).map(function (t) { return t.name; });
    var tpl = function (k) {
      var T = TEMPLATES[k];
      var n = Object.assign({}, v, { tpl: k, when: T.when, instructions: T.instructions,
        tools: (T.tools || []).filter(function (x) { return avail.indexOf(x) >= 0; }) });
      f[1](n);
    };
    return h(Drawer, { kicker: "new subagent · " + (props.profileLabel || props.profile), title: v.name || "Untitled", onClose: props.onClose },
      h("div", { className: "nha-head" },
        h("span", { className: "nha-disc nha-raised", style: { width: "90px", height: "90px" } }, h(Avatar, { name: v.name || "untitled", colour: hex(m, v.colour), px: 64 })),
        h("div", { className: "nha-head-text", style: { flex: 1 } },
          h(Field, { label: "name" }, h("input", { className: "nha-in nha-pressed", value: v.name, onChange: set("name"), maxLength: 32, placeholder: "e.g. Scout", autoFocus: true })),
          h(ColourPick, { mode: m, value: v.colour, onChange: set("colour") }))),
      h(Field, { label: "start from" }, h("div", { className: "nha-seg nha-pressed" }, Object.keys(TEMPLATES).map(function (k) {
        return h("button", { key: k, type: "button", className: v.tpl === k ? "on" : "", onClick: function () { tpl(k); } }, k);
      }))),
      h(Field, { label: "model", hint: providerHint(v.provider, props.lead, props.leadProvider) },
        h(ModelPicker, { value: v.model, provider: v.provider, groups: props.allGroups || props.subGroups, allowInherit: true, lead: props.lead,
          otherProvider: v.provider || props.leadProvider,
          onChange: function (mm, slug) { var n = Object.assign({}, v, { model: mm, provider: ownProvider(mm, slug, props.leadProvider) }); f[1](n); } })),
      h(Tools, { mode: m, value: v.tools, toolsets: props.toolsets, tone: v.colour, onChange: set("tools") }),
      h(Field, { label: "when " + props.lead + " calls it" }, h("textarea", { className: "nha-in nha-pressed", rows: 2, value: v.when, onChange: set("when"), maxLength: 300 })),
      h(Field, { label: "instructions" }, h("textarea", { className: "nha-in nha-pressed", rows: 5, value: v.instructions, onChange: set("instructions"), maxLength: 2000 })),
      props.err ? h("div", { className: "nha-err" }, props.err) : null,
      h("div", { className: "nha-acts nha-dacts" },
        h("button", { type: "button", className: "nha-btn nha-primary", disabled: !v.name.trim() || props.busy,
          onClick: function () { props.onCreate({ name: v.name.trim(), colour: v.colour, model: v.model.trim(), provider: v.provider || "", tools: v.tools, can_delegate: false, when: v.when, instructions: v.instructions }); } },
          props.busy ? "creating…" : "Create"),
        h("button", { type: "button", className: "nha-btn nha-raised-sm", onClick: props.onClose }, "Cancel")));
  }

  function SoulDrawer(props) {
    var text = useState(null), busy = useState(false), err = useState(null);
    useEffect(function () {
      var call = SDK.api && SDK.api.getProfileSoul ? SDK.api.getProfileSoul(props.profile) : get("/api/profiles/" + encodeURIComponent(props.profile) + "/soul");
      call.then(function (d) { text[1]((d && d.content) || ""); }).catch(function (e) { err[1](errText(e)); text[1](""); });
    }, [props.profile]);
    var save = function () {
      busy[1](true); err[1](null);
      var call = SDK.api && SDK.api.updateProfileSoul ? SDK.api.updateProfileSoul(props.profile, text[0])
        : send("/api/profiles/" + encodeURIComponent(props.profile) + "/soul", "PUT", { content: text[0] });
      call.then(function () { busy[1](false); props.onClose(); }).catch(function (e) { busy[1](false); err[1](errText(e)); });
    };
    return h(Drawer, { kicker: "personality · " + props.profile, title: "SOUL.md", onClose: props.onClose },
      text[0] === null ? h("span", { className: "nha-label" }, "reading SOUL.md …")
        : h("textarea", { className: "nha-in nha-pressed nha-soul", value: text[0], onChange: function (e) { text[1](e.target.value); } }),
      err[0] ? h("div", { className: "nha-err" }, err[0]) : null,
      h("span", { className: "nha-label nha-hint" }, "takes effect in the next new chat"),
      h("div", { className: "nha-acts nha-dacts" },
        h("button", { type: "button", className: "nha-btn nha-primary", disabled: busy[0] || text[0] === null, onClick: save }, busy[0] ? "saving…" : "Save"),
        h("button", { type: "button", className: "nha-btn nha-raised-sm", onClick: props.onClose }, "Cancel")));
  }

  // ---- the page -----------------------------------------------------------
  function Page() {
    var m = useMode();
    var profile = useProfile();
    var team = useState(null), cfg = useState(null), extra = useState({}), opts = useState(null);
    var sel = useState(-1), drawer = useState(null), busy = useState(false), err = useState(null), note = useState(null), confirmDel = useState(false);
    var tick = useState(0);

    useEffect(function () {
      if (!profile) return undefined;
      var alive = true;
      team[1](null); err[1](null);
      get(API + "/team" + q(profile)).then(function (d) { if (alive) team[1](d); })
        .catch(function (e) { if (alive) { team[1]({ error: errText(e) }); } });
      get("/api/config" + q(profile)).then(function (d) { if (alive) cfg[1](d); }).catch(function () { if (alive) cfg[1]({}); });
      var bag = {};
      var put = function (k) { return function (d) { if (!alive) return; bag[k] = d; extra[1](Object.assign({}, bag)); }; };
      var skip = function () { /* a readout that cannot be read is left out */ };
      get("/api/cron/jobs" + q(profile)).then(put("cron")).catch(skip);
      get("/api/mcp/servers" + q(profile)).then(put("mcp")).catch(skip);
      get("/api/skills" + q(profile)).then(put("skills")).catch(skip);
      get("/api/status").then(put("status")).catch(skip);
      get("/api/profiles").then(put("profiles")).catch(skip);
      get("/api/model/options" + q(profile)).then(function (d) { if (alive) opts[1](d); }).catch(skip);
      get("/api/tools/toolsets" + q(profile)).then(put("toolsets")).catch(skip);
      return function () { alive = false; };
    }, [profile, tick[0]]);

    if (!profile || !team[0]) return h("div", { className: "nha-page" }, h("span", { className: "nha-label" }, "reading the team …"));
    if (team[0].error) return h("div", { className: "nha-page" }, h("div", { className: "nha-err" }, "Could not read the team: " + team[0].error));

    var t = team[0];
    var subs = list(t.subagents, []);
    var meRow = list(extra[0].profiles, ["profiles"]).filter(function (p) { return p.name === profile; })[0];
    var profileLabel = (meRow && meRow.display_name) || profile;
    var lead = { name: (t.orchestrator && t.orchestrator.name) || cap(profile === "default" ? (meRow && meRow.display_name) || "Hermes" : profile), colour: (t.orchestrator && t.orchestrator.colour) || "violet" };
    var c = cfg[0] || {};
    var model = typeof c.model === "string" ? c.model : (c.model && (c.model.default || c.model.name)) || "";
    var deleg = c.delegation || {};
    var ex = extra[0];
    var s = sel[0] >= subs.length ? -1 : sel[0];

    var conn = [];
    var plist = list(ex.profiles, ["profiles"]);
    var me = plist.filter(function (p) { return p.name === profile; })[0];
    var st = ex.status;
    if (profile === "default" && st && st.gateway_platforms && typeof st.gateway_platforms === "object") {
      Object.keys(st.gateway_platforms).forEach(function (k) {
        conn.push({ tone: "sky", label: cap(k), meta: (st.gateway_platforms[k] && st.gateway_platforms[k].state) || "?", href: "/channels" });
      });
    }
    if (me) conn.push({ tone: me.gateway_running ? "mint" : "graphite", label: "Gateway", meta: me.gateway_running ? "running" : "off", href: "/channels" + q(profile) });
    conn.push({ tone: "sky", label: "Dashboard chat", meta: "here", href: "/chat" + q(profile) });
    var mem = c.memory || {};
    conn.push({ tone: "mint", label: mem.provider ? cap(mem.provider) + " memory" : "Memory", meta: mem.provider ? "provider" : (mem.memory_enabled === false ? "off" : "built-in"), href: "/config" });
    if (ex.cron) {
      var jobs = list(ex.cron, ["jobs"]).filter(function (j) { return (j.profile_name || j.profile || "default") === profile; });
      var paused = jobs.filter(function (j) { return j.enabled === false || /paus/i.test(String(j.state || "")); }).length;
      conn.push({ tone: "amber", label: "Cron", meta: jobs.length + (jobs.length === 1 ? " job" : " jobs") + (paused ? " · " + paused + " paused" : ""), href: "/cron" + q(profile) });
    }
    if (ex.mcp) {
      var servers = list(ex.mcp, ["servers"]);
      conn.push({ tone: "sky", label: "MCP", meta: servers.length ? servers.map(function (x) { return x.name; }).slice(0, 3).join(", ") : "none", href: "/mcp" + q(profile) });
    }
    if (ex.skills) {
      var sk = list(ex.skills, ["skills"]);
      var on = sk.filter(function (x) { return x.enabled === true || (x.enabled === undefined && x.disabled !== true); }).length;
      conn.push({ tone: "graphite", label: "Skills", meta: on + " enabled", href: "/skills" + q(profile) });
    }

    var toolsets = list(ex.toolsets, ["toolsets"]).filter(function (x) { return x && x.name && x.enabled !== false && CHILD_BLOCKED.indexOf(x.name) < 0; })
      .map(function (x) { return { name: x.name, label: x.label || x.name }; });
    // Models the dashboard lists for this profile's signed-in providers. The soul may switch
    // provider. A subagent follows its lead's provider unless it is given one of its own (1.2.0),
    // so it is offered every signed-in provider's models; the lead's own group comes first.
    var leadProvider = (opts[0] && opts[0].provider) || (c.model && c.model.provider) || "";
    var allGroups = list(opts[0] && opts[0].providers, []).filter(function (p) { return p.authenticated !== false || p.slug === leadProvider; })
      .map(function (p) { return { slug: p.slug, name: p.name || p.slug, models: p.models || [] }; });
    allGroups.sort(function (a, b) { return (b.slug === leadProvider) - (a.slug === leadProvider); });
    var subGroups = allGroups.filter(function (g) { return g.slug === leadProvider; });

    var save = function (next, selectName) {
      busy[1](true); err[1](null);
      return send(API + "/team" + q(profile), "PUT", next)
        .then(function (d) {
          busy[1](false); team[1](d);
          if (selectName !== undefined) {
            var i = list(d.subagents, []).map(function (x) { return x.name; }).indexOf(selectName);
            sel[1](i);
          }
          return true;
        })
        .catch(function (e) { busy[1](false); err[1](errText(e)); return false; });
    };
    var body = function (newSubs, orch) { return { orchestrator: orch || lead, subagents: newSubs }; };

    var panel = s === -1
      ? h(OrchPanel, { key: "orch-" + profile + "-" + tick[0] + "-" + lead.name + lead.colour + (cfg[0] ? "-c" : "-n") + (opts[0] ? "-o" : ""), mode: m, orch: lead, deleg: deleg, model: model, profile: profile, profileLabel: profileLabel, conn: conn,
          allGroups: allGroups, leadProvider: leadProvider,
          busy: busy[0], err: err[0], onSoul: function () { drawer[1]("soul"); },
          onSave: function (v) {
            busy[1](true); err[1](null); note[1](null);
            var rules = { max_spawn_depth: Math.max(1, v.max_spawn_depth), child_timeout_seconds: v.child_timeout_seconds,
              reasoning_effort: v.reasoning_effort, inherit_mcp_toolsets: !!v.inherit_mcp_toolsets };
            var keep = function (k) { return String(rules[k]) !== String(deleg[k] == null ? (k === "inherit_mcp_toolsets" ? true : "") : deleg[k]); };
            var changed = Object.keys(rules).filter(keep).length > 0;
            var saveRules = changed
              ? (SDK.api && SDK.api.saveConfig ? SDK.api.saveConfig({ delegation: rules }, profile) : send("/api/config" + q(profile), "PUT", { config: { delegation: rules } }))
              : Promise.resolve();
            var modelChanged = v.model && (v.model !== model || (v.provider && v.provider !== leadProvider));
            var saveModel = function () {
              if (!modelChanged) return Promise.resolve();
              return SDK.api && SDK.api.setProfileModel ? SDK.api.setProfileModel(profile, v.provider || leadProvider, v.model)
                : send("/api/profiles/" + encodeURIComponent(profile) + "/model", "PUT", { provider: v.provider || leadProvider, model: v.model });
            };
            saveRules.then(saveModel).then(function () {
              return save(body(subs, { name: v.name.trim() || lead.name, colour: v.colour }));
            }).then(function (ok) { if (ok) { note[1]("saved"); tick[1](Date.now()); } })
              .catch(function (e) { busy[1](false); err[1](errText(e)); });
          } })
      : h(SubPanel, { key: "sub-" + profile + "-" + s + "-" + subs[s].name, mode: m, sub: subs[s], lead: lead.name, busy: busy[0], err: err[0],
          toolsets: toolsets, depth: deleg.max_spawn_depth || 1, subGroups: subGroups, allGroups: allGroups, leadProvider: leadProvider, agent: t.agent || {},
          onSave: function (v) {
            var n = subs.slice(); n[s] = { name: v.name.trim(), colour: v.colour, model: v.model.trim(), provider: v.provider || "", tools: v.tools, can_delegate: v.can_delegate, when: v.when, instructions: v.instructions };
            save(body(n), n[s].name);
          },
          onCopy: function () {
            var base = subs[s].name.replace(/ \d+$/, ""), k = 2;
            while (subs.some(function (x) { return x.name.toLowerCase() === (base + " " + k).toLowerCase(); })) k++;
            var n = subs.concat([Object.assign({}, subs[s], { name: (base + " " + k).slice(0, 32) })]);
            save(body(n), n[n.length - 1].name);
          },
          onDelete: function () { confirmDel[1](true); } });
    var delSub = function () {
      var n = subs.filter(function (_, i) { return i !== s; });
      save(body(n), null).then(function (ok) { confirmDel[1](false); if (ok) sel[1](-1); });
    };

    var agent = t.agent || {};
    var banner = !agent.enabled
      ? h("div", { className: "nha-banner nha-pressed" },
          h("span", null, h("b", null, lead.name + " can't use subagents in this profile yet. "),
            "The team is saved, but the agent side of this plugin is off for “" + profile + "”."),
          h("button", { type: "button", className: "nha-btn nha-primary", disabled: busy[0], onClick: function () {
            busy[1](true); err[1](null);
            send(API + "/enable" + q(profile), "POST", {}).then(function () { busy[1](false); note[1]("turned on: start a new chat (or restart that profile's gateway) to load it"); tick[1](Date.now()); })
              .catch(function (e) { busy[1](false); err[1](errText(e)); });
          } }, "Turn on for " + profile))
      : (agent.supports_provider === false && subs.some(function (x) { return x.provider; })
        // An agent-side copy older than 1.2.0 ignores "provider": that subagent would run on the soul's account.
        ? h("div", { className: "nha-banner nha-pressed" },
            h("span", null, h("b", null, "The agent side in this profile is " + (agent.version || "older") + " and ignores providers. "),
              "A subagent with its own provider would still run on " + lead.name + "'s. Update it, then start a new chat."),
            h("button", { type: "button", className: "nha-btn nha-primary", disabled: busy[0], onClick: function () {
              busy[1](true); err[1](null);
              send(API + "/enable" + q(profile), "POST", {}).then(function () { busy[1](false); note[1]("updated: start a new chat (or restart that profile's gateway) to load it"); tick[1](Date.now()); })
                .catch(function (e) { busy[1](false); err[1](errText(e)); });
            } }, "Update for " + profile))
        : null);

    return h("div", { className: "nha-page" },
      h("div", { className: "nha-top" },
        h("span", { className: "nha-pill nha-raised-sm" }, h("i", { style: { background: hex(m, "violet") } }), two(subs.length) + " in " + profileLabel),
        note[0] ? h("span", { className: "nha-label nha-note" }, note[0]) : null,
        h("span", { className: "nha-label nha-grow" }, "each profile has its own soul and its own team"),
        h("button", { type: "button", className: "nha-btn nha-primary", disabled: subs.length >= 12, onClick: function () { err[1](null); drawer[1]("new"); } }, "+ New subagent")),
      banner,
      h("div", { className: "nha-grid" },
        h(TeamMap, { mode: m, subs: subs, orch: lead, sel: s, profile: profileLabel, model: model,
          onSelect: function (i) { err[1](null); sel[1](i); }, onNew: function () { drawer[1]("new"); } }),
        panel),
      subs.length ? h("div", { className: "nha-roster" },
        subs.map(function (x, i) {
          return h("button", { key: x.name + i, type: "button", className: "nha-rc nha-raised-sm" + (i === s ? " sel" : ""), onClick: function () { sel[1](i); } },
            h(Avatar, { name: x.name, colour: hex(m, x.colour), px: 38 }),
            h("span", null, h("b", null, x.name), h("span", { className: "nha-label" }, modelText(x))));
        }),
        subs.length < 12 ? h("button", { type: "button", className: "nha-rc nha-pressed nha-rc-new", onClick: function () { drawer[1]("new"); } }, "+ new subagent") : null) : null,
      drawer[0] === "new" ? h(NewDrawer, { mode: m, profile: profile, profileLabel: profileLabel, lead: lead.name, subs: subs, busy: busy[0], err: err[0], toolsets: toolsets, subGroups: subGroups, allGroups: allGroups, leadProvider: leadProvider,
        onClose: function () { drawer[1](null); err[1](null); },
        onCreate: function (x) { save(body(subs.concat([x])), x.name).then(function (ok) { if (ok) drawer[1](null); }); } }) : null,
      drawer[0] === "soul" ? h(SoulDrawer, { profile: profile, onClose: function () { drawer[1](null); } }) : null,
      confirmDel[0] ? h(Confirm, {
        title: "delete subagent",
        message: "Delete the subagent “" + (subs[s] ? subs[s].name : "") + "”?",
        okLabel: "Delete", busy: busy[0],
        onCancel: function () { confirmDel[1](false); }, onOk: delSub,
      }) : null);
  }

  REG.register("nothing-agents", Page);
})();
