/*
 * nothing-hud — slot-only companion to the Nothing theme.
 *
 * Plain IIFE, no build step, no dependencies: React and everything else come
 * from window.__HERMES_PLUGIN_SDK__. Install to ~/.hermes/plugins/nothing-hud/.
 *
 *   header-left  HERMES wordmark (mono, not dot-matrix)
 *   chat:top     the active profile name in dot-matrix — the Chat hero moment
 *   cron:top     flat: a dot-matrix PAUSED stamp when any job is paused;
 *                Neu: every job as a list, the selected one as a big card with
 *                Pause/Resume/Trigger and a settings drawer (edit/create/delete)
 *   skills:top   the enabled-skill count in dot-matrix
 *   tab /status  the mockup's Status screen (0.21.5 has no Status page)
 *   header-right Dark/White switch between nothing-neu and nothing-neu-light
 *   (Neu rail)   profile dropdown, nav counts, and the grouped rail (style.css)
 *   analytics:top authoritative OpenRouter spend in dot-matrix, the key cap as
 *                a segmented bar, the cap itself as the one red threshold mark
 *                (figures from this plugin's own GET /api/plugins/nothing-hud/spend)
 *
 * Every slot component renders nothing unless a Nothing theme is active (it sets
 * --theme-asset-custom-nothingHud) and the data it needs is recognisable. Under
 * the Neumorphism themes (--theme-asset-custom-nothingNeu) each piece draws its
 * soft, raised variant instead of the flat one.
 * Response shapes were checked against a running Hermes 0.19 dashboard; the
 * readers still accept a few variants and give up quietly on anything else.
 */
(function () {
  "use strict";

  var SDK = window.__HERMES_PLUGIN_SDK__;
  var REG = window.__HERMES_PLUGINS__;
  if (!SDK || !REG || !SDK.React) return;

  var NAME = "nothing-hud";
  var React = SDK.React;
  var h = React.createElement;
  var useState = SDK.hooks.useState;
  var useEffect = SDK.hooks.useEffect;
  var useRef = SDK.hooks.useRef;

  // ---- environment ------------------------------------------------------

  function themeIsNothing() {
    var css = getComputedStyle(document.documentElement);
    return (
      css.getPropertyValue("--theme-asset-custom-nothingHud").trim() !== "" ||
      css.getPropertyValue("--theme-asset-custom-nothinghud").trim() !== ""
    );
  }

  // Re-check when the theme switches: the dashboard swaps a <style> tag in
  // <head> and may touch attributes on <html>.
  function useNothingTheme() {
    var state = useState(themeIsNothing());
    var active = state[0], setActive = state[1];
    useEffect(function () {
      var update = function () { setActive(themeIsNothing()); };
      var mo = new MutationObserver(update);
      mo.observe(document.head, { childList: true, subtree: true, characterData: true });
      mo.observe(document.documentElement, { attributes: true });
      return function () { mo.disconnect(); };
    }, []);
    return active;
  }

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }
  function themeIsNeu() {
    return cssVar("--theme-asset-custom-nothingNeu") !== "" || cssVar("--theme-asset-custom-nothingneu") !== "";
  }
  function neuMode() { return cssVar("--neu-mode") || "dark"; }

  // Same watcher as useNothingTheme, for any probe.
  function useWatch(probe) {
    var state = useState(probe());
    var v = state[0], setV = state[1];
    useEffect(function () {
      var update = function () { setV(probe()); };
      var mo = new MutationObserver(update);
      mo.observe(document.head, { childList: true, subtree: true, characterData: true });
      mo.observe(document.documentElement, { attributes: true });
      return function () { mo.disconnect(); };
    }, []);
    return v;
  }
  function useNeu() { return useWatch(themeIsNeu); }

  // The profile switcher keeps its selection in the URL (?profile=work).
  // No param means the dashboard's own profile.
  function currentProfile() {
    var p = new URLSearchParams(window.location.search).get("profile");
    return p && p.trim() ? p.trim() : "default";
  }

  // Client-side navigation does not fire an event a slot can rely on, so the
  // URL is sampled once a second while the slot is mounted.
  function useProfile() {
    var state = useState(currentProfile());
    var profile = state[0], setProfile = state[1];
    useEffect(function () {
      var id = setInterval(function () { setProfile(currentProfile()); }, 1000);
      return function () { clearInterval(id); };
    }, []);
    return profile;
  }

  function withProfile(path, profile) {
    if (profile === "default") return path;
    // some paths this is used on already carry a query string (e.g. nav counts'
    // "/api/sessions?limit=1"), so join with "&" when one is already there
    return path + (path.indexOf("?") >= 0 ? "&" : "?") + "profile=" + encodeURIComponent(profile);
  }

  // Fetch through the SDK (it carries the dashboard session), optionally
  // re-polling every `everyMs`.
  function useJSON(path, everyMs) {
    var state = useState(null);
    var data = state[0], setData = state[1];
    useEffect(function () {
      var alive = true;
      var load = function () {
        SDK.fetchJSON(path)
          .then(function (d) { if (alive) setData(d); })
          .catch(function (err) {
            if (window.console) console.debug("[nothing-hud] " + path + " unavailable:", err);
          });
      };
      setData(null);
      load();
      var id = everyMs ? setInterval(load, everyMs) : null;
      return function () { alive = false; if (id) clearInterval(id); };
    }, [path, everyMs]);
    return data;
  }

  // Friendly names for the platform keys the gateway reports. `api_server` is not a
  // messaging channel and not Linphone: it is Hermes' own local HTTP API, the endpoint
  // a phone-call agent thinks with. Anything unlisted falls back to the
  // raw key, so a new platform still shows up.
  var PLAT_LABELS = { api_server: "Hermes API · calls", telegram: "Telegram", discord: "Discord",
    local: "Local", cron: "Cron", webhook: "Webhook", acp: "ACP" };
  function platName(k) {
    if (PLAT_LABELS[k]) return PLAT_LABELS[k];
    return String(k || "").replace(/_/g, " ").replace(/\b[a-z]/g, function (c) { return c.toUpperCase(); });
  }

  // Accept a bare array or a list under a few common keys.
  function listOf(d, keys) {
    if (Array.isArray(d)) return d;
    if (!d || typeof d !== "object") return null;
    for (var i = 0; i < keys.length; i++) {
      if (Array.isArray(d[keys[i]])) return d[keys[i]];
    }
    return null;
  }

  function two(n) { return n < 10 ? "0" + n : String(n); }

  // ---- header-left: wordmark --------------------------------------------

  // Rendered just before the Hermes brand; style.css hides that adjacent
  // brand while this mark is present, so the two never collide.
  function Wordmark() {
    var active = useNothingTheme();
    var neu = useNeu();
    if (!active) return null;
    if (neu) return h(NeuRailHead);
    return h("span", { className: "nothing-hud-mark" },
      h("span", { className: "nothing-hud-mark-name" }, "Hermes"),
      h("span", { className: "nothing-hud-label" }, "hermes agent")
    );
  }

  // ---- chat:top: profile name, dot-matrix --------------------------------

  function ChatProfile() {
    var active = useNothingTheme();
    var neu = useNeu();
    var profile = useProfile();
    var plist = listOf(useJSON("/api/profiles"), ["profiles", "items", "data"]) || [];
    var row = plist.filter(function (p) { return p.name === profile; })[0];
    if (!active) return null;
    return h("div", { className: "nothing-hud-strip" + (neu ? " nh-neu-strip" : "") },
      h("span", { className: "nothing-hud-label" }, "profile"),
      h("span", { className: "nothing-hud-dots nothing-hud-dots--md" }, (row && row.display_name) || profile)
    );
  }

  // ---- cron:top: PAUSED stamp --------------------------------------------

  function isPaused(job) {
    if (!job || typeof job !== "object") return false;
    if (job.paused === true || job.enabled === false || job.active === false) return true;
    var s = String(job.state || job.status || "");
    return /paus/i.test(s);
  }

  function jobName(job) {
    return String(job.name || job.title || job.description || job.id || "job");
  }

  function CronPaused() {
    var active = useNothingTheme();
    var data = useJSON("/api/cron/jobs");
    if (!active) return null;
    var jobs = listOf(data, ["jobs", "items", "data"]);
    if (!jobs) return null;
    var paused = jobs.filter(isPaused);
    if (!paused.length) return null;
    return h("div", { className: "nothing-hud-paused" },
      h("div", { className: "nothing-hud-stamp" },
        h("span", { className: "nothing-hud-glyph", "aria-hidden": "true" },
          h("i"), h("i")),
        h("span", { className: "nothing-hud-dots nothing-hud-dots--lg" }, "Paused")
      ),
      h("div", { className: "nothing-hud-body" },
        h("span", { className: "nothing-hud-label" },
          two(paused.length) + " of " + two(jobs.length) + " jobs held"),
        paused.map(function (job, i) {
          return h("span", { key: i, className: "nothing-hud-name" }, jobName(job));
        })
      )
    );
  }

  // ---- skills:top: enabled count -----------------------------------------

  function enabledState(skill) {
    if (!skill || typeof skill !== "object") return null;
    if (typeof skill.enabled === "boolean") return skill.enabled;
    if (typeof skill.disabled === "boolean") return !skill.disabled;
    var s = String(skill.state || skill.status || "");
    if (/^enabled|^active|^on$/i.test(s)) return true;
    if (/^disabled|^inactive|^off$/i.test(s)) return false;
    return null;
  }

  function SkillsCount() {
    var active = useNothingTheme();
    var profile = useProfile();
    var data = useJSON(withProfile("/api/skills", profile));
    if (!active) return null;
    var skills = listOf(data, ["skills", "items", "data"]);
    if (!skills || !skills.length) return null;
    var states = skills.map(enabledState);
    if (states.every(function (s) { return s === null; })) return null;
    var on = states.filter(function (s) { return s === true; }).length;
    return h("div", { className: "nothing-hud-count" },
      h("span", { className: "nothing-hud-dots nothing-hud-dots--lg" }, two(on)),
      h("div", { className: "nothing-hud-body" },
        h("span", { className: "nothing-hud-name" }, "enabled in " + profile),
        h("span", { className: "nothing-hud-label" }, "of " + two(skills.length) + " in the library")
      )
    );
  }

  // ---- analytics:top: authoritative spend --------------------------------

  function money(v) { return "$" + Number(v).toFixed(2); }

  function Segments(props) {
    var n = 50, on = Math.round((props.used / props.cap) * n);
    var cells = [];
    for (var i = 0; i < n; i++) {
      cells.push(h("i", { key: i, className: i < on ? "on" : "" }));
    }
    return h("div", { className: "nothing-hud-seg", role: "img",
      "aria-label": money(props.used) + " of " + money(props.cap) + " used" },
      cells, props.limit ? h("b", { className: "nothing-hud-limit", title: "key cap" }) : null);
  }

  function SpendHero() {
    var active = useNothingTheme();
    var d = useJSON("/api/plugins/nothing-hud/spend");
    if (!active || !d || !d.ok || d.month === null || d.month === undefined) return null;
    var hasCap = typeof d.cap === "number" && d.cap > 0 && typeof d.capLeft === "number";
    var facts = [];
    if (typeof d.today === "number") facts.push("today " + money(d.today));
    if (typeof d.week === "number") facts.push("week " + money(d.week));
    if (typeof d.creditLeft === "number" && typeof d.credits === "number") {
      facts.push("credit " + money(d.creditLeft) + " of " + money(d.credits) + " left");
    }
    return h("div", { className: "nothing-hud-spend" },
      h("span", { className: "nothing-hud-label" }, "spent this month · openrouter, authoritative"),
      h("span", { className: "nothing-hud-dots nothing-hud-dots--lg" }, money(d.month)),
      hasCap ? h(Segments, { used: d.cap - d.capLeft, cap: d.cap, limit: true }) : null,
      hasCap ? h("div", { className: "nothing-hud-scale" },
        h("span", { className: "nothing-hud-label" }, "$0"),
        h("span", { className: "nothing-hud-name" },
          "key " + money(d.capLeft) + " of " + money(d.cap) + " left" + (d.reset ? " · resets " + d.reset : "")),
        h("span", { className: "nothing-hud-label" }, money(d.cap))) : null,
      facts.length ? h("span", { className: "nothing-hud-label" }, facts.join(" · ")) : null
    );
  }

  // ---- Status tab: the mockup's instrument panel -------------------------
  // 0.21.5 ships no Status page, so the plugin's own tab is the Status screen.
  // Reads GET /api/status (shape taken from the host's 0.21.5 sample, with
  // fallbacks for older builds), /api/config for the model, and /spend.

  function upper(v) { return String(v == null ? "—" : v).toUpperCase(); }

  function sinceHM(iso) {
    var t = Date.parse(iso || "");
    if (isNaN(t)) return null;
    var m = Math.max(0, Math.floor((Date.now() - t) / 60000));
    return two(Math.floor(m / 60)) + ":" + two(m % 60);
  }

  function Meter(props) {
    var n = 20, on = Math.max(0, Math.min(n, Math.round(props.ratio * n)));
    var cells = [];
    for (var i = 0; i < n; i++) cells.push(h("i", { key: i, className: i < on ? "on" : "" }));
    return h("div", { className: "nothing-hud-cell" },
      h("span", { className: "nothing-hud-label" }, props.label),
      h("div", { className: "nothing-hud-seg nothing-hud-seg--thin" }, cells),
      h("span", { className: "nothing-hud-label" }, props.caption));
  }

  function Cell(props) {
    return h("div", { className: "nothing-hud-cell" },
      h("span", { className: "nothing-hud-label" }, props.label),
      h("span", { className: "nothing-hud-read" + (props.alarm ? " nothing-hud-alarm" : "") },
        props.value, props.unit ? h("span", { className: "nothing-hud-label" }, " " + props.unit) : null),
      props.sub ? h("span", { className: "nothing-hud-label" }, props.sub) : null);
  }

  function modelOf(cfg) {
    if (!cfg) return null;
    var m = cfg.model;
    if (m && typeof m === "object") m = m.default || m.name || m.model;
    return typeof m === "string" ? m : null;
  }

  function routeOf(cfg) {
    if (!cfg) return null;
    var pr = cfg.provider_routing || (cfg.openrouter && cfg.openrouter.provider) || null;
    var order = pr && Array.isArray(pr.order) ? pr.order : null;
    return order && order.length ? "pinned " + order.join(" › ") : null;
  }

  function StatusPage() {
    var st = useJSON("/api/status", 15000);
    var cfg = useJSON("/api/config");
    var spend = useJSON("/api/plugins/nothing-hud/spend", 60000);
    if (!st) return h("div", { className: "nothing-hud-page" },
      h("span", { className: "nothing-hud-label" }, "reading /api/status …"));

    var gwState = st.gateway_state || (st.gateway_running ? "running" : "stopped");
    var down = gwState !== "running";
    var plats = st.gateway_platforms && typeof st.gateway_platforms === "object" ? st.gateway_platforms : {};
    var names = Object.keys(plats);
    var connected = names.filter(function (k) { return plats[k] && plats[k].state === "connected"; });
    var nominal = st.overall ? st.overall === "ok" : !down;
    var up = st.memory && st.memory.boot_id ? sinceHM(st.memory.boot_id) : null;
    var hasSpend = spend && spend.ok && typeof spend.month === "number";
    var hasCap = hasSpend && typeof spend.cap === "number" && spend.cap > 0 && typeof spend.capLeft === "number";

    var hero = hasSpend
      ? h("div", { className: "nothing-hud-spend" },
          h("span", { className: "nothing-hud-label" }, "spent this month · openrouter"),
          h("span", { className: "nothing-hud-dots nothing-hud-dots--lg" }, money(spend.month)),
          hasCap ? h(Segments, { used: spend.cap - spend.capLeft, cap: spend.cap }) : null,
          hasCap ? h("div", { className: "nothing-hud-scale" },
            h("span", { className: "nothing-hud-label" }, "$0"),
            h("span", { className: "nothing-hud-name" }, "key " + money(spend.capLeft) + " of " + money(spend.cap) + " left"),
            h("span", { className: "nothing-hud-label" }, money(spend.cap))) : null)
      : h("div", { className: "nothing-hud-spend" },
          h("span", { className: "nothing-hud-label" }, "gateway"),
          h("span", { className: "nothing-hud-dots nothing-hud-dots--lg" + (down ? " nothing-hud-alarm" : "") }, gwState));

    var mem = st.memory, disk = st.disk;
    var meters = [];
    if (mem && mem.system_total_mb) {
      var usedMb = mem.system_total_mb - (mem.system_available_mb || 0);
      meters.push(h(Meter, { key: "mem", label: "memory", ratio: usedMb / mem.system_total_mb,
        caption: usedMb + " / " + mem.system_total_mb + " mb · gateway " + (mem.gateway_rss_mb || "—") + " mb" }));
    }
    if (disk && typeof disk.used_percent === "number") {
      meters.push(h(Meter, { key: "disk", label: "disk", ratio: disk.used_percent / 100,
        caption: Math.round(disk.used_percent) + "% · " + (disk.free_mb || "—") + " mb free" }));
    }

    return h("div", { className: "nothing-hud-page" },
      h("div", { className: "nothing-hud-head" },
        h("span", { className: "nothing-hud-sq" + (down ? " nothing-hud-alarm-bg" : "") }),
        h("span", { className: "nothing-hud-name" + (down ? " nothing-hud-alarm" : "") },
          down ? "Gateway " + upper(gwState) : nominal ? "All nominal" : "Attention"),
        h("span", { className: "nothing-hud-label" }, "machine-level · get /api/status")),
      h("div", { className: "nothing-hud-top" },
        hero,
        h("div", { className: "nothing-hud-grid" },
          h(Cell, { label: "gateway", value: upper(gwState), alarm: down,
            sub: (st.gateway_mode || "") + (st.gateway_busy ? " · busy" : "") }),
          h(Cell, { label: "uptime", value: up || "—", unit: up ? "h:m" : null, sub: up ? "since gateway boot" : "not reported" }),
          h(Cell, { label: "platforms", value: two(connected.length), unit: "connected",
            sub: names.map(function (k) { return platName(k) + " · " + ((plats[k] && plats[k].state) || "?"); }).join("  ") || "none" }),
          h(Cell, { label: "active work", value: two(st.active_sessions || 0), unit: "sessions",
            sub: two(st.active_agents || 0) + " agents" }))),
      h("div", { className: "nothing-hud-band" },
        h(Cell, { label: "model", value: modelOf(cfg) || "—", sub: routeOf(cfg) }),
        meters),
      h("div", { className: "nothing-hud-foot" },
        h("span", { className: "nothing-hud-label" }, "hermes v" + (st.version || "?") + (st.release_date ? " · " + st.release_date : "")),
        st.can_update_hermes ? h("span", { className: "nothing-hud-label" }, "update available") : null,
        h("span", { className: "nothing-hud-label" }, "profiles · " + ((st.profiles || []).join(" · ") || "default")),
        h("span", { className: "nothing-hud-label" }, st.auth_required ? "auth gate on" : "localhost only")));
  }



  // ---- the concept's rail: head, profile box, counts ----------------------

  // Counts beside nav items, as in the concept. Only a data attribute is set
  // on the dashboard's own links (CSS draws it); no markup is added or moved.
  var COUNT_SOURCES = [
    { href: "/sessions", path: "/api/sessions?limit=1", read: function (d) { return d && typeof d.total === "number" ? d.total : null; } },
    { href: "/cron", path: "/api/cron/jobs", read: function (d) { var l = listOf(d, ["jobs", "items", "data"]); return l ? l.length : null; } },
    { href: "/skills", path: "/api/skills", read: function (d) {
        var l = listOf(d, ["skills", "items", "data"]); if (!l) return null;
        var on = l.map(enabledState).filter(function (x) { return x === true; }).length;
        return on || l.length; } },
    { href: "/mcp", path: "/api/mcp/servers", read: function (d) { var l = listOf(d, ["servers", "items", "data"]); return l ? l.length : (d && typeof d === "object" ? Object.keys(d).length : null); } },
  ];

  // `profile` is the profile currently shown (useShownProfile() in the caller):
  // every count below is per-profile server-side (sessions, cron jobs, skills,
  // MCP servers each take their own ?profile= and fall back to the dashboard's
  // OWN active profile when it's left off, never "whichever profile's page
  // you're looking at") — so leaving it off here is exactly what made a nav
  // badge show a different profile's number next to the page you're viewing.
  function useNavCounts(enabled, profile) {
    useEffect(function () {
      if (!enabled) return undefined;
      var counts = {}, alive = true;
      var paint = function () {
        var side = document.getElementById("app-sidebar");
        if (!side) return;
        markHub(side);
        document.documentElement.setAttribute("data-nh-route", window.location.pathname);
        COUNT_SOURCES.forEach(function (c) {
          var a = side.querySelector('nav a[href="' + c.href + '"]');
          if (!a) return;
          var v = counts[c.href];
          if (v === undefined || v === null) a.removeAttribute("data-nh-count");
          else if (a.getAttribute("data-nh-count") !== two(v)) a.setAttribute("data-nh-count", two(v));
        });
      };
      var load = function () {
        COUNT_SOURCES.forEach(function (c) {
          SDK.fetchJSON(withProfile(c.path, profile)).then(function (d) { if (!alive) return; counts[c.href] = c.read(d); paint(); })
            .catch(function () { /* a count that cannot be read is simply not shown */ });
        });
      };
      load();
      var id = setInterval(load, 60000);
      var side = document.getElementById("app-sidebar");
      var mo = side ? new MutationObserver(paint) : null;
      if (mo) mo.observe(side, { childList: true, subtree: true, attributes: true, attributeFilter: ["aria-current"] });
      return function () {
        alive = false; clearInterval(id); if (mo) mo.disconnect();
        var s2 = document.getElementById("app-sidebar");
        if (s2) [].forEach.call(s2.querySelectorAll("[data-nh-count], [data-nh-hub-on]"), function (a) {
          a.removeAttribute("data-nh-count"); a.removeAttribute("data-nh-hub-on"); });
        document.documentElement.removeAttribute("data-nh-route");
      };
    }, [enabled, profile]);
  }

  // Pages the Settings hub (plugin nothing-settings, tab /hub) gathers. The
  // rail hides their own links; while one is open the hub link shows current.
  var HUB_PAGES = ["/models", "/profiles", "/mcp", "/plugins", "/channels", "/pairing",
    "/webhooks", "/env", "/config", "/system", "/docs", "/achievements"];

  function markHub(side) {
    var hub = side.querySelector('nav a[href="/hub"]');
    if (!hub) return;
    var here = window.location.pathname.replace(/\/+$/, "");
    var on = HUB_PAGES.some(function (p) { return here === p || here.indexOf(p + "/") === 0; });
    if (on && hub.getAttribute("data-nh-hub-on") !== "1") hub.setAttribute("data-nh-hub-on", "1");
    if (!on && hub.hasAttribute("data-nh-hub-on")) hub.removeAttribute("data-nh-hub-on");
    var n = two(HUB_PAGES.filter(function (p) { return side.querySelector('nav a[href="' + p + '"]'); }).length);
    if (hub.getAttribute("data-nh-count") !== n) hub.setAttribute("data-nh-count", n);
  }

  // The profile the dashboard is showing: ?profile= when present, else the
  // sticky active profile (the dashboard's own switcher does the same).
  function useShownProfile() {
    var urlProfile = useProfile();
    var hasParam = !!new URLSearchParams(window.location.search).get("profile");
    var act = useJSON("/api/profiles/active");
    if (hasParam) return urlProfile;
    return (act && (act.active || act.current)) || "default";
  }

  var PROFILE_TONES = ["violet", "sky", "amber", "mint"];

  // Switching works exactly like the dashboard's own profile switcher: the
  // choice rides in ?profile= and every page reads it. The sticky CLI profile
  // (hermes profile use) is not touched.
  function goProfile(name) {
    var q = new URLSearchParams(window.location.search);
    q.set("profile", name);
    window.location.assign(window.location.pathname + "?" + q.toString());
  }

  function ProfileMenu(props) {
    var data = useJSON("/api/profiles");
    var list = listOf(data, ["profiles", "items", "data"]);
    // the menu floats over the rail (absolute, under the profile box) instead of pushing the menu down
    return h("div", { className: "nh-pmenu nh-raised", role: "menu" },
      !list ? h("span", { className: "nothing-hud-label nh-popt" }, "reading profiles …") :
        list.map(function (p, i) {
          var on = p.name === props.current;
          return h("button", { key: p.name, type: "button", role: "menuitem",
            className: "nh-popt" + (on ? " on" : ""),
            onClick: function () { if (on) props.close(); else goProfile(p.name); } },
            h("i", { className: "nh-pd nh-bg-" + PROFILE_TONES[i % PROFILE_TONES.length] }),
            h("span", { className: "nh-popt-text" },
              h("b", null, p.display_name || p.name),
              h("span", { className: "nh-sub" }, p.description || p.model || (p.is_default ? "the main profile" : "profile"))),
            on ? h("span", { className: "nh-meta" }, "shown")
              : p.gateway_running ? h("span", { className: "nh-meta nh-c-mint", title: "gateway running" }, "live") : null);
        }),
      h("hr"),
      h("a", { className: "nh-pnew", href: "/profiles/new" }, "+ New profile"),
      h("a", { className: "nh-pnew nh-pmanage", href: "/profiles" }, "Manage profiles →"));
  }

  function NeuRailHead() {
    var profile = useShownProfile();
    var plist = listOf(useJSON("/api/profiles"), ["profiles", "items", "data"]) || [];
    var row = plist.filter(function (p) { return p.name === profile; })[0];
    var shown = (row && row.display_name) || profile;
    var st = useJSON("/api/status", 60000);
    var open = useState(false);
    useNavCounts(true, profile);
    useEffect(function () {
      if (!open[0]) return undefined;
      var close = function (e) {
        if (e.type === "keydown" && e.key !== "Escape") return;
        if (e.type === "mousedown" && e.target.closest && e.target.closest(".nh-pdrop")) return;
        open[1](false);
      };
      document.addEventListener("mousedown", close);
      document.addEventListener("keydown", close);
      return function () { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", close); };
    }, [open[0]]);
    return h("span", { className: "nothing-hud-mark nh-neu-mark" },
      h("span", { className: "nh-brandrow" },
        h("span", { className: "nh-knob nh-raised-sm" }, h("i")),
        h("span", { className: "nh-neu-mark-text" },
          h("span", { className: "nothing-hud-mark-name" }, "Hermes"),
          h("span", { className: "nothing-hud-label" }, "hermes" + (st && st.version ? " · v" + st.version : " agent")))),
      h("span", { className: "nh-pdrop" + (open[0] ? " open" : "") },
        h("button", { type: "button", className: "nh-profilebox nh-pressed", "aria-haspopup": "menu", "aria-expanded": open[0] ? "true" : "false",
          onClick: function () { open[1](!open[0]); } },
          h("span", null,
            h("span", { className: "nothing-hud-label" }, "profile"),
            h("span", { className: "nothing-hud-dots nh-profile-name" }, shown)),
          h("span", { className: "nothing-hud-label nh-chev" }, "▾")),
        open[0] ? h(ProfileMenu, { current: profile, close: function () { open[1](false); } }) : null));
  }

  // ---- Neumorphism × Nothing ---------------------------------------------

  var THEME_DARK = "nothing-neu", THEME_WHITE = "nothing-neu-light";

  // The Dark/White switch is a small control in the upper right of the window. It is made with plain DOM
  // on <body>: the rail is a transformed, clipping box, so a fixed element inside it would be placed
  // relative to the rail and cut off. The rail keeps only the MODE box.
  function pickTheme(name, mode) {
    if ((name === THEME_WHITE) === (mode === "light")) return;
    SDK.api.setTheme(name).then(function () { window.location.reload(); })
      .catch(function (e) { if (window.console) console.debug("[nothing-hud] setTheme failed", e); });
  }
  function syncThemeFloat(neu, mode) {
    var el = document.getElementById("nh-themefloat");
    if (!neu) { if (el) el.remove(); return; }
    if (!el) {
      el = document.createElement("div");
      el.id = "nh-themefloat"; el.className = "nh-themefloat nh-raised-sm"; el.setAttribute("role", "group"); el.setAttribute("aria-label", "Theme");
      [["Dark", "☾", THEME_DARK], ["White", "☀", THEME_WHITE]].forEach(function (b) {
        var btn = document.createElement("button");
        btn.type = "button"; btn.title = b[0]; btn.setAttribute("aria-label", b[0]); btn.setAttribute("data-theme-name", b[2]); btn.textContent = b[1];
        btn.addEventListener("click", function () { pickTheme(b[2], neuMode()); });
        el.appendChild(btn);
      });
      document.body.appendChild(el);
    }
    [].forEach.call(el.querySelectorAll("button"), function (btn) {
      var on = (btn.getAttribute("data-theme-name") === THEME_WHITE) === (mode === "light");
      btn.classList.toggle("on", on);
    });
  }

  function ThemeSwitch() {
    var neu = useNeu();
    var mode = useWatch(neuMode);
    useEffect(function () {
      syncThemeFloat(!!neu, mode);
      return function () { var el = document.getElementById("nh-themefloat"); if (el) el.remove(); };
    }, [!!neu, mode]);
    if (!neu) return null;
    return h("div", { className: "nh-footboxes" }, h(ModeBox));
  }

  // MODE box: one button into Lock In (plugin nothing-lockin, page /lockin).
  // Shown only when that plugin is installed. The page you leave from is
  // remembered so "← Dashboard" brings you back to it.
  function ModeBox() {
    var plugins = useJSON("/api/dashboard/plugins");
    var has = Array.isArray(plugins) && plugins.some(function (p) { return p && p.name === "nothing-lockin"; });
    if (!has) return null;
    var go = function () {
      try { localStorage.setItem("nh-lockin:back", window.location.pathname + window.location.search); } catch (e) { /* not kept */ }
      var prof = new URLSearchParams(window.location.search).get("profile");
      window.history.pushState({}, "", "/lockin" + (prof ? "?profile=" + encodeURIComponent(prof) : ""));
      window.dispatchEvent(new PopStateEvent("popstate"));
    };
    return h("div", { className: "nh-modebox nh-pressed" },
      h("span", { className: "nothing-hud-label" }, "mode"),
      h("button", { type: "button", className: "nh-btn nh-btn-primary nh-modebtn", onClick: go }, "Lock In →"),
      h("span", { className: "nh-modehint" }, "files, editor and chat in one view"));
  }

  function Pill(props) {
    return h("span", { className: "nh-pill nh-pressed nh-c-" + (props.tone || "fg") },
      props.dot === false ? null : h("i", { className: "nh-dot" }), props.children);
  }

  // A round instrument: a pressed ring with a glowing arc.
  function Dial(props) {
    var r = 84, c = 2 * Math.PI * r;
    var frac = Math.max(0, Math.min(1, props.frac));
    return h("div", { className: "nh-dial nh-raised" },
      h("svg", { viewBox: "0 0 194 194", "aria-hidden": "true" },
        h("circle", { cx: 97, cy: 97, r: r, className: "nh-dial-track" }),
        h("circle", { cx: 97, cy: 97, r: r, className: "nh-dial-arc",
          strokeDasharray: (c * frac).toFixed(1) + " " + c.toFixed(1), transform: "rotate(-90 97 97)" })),
      h("div", { className: "nh-dial-inner nh-pressed" },
        h("div", null,
          h("div", { className: "nothing-hud-label" }, props.label),
          h("div", { className: "nh-big" }, props.value),
          h("div", { className: "nothing-hud-label" }, props.sub))));
  }

  function Track(props) {
    var n = props.n || 20, on = Math.max(0, Math.min(n, Math.round(props.ratio * n)));
    var cells = [];
    for (var i = 0; i < n; i++) cells.push(h("i", { key: i, className: i < on ? "on" : "" }));
    return h("div", { className: "nh-track nh-pressed" }, cells);
  }

  function Tile(props) {
    return h("section", { className: "nh-tile nh-raised" + (props.className ? " " + props.className : "") }, props.children);
  }
  function TileHead(props) {
    return h("div", { className: "nh-row" }, h("span", { className: "nothing-hud-label" }, props.label), props.right || null);
  }

  function SpendBlock(props) {
    var d = props.spend;
    var hasCap = typeof d.cap === "number" && d.cap > 0 && typeof d.capLeft === "number";
    return h("div", { className: "nh-hero" },
      hasCap ? h(Dial, { frac: (d.cap - d.capLeft) / d.cap, label: "key cap", value: money(d.capLeft), sub: "of " + money(d.cap) + " left" }) : null,
      h("div", { className: "nh-hero-text" },
        h("span", { className: "nothing-hud-label" }, "hermes · spent this month"),
        h("span", { className: "nothing-hud-dots nh-dots-xl" }, money(d.month)),
        h("div", { className: "nh-pills" },
          typeof d.today === "number" ? h(Pill, { dot: false }, "today " + money(d.today)) : null,
          typeof d.week === "number" ? h(Pill, { dot: false }, "week " + money(d.week)) : null,
          typeof d.creditLeft === "number" ? h(Pill, { dot: false, tone: "violet" }, "balance " + money(d.creditLeft)) : null),
        h("span", { className: "nothing-hud-label" }, d.reset ? "resets " + d.reset : "")));
  }

  // Honcho's own OpenRouter key (the memory service), read through a Management key on
  // the server: figures only. Shown beside Hermes's, with the two added together.
  function HonchoBlock(props) {
    var d = props.spend, hn = d.honcho;
    var hasCap = typeof hn.cap === "number" && hn.cap > 0 && typeof hn.capLeft === "number";
    var total = (typeof d.month === "number" ? d.month : 0) + (typeof hn.month === "number" ? hn.month : 0);
    return h("div", { className: "nh-honcho nh-well" },
      h("div", { className: "nh-row" },
        h("span", { className: "nothing-hud-label" }, "honcho · memory · this month"),
        h(Pill, { dot: false, tone: "violet" }, "hermes + honcho " + money(total))),
      h("div", { className: "nh-row nh-honcho-main" },
        h("span", { className: "nothing-hud-dots nh-dots-md" }, money(hn.month || 0)),
        h("span", { className: "nothing-hud-label" }, typeof hn.today === "number" ? "today " + money(hn.today) : "")),
      hasCap ? h(Track, { ratio: (hn.cap - hn.capLeft) / hn.cap, n: 30 }) : null,
      hasCap ? h("span", { className: "nothing-hud-label" }, "key " + money(hn.capLeft) + " of " + money(hn.cap) + " left") : null);
  }

  function ago(ts) {
    try {
      if (typeof ts === "number" && SDK.utils && SDK.utils.timeAgo) return SDK.utils.timeAgo(ts);
      if (typeof ts === "string" && SDK.utils && SDK.utils.isoTimeAgo) return SDK.utils.isoTimeAgo(ts);
    } catch (e) { /* fall through */ }
    return "";
  }

  function NeuStatus() {
    var st = useJSON("/api/status", 15000);
    var cfg = useJSON("/api/config");
    var spend = useJSON("/api/plugins/nothing-hud/spend", 60000);
    var cron = useJSON("/api/cron/jobs", 30000);
    var sess = useJSON("/api/sessions?limit=3", 30000);
    if (!st) return h("div", { className: "nh-page" }, h("span", { className: "nothing-hud-label" }, "reading /api/status …"));

    var gwState = st.gateway_state || (st.gateway_running ? "running" : "stopped");
    var down = gwState !== "running";
    var plats = st.gateway_platforms && typeof st.gateway_platforms === "object" ? st.gateway_platforms : {};
    var names = Object.keys(plats);
    var connected = names.filter(function (k) { return plats[k] && plats[k].state === "connected"; });
    var nominal = st.overall ? st.overall === "ok" : !down;
    var up = st.memory && st.memory.boot_id ? sinceHM(st.memory.boot_id) : null;
    var jobs = listOf(cron, ["jobs", "items", "data"]) || [];
    var sessions = listOf(sess, ["sessions", "items", "data"]) || [];
    var mem = st.memory, disk = st.disk;
    var hasSpend = spend && spend.ok && typeof spend.month === "number";

    return h("div", { className: "nh-page" },
      h("div", { className: "nh-row nh-pagehead" },
        h(Pill, { tone: down ? "red" : nominal ? "mint" : "amber" }, down ? "gateway " + gwState : nominal ? "all nominal" : "attention"),
        h("span", { className: "nothing-hud-label" }, "hermes v" + (st.version || "?") + (st.can_update_hermes ? " · update available" : ""))),
      h("div", { className: "nh-bento" },
        h(Tile, { className: "nh-span2" },
          hasSpend ? h("div", { className: "nh-herostack" }, h(SpendBlock, { spend: spend }), spend.honcho ? h(HonchoBlock, { spend: spend }) : null)
            : h("div", { className: "nh-hero-text" },
                h("span", { className: "nothing-hud-label" }, "gateway"),
                h("span", { className: "nothing-hud-dots nh-dots-xl" + (down ? " nh-c-red" : "") }, gwState))),
        h(Tile, null,
          h(TileHead, { label: "gateway", right: h(Pill, { tone: down ? "red" : "mint" }, gwState) }),
          h("div", { className: "nh-big" }, up || "—", up ? h("span", { className: "nothing-hud-label" }, " h:m up") : null),
          h("span", { className: "nothing-hud-label" }, (st.gateway_mode || "") + (st.gateway_busy ? " · busy" : ""))),
        h(Tile, null,
          h(TileHead, { label: "platforms", right: h(Pill, { tone: "sky" }, connected.length + " / " + names.length) }),
          h("div", { className: "nh-big" }, names.length ? names.map(platName).join(" · ") : "—"),
          h("span", { className: "nothing-hud-label" }, names.map(function (k) { return (plats[k] && plats[k].state) || "?"; }).join(" · ") || "none configured")),
        h(Tile, null,
          h(TileHead, { label: "active work", right: st.gateway_busy ? h(Pill, { tone: "violet" }, "busy") : null }),
          h("div", { className: "nh-big" }, two(st.active_sessions || 0), h("span", { className: "nothing-hud-label" }, " session · " + two(st.active_agents || 0) + " agent")),
          sessions[0] ? h("span", { className: "nothing-hud-label" }, String(sessions[0].title || sessions[0].preview || "")) : null),
        h(Tile, null,
          h(TileHead, { label: "cron", right: jobs.some(isPaused) ? h(Pill, { tone: "amber" }, two(jobs.filter(isPaused).length) + " paused") : h(Pill, { tone: "mint" }, two(jobs.length) + " active") }),
          jobs.slice(0, 2).map(function (j, i) {
            return h("a", { key: i, href: "/cron", className: "nh-row nh-link" },
              h("div", null, h("div", { className: "nh-name" }, jobName(j)),
                h("div", { className: "nothing-hud-label" }, (j.schedule_display || (j.schedule && j.schedule.display) || "") + (j.deliver ? " · " + j.deliver : ""))),
              h("span", { className: "nh-tog nh-pressed" + (isPaused(j) ? "" : " on") }, h("i")));
          }),
          jobs.length ? null : h("span", { className: "nothing-hud-label" }, "no jobs")),
        h(Tile, { className: "nh-span2b" },
          h("span", { className: "nothing-hud-label" }, "model"),
          h("div", { className: "nh-name nh-lg" }, modelOf(cfg) || "—"),
          h("div", { className: "nh-pills" },
            cfg && cfg.model && typeof cfg.model === "object" && cfg.model.provider ? h(Pill, { dot: false, tone: "sky" }, cfg.model.provider) : null,
            routeOf(cfg) ? h(Pill, { dot: false, tone: "sky" }, routeOf(cfg)) : null)),
        h(Tile, null,
          mem && mem.system_total_mb ? [
            h(TileHead, { key: "mh", label: "memory", right: h("span", { className: "nothing-hud-label" }, (mem.system_total_mb - (mem.system_available_mb || 0)) + " / " + mem.system_total_mb + " mb") }),
            h(Track, { key: "mt", ratio: (mem.system_total_mb - (mem.system_available_mb || 0)) / mem.system_total_mb })] : null,
          disk && typeof disk.used_percent === "number" ? [
            h(TileHead, { key: "dh", label: "disk", right: h("span", { className: "nothing-hud-label" }, Math.round(disk.used_percent) + "% · " + (disk.free_mb ? (disk.free_mb / 1024).toFixed(1) + " gb free" : "")) }),
            h(Track, { key: "dt", ratio: disk.used_percent / 100 })] : null,
          !(mem && mem.system_total_mb) && !(disk && typeof disk.used_percent === "number") ? h("span", { className: "nothing-hud-label" }, "system readouts not reported by this version") : null),
        h(Tile, null,
          h("span", { className: "nothing-hud-label" }, "recent sessions"),
          sessions.length ? sessions.slice(0, 3).map(function (x, i) {
            return h("div", { key: i, className: "nh-row nh-well" },
              h("span", { className: "nh-ellipsis" }, String(x.title || x.preview || x.id || "untitled")),
              h("span", { className: "nothing-hud-label" }, ago(x.last_active || x.started_at)));
          }) : h("span", { className: "nothing-hud-label" }, "no sessions yet"))));
  }

  function StatusTab() { return useNeu() ? h(NeuStatus) : h(StatusPage); }

  // ---- Cron: every job in a list, the selected one as the big card -------
  // Replaces the built-in list while a Neu theme is on (style.css hides it;
  // "classic view" in the list header brings it back for the fields this
  // card does not edit: model, toolsets, skills, workdir, blueprints).

  function jobState(j) {
    if (isPaused(j)) return "paused";
    if (j.last_status && !/^ok$/i.test(String(j.last_status))) return "failed";
    return "active";
  }
  var STATE_TONE = { paused: "amber", failed: "red", active: "mint" };

  function jobProfile(j) { return j.profile_name || j.profile || "default"; }
  function jobKind(j) {
    if (j.script) return "script";
    if ((j.skills && j.skills.length) || j.skill) return "skill";
    return "agent";
  }
  function jobSchedule(j) { return j.schedule_display || (j.schedule && j.schedule.display) || "—"; }
  function jobLine(j) {
    return jobSchedule(j) + " · " + jobKind(j) + (j.deliver && j.deliver !== "local" ? " → " + j.deliver : "");
  }

  function untilText(iso) {
    var t = Date.parse(iso || "");
    if (isNaN(t)) return "—";
    var m = Math.round((t - Date.now()) / 60000);
    if (m <= 0) return "due now";
    if (m < 60) return "in " + m + " min";
    if (m < 48 * 60) return "in " + Math.floor(m / 60) + " h " + two(m % 60) + " min";
    return "in " + Math.round(m / 1440) + " days";
  }

  function apiCall(fn, args) {
    if (!SDK.api || typeof SDK.api[fn] !== "function") return Promise.reject(new Error(fn + " is not in this dashboard's SDK"));
    return SDK.api[fn].apply(SDK.api, args);
  }
  function errText(e) {
    var m = e && (e.detail || e.message) ? String(e.detail || e.message) : String(e);
    return m.length > 160 ? m.slice(0, 157) + "…" : m;
  }

  function Stamp(props) {
    var st = props.state;
    var mark = st === "paused" ? h("div", { className: "nh-bars" }, h("i"), h("i"))
      : st === "failed" ? h("div", { className: "nh-x nh-c-red" }, "✕")
      : h("div", { className: "nh-orb" });
    return h("div", { className: "nh-stamp nh-pressed" },
      h("div", null, mark, h("div", { className: "nothing-hud-dots nh-c-" + STATE_TONE[st], style: { fontSize: "26px" } }, st)));
  }

  function RunDots(props) {
    var dots = [];
    for (var i = 0; i < 8; i++) {
      dots.push(h("i", { key: i, className: props.state === "paused" ? "nh-pressed" : "nh-run-mint",
        style: props.state === "paused" ? null : { opacity: (1 - i * 0.1).toFixed(2) } }));
    }
    return h("div", { className: "nh-runs" }, dots);
  }

  function RecentRuns(props) {
    var j = props.job;
    var data = useJSON("/api/cron/jobs/" + encodeURIComponent(j.id) + "/runs?limit=5&profile=" + encodeURIComponent(jobProfile(j)) + "&r=" + props.tick);
    var runs = listOf(data, ["runs", "items", "data"]);
    return h("section", { className: "nh-tile nh-raised" },
      h(TileHead, { label: "recent runs", right: runs ? h("span", { className: "nothing-hud-label" }, two(runs.length)) : null }),
      !runs ? h("span", { className: "nothing-hud-label" }, "reading runs …")
        : !runs.length ? h("span", { className: "nothing-hud-label" }, "no runs yet")
        : runs.map(function (r, i) {
            var dur = r.ended_at && r.started_at ? Math.max(0, r.ended_at - r.started_at) : null;
            var live = r.is_active;
            return h("a", { key: r.id || i, href: "/sessions/" + encodeURIComponent(r.id || ""), className: "nh-jrun nh-well nh-link" },
              h("i", { className: "nh-pd nh-bg-" + (live ? "violet" : i === 0 && j.last_status && j.last_status !== "ok" ? "red" : "mint") }),
              h("span", { className: "nh-ellipsis" }, String(r.title || r.preview || (live ? "running" : "run")) + (r.message_count ? " · " + r.message_count + " msg" : "")),
              h("span", { className: "nothing-hud-label" }, ago(r.started_at)),
              h("span", { className: "nothing-hud-label" }, dur === null ? (live ? "live" : "") : dur < 120 ? Math.round(dur) + "s" : Math.round(dur / 60) + "m"));
          }));
  }

  function Field(props) {
    return h("label", { className: "nh-field" }, h("span", { className: "nothing-hud-label" }, props.label), props.children,
      props.hint ? h("span", { className: "nothing-hud-label nh-hint" }, props.hint) : null);
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
    return h("div", { className: "nh-confirm-wrap", onMouseDown: function (e) { if (e.target === e.currentTarget) props.onCancel(); } },
      h("div", { className: "nh-confirm nh-raised", role: "dialog", "aria-modal": "true", "aria-label": props.title || "confirm", ref: box, onKeyDown: onKey },
        h("span", { className: "nothing-hud-label" }, props.title || "confirm"),
        h("div", { className: "nh-confirm-msg" }, props.message),
        h("div", { className: "nh-acts nh-confirm-acts" },
          h("button", { type: "button", className: "nh-btn nh-raised-sm", disabled: !!props.busy, onClick: props.onCancel }, props.cancelLabel || "Cancel"),
          h("button", { type: "button", className: "nh-btn nh-raised-sm nh-c-red", "data-ok": "1", disabled: !!props.busy, onClick: props.onOk },
            props.busy ? (props.busyLabel || "working…") : (props.okLabel || "OK")))));
  }

  // Settings drawer: edit (job given) or create (job null).
  function CronDrawer(props) {
    var j = props.job;
    var targets = useJSON("/api/cron/delivery-targets");
    var profs = useJSON("/api/profiles");
    var form = useState(function () {
      return {
        name: j ? (j.name || "") : "",
        prompt: j ? (j.prompt || "") : "",
        schedule: j ? (j.schedule_display || (j.schedule && j.schedule.expr) || "") : "every 1h",
        deliver: j ? (j.deliver || "local") : "local",
        profile: j ? jobProfile(j) : props.profile,
      };
    });
    var f = form[0];
    var set = function (k) { return function (e) { var n = Object.assign({}, f); n[k] = e.target.value; form[1](n); }; };
    var busy = useState(null), err = useState(null), confirmDel = useState(false);
    var tlist = listOf(targets, ["targets"]) || [{ id: "local", name: "Local (save only)" }];
    if (f.deliver && !tlist.some(function (t) { return t.id === f.deliver; })) tlist = tlist.concat([{ id: f.deliver, name: f.deliver }]);
    var plist = (listOf(profs, ["profiles"]) || [{ name: f.profile }]).map(function (p) { return p.name; });
    var kind = j ? jobKind(j) : "agent";

    var save = function () {
      err[1](null);
      var run;
      if (j) {
        var up = {};
        if (f.name !== (j.name || "")) up.name = f.name;
        if (kind === "agent" && f.prompt !== (j.prompt || "")) up.prompt = f.prompt;
        if (f.schedule.trim() && f.schedule.trim() !== jobSchedule(j)) up.schedule = f.schedule.trim();
        if (f.deliver !== (j.deliver || "local")) up.deliver = f.deliver;
        if (!Object.keys(up).length) { props.close(); return; }
        run = apiCall("updateCronJob", [j.id, up, jobProfile(j)]);
      } else {
        if (!f.prompt.trim() || !f.schedule.trim()) { err[1]("a prompt and a schedule are needed"); return; }
        run = apiCall("createCronJob", [{ name: f.name || null, prompt: f.prompt, schedule: f.schedule.trim(), deliver: f.deliver }, f.profile]);
      }
      busy[1]("saving");
      run.then(function (res) { busy[1](null); props.done(res && res.id); })
        .catch(function (e) { busy[1](null); err[1](errText(e)); });
    };
    var del = function () {
      busy[1]("deleting");
      apiCall("deleteCronJob", [j.id, jobProfile(j)])
        .then(function () { busy[1](null); confirmDel[1](false); props.done(null, true); })
        .catch(function (e) { busy[1](null); confirmDel[1](false); err[1](errText(e)); });
    };

    return h(React.Fragment, null,
      h("div", { className: "nh-drawer-wrap" },
      h("div", { className: "nh-scrim", onClick: props.close }),
      h("aside", { className: "nh-drawer nh-raised", role: "dialog", "aria-label": j ? "Cron job settings" : "New cron job" },
        h("div", { className: "nh-row" },
          h("div", null, h("div", { className: "nothing-hud-label" }, j ? "settings" : "new job"),
            h("div", { className: "nh-name nh-lg" }, j ? jobName(j) : "Untitled job")),
          h("button", { type: "button", className: "nh-iconbtn nh-raised-sm", "aria-label": "Close", onClick: props.close }, "✕")),
        h(Field, { label: "name" }, h("input", { className: "nh-in nh-pressed", value: f.name, onChange: set("name"), placeholder: "e.g. Morning briefing" })),
        h(Field, { label: "runs as" }, h("div", { className: "nh-seg nh-pressed" },
          ["agent", "script", "skill"].map(function (k) { return h("span", { key: k, className: k === kind ? "on" : "" }, k); }))),
        kind === "agent"
          ? h(Field, { label: "prompt" }, h("textarea", { className: "nh-in nh-pressed", rows: 5, value: f.prompt, onChange: set("prompt"), placeholder: "What the agent should do on every run…" }))
          : h(Field, { label: kind, hint: "edit the " + kind + " in classic view" }, h("div", { className: "nh-in nh-pressed nh-ro" }, kind === "script" ? String(j.script) : String((j.skills && j.skills.join(", ")) || j.skill))),
        h(Field, { label: "schedule", hint: "every 30m · 0 7 * * * (cron) · 2h (once)" },
          h("input", { className: "nh-in nh-pressed nh-mono", value: f.schedule, onChange: set("schedule") })),
        h(Field, { label: "deliver to" }, h("select", { className: "nh-in nh-pressed", value: f.deliver, onChange: set("deliver") },
          tlist.map(function (t) { return h("option", { key: t.id, value: t.id, disabled: t.home_target_set === false }, (t.name || t.id) + (t.home_target_set === false ? " (no home channel)" : "")); }))),
        h(Field, { label: "profile", hint: j ? "a job stays in the profile it was made in" : null },
          j ? h("div", { className: "nh-in nh-pressed nh-ro" }, f.profile)
            : h("select", { className: "nh-in nh-pressed", value: f.profile, onChange: set("profile") },
                plist.map(function (n) { return h("option", { key: n, value: n }, n); }))),
        err[0] ? h("div", { className: "nh-err nh-c-red" }, err[0]) : null,
        h("div", { className: "nh-acts nh-drawer-acts" },
          h("button", { type: "button", className: "nh-btn nh-btn-primary", disabled: !!busy[0], onClick: save }, busy[0] === "saving" ? "saving…" : j ? "Save" : "Create"),
          h("button", { type: "button", className: "nh-btn nh-raised-sm", disabled: !!busy[0], onClick: props.close }, "Cancel"),
          j ? h("button", { type: "button", className: "nh-btn nh-raised-sm nh-c-red nh-push", disabled: !!busy[0], onClick: function () { confirmDel[1](true); } }, busy[0] === "deleting" ? "deleting…" : "Delete") : null))),
      confirmDel[0] ? h(Confirm, {
        title: "delete cron job",
        message: "Delete the cron job “" + jobName(j) + "”? This cannot be undone.",
        okLabel: "Delete", busy: busy[0] === "deleting",
        onCancel: function () { confirmDel[1](false); }, onOk: del,
      }) : null);
  }

  function NeuCron() {
    var profile = useShownProfile();
    var tick = useState(0);
    var data = useJSON("/api/cron/jobs?profile=all" + (tick[0] ? "&r=" + tick[0] : ""), 30000);
    var selS = useState(null), filt = useState("all"), drawer = useState(null), busy = useState(null), err = useState(null);
    var classic = useState(false);
    useEffect(function () {
      document.documentElement.classList.toggle("nh-cron-classic", classic[0]);
      return function () { document.documentElement.classList.remove("nh-cron-classic"); };
    }, [classic[0]]);
    var refresh = function () { tick[1](Date.now()); };

    var all = listOf(data, ["jobs", "items", "data"]);
    if (!all) return h("section", { className: "nh-cron4" }, h("span", { className: "nothing-hud-label" }, "reading cron jobs …"));
    var profiles = [];
    all.forEach(function (j) { if (profiles.indexOf(jobProfile(j)) < 0) profiles.push(jobProfile(j)); });
    var jobs = filt[0] === "all" ? all : all.filter(function (j) { return jobProfile(j) === filt[0]; });
    var j = jobs.filter(function (x) { return x.id === selS[0]; })[0]
      || jobs.filter(function (x) { return jobState(x) === "paused"; })[0] || jobs[0] || null;
    var counts = { paused: 0, failed: 0, active: 0 };
    all.forEach(function (x) { counts[jobState(x)]++; });

    var act = function (fn, label) {
      busy[1](label); err[1](null);
      apiCall(fn, [j.id, jobProfile(j)]).then(function () { busy[1](null); refresh(); })
        .catch(function (e) { busy[1](null); err[1](errText(e)); });
    };

    var head = h("div", { className: "nh-row nh-cron4-head" },
      h("div", { className: "nh-pills" },
        counts.paused ? h(Pill, { tone: "amber" }, counts.paused + " paused") : null,
        counts.failed ? h(Pill, { tone: "red" }, counts.failed + " failed") : null,
        h(Pill, { tone: "mint" }, counts.active + " active")),
      profiles.length > 1 ? h("div", { className: "nh-seg nh-pressed nh-seg-fit" },
        ["all"].concat(profiles).map(function (p) {
          return h("button", { key: p, type: "button", className: filt[0] === p ? "on" : "", onClick: function () { filt[1](p); } }, p);
        })) : null);

    var list = h("section", { className: "nh-jlist nh-raised" },
      h("div", { className: "nh-row nh-jlist-head" },
        h("span", { className: "nothing-hud-label" }, "jobs · " + (filt[0] === "all" ? "all profiles" : filt[0])),
        h("span", { className: "nothing-hud-label" }, two(jobs.length))),
      jobs.map(function (x) {
        var stx = jobState(x);
        return h("button", { key: jobProfile(x) + "/" + x.id, type: "button", className: "nh-jrow" + (j && x.id === j.id ? " on" : ""),
          onClick: function () { selS[1](x.id); err[1](null); } },
          h("i", { className: "nh-pd nh-bg-" + STATE_TONE[stx] }),
          h("span", { className: "nh-jrow-text" }, h("b", null, jobName(x)), h("span", { className: "nothing-hud-label" }, jobLine(x))),
          h("span", { className: "nothing-hud-label nh-c-" + STATE_TONE[stx] }, stx));
      }),
      h("button", { type: "button", className: "nh-pnew nh-jnew", onClick: function () { drawer[1]("new"); } }, "+ new job"),
      h("button", { type: "button", className: "nh-pnew nh-classic", onClick: function () { classic[1](!classic[0]); } },
        classic[0] ? "hide classic view" : "classic view ↓"));

    var card = null;
    if (j) {
      var stj = jobState(j), paused = stj === "paused";
      var kv = function (k, v, tone) {
        return h("div", { className: "nh-well nh-kv" }, h("span", { className: "nothing-hud-label" }, k), h("span", { className: tone ? "nh-c-" + tone : "" }, v));
      };
      card = h("div", { className: "nh-cron4-main" },
        h("section", { className: "nh-tile nh-raised nh-cron nh-cron-" + stj },
          h(Stamp, { state: stj }),
          h("div", { className: "nh-cron-body" },
            h("div", { className: "nh-row" },
              h("div", { style: { minWidth: 0 } }, h("div", { className: "nh-name nh-lg" }, jobName(j)),
                h("div", { className: "nothing-hud-label" }, jobProfile(j) + " · " + jobLine(j))),
              h("div", { className: "nh-row nh-gap" },
                h("button", { type: "button", className: "nh-btn nh-raised-sm", onClick: function () { drawer[1]("edit"); } }, "⚙ Settings"),
                h("button", { type: "button", className: "nh-tog nh-pressed" + (paused ? "" : " on"), disabled: !!busy[0],
                  "aria-label": paused ? "Resume" : "Pause", title: paused ? "Resume" : "Pause",
                  onClick: function () { act(paused ? "resumeCronJob" : "pauseCronJob", paused ? "resuming" : "pausing"); } }, h("i")))),
            h("div", { className: "nh-kvs nh-kvs3" },
              kv("schedule", h("span", { className: "nh-mono" }, jobSchedule(j))),
              kv("runs as", jobKind(j)),
              kv("profile", jobProfile(j)),
              kv("last run", j.last_run_at ? ago(j.last_run_at) : "never", stj === "failed" ? "red" : null),
              kv("next run", paused ? "held" : untilText(j.next_run_at), paused ? "amber" : null),
              kv("delivers to", j.deliver || "local")),
            stj === "failed" && (j.last_error || j.last_delivery_error)
              ? h("div", { className: "nh-well nh-c-red nh-errbox" }, String(j.last_error || j.last_delivery_error).slice(0, 300)) : null,
            h("div", null, h("div", { className: "nothing-hud-label", style: { marginBottom: "10px" } }, paused ? "next 8 runs · all held" : "next 8 runs"),
              h(RunDots, { state: stj })),
            err[0] ? h("div", { className: "nh-err nh-c-red" }, err[0]) : null,
            h("div", { className: "nh-acts" },
              h("button", { type: "button", className: "nh-btn nh-btn-primary", disabled: !!busy[0],
                onClick: function () { act(paused ? "resumeCronJob" : "pauseCronJob", paused ? "resuming" : "pausing"); } },
                busy[0] === "resuming" ? "resuming…" : busy[0] === "pausing" ? "pausing…" : paused ? "▶ Resume" : "‖ Pause"),
              h("button", { type: "button", className: "nh-btn nh-raised-sm", disabled: !!busy[0],
                onClick: function () { act("triggerCronJob", "triggering"); } }, busy[0] === "triggering" ? "triggering…" : "Trigger once")))),
        h(RecentRuns, { job: j, tick: tick[0] }));
    } else {
      card = h("section", { className: "nh-tile nh-raised nh-cron-empty" },
        h("span", { className: "nothing-hud-dots nh-dots-xl" }, "00"),
        h("span", { className: "nh-name nh-lg" }, "No cron jobs yet"),
        h("span", { className: "nothing-hud-label" }, "make one with + new job"));
    }

    return h("div", { className: "nh-cron4" },
      head,
      h("div", { className: "nh-cron4-grid" }, list, card),
      drawer[0] ? h(CronDrawer, {
        job: drawer[0] === "edit" ? j : null, profile: profile,
        close: function () { drawer[1](null); },
        done: function (newId, deleted) { drawer[1](null); if (newId) selS[1](newId); if (deleted) selS[1](null); refresh(); },
      }) : null);
  }

  function NeuSkills() {
    var profile = useProfile();
    var data = useJSON(withProfile("/api/skills", profile));
    var skills = listOf(data, ["skills", "items", "data"]);
    if (!skills || !skills.length) return null;
    var states = skills.map(enabledState);
    if (states.every(function (s) { return s === null; })) return null;
    var on = states.filter(function (s) { return s === true; }).length;
    return h("section", { className: "nh-tile nh-raised nh-inline" },
      h("span", { className: "nothing-hud-dots nh-dots-xl" }, two(on)),
      h("div", { className: "nothing-hud-body" },
        h("span", { className: "nh-name nh-lg" }, "enabled in " + profile),
        h("span", { className: "nothing-hud-label" }, "of " + two(skills.length) + " in the library")));
  }

  function NeuSpend() {
    var d = useJSON("/api/plugins/nothing-hud/spend", 60000);
    if (!d || !d.ok || typeof d.month !== "number") return null;
    return h("section", { className: "nh-tile nh-raised" }, h(SpendBlock, { spend: d }));
  }

  // Slot wrappers: the neumorphic piece under Neu themes, the flat one otherwise.
  function pick(Neu, Flat) {
    return function () {
      var active = useNothingTheme(), neu = useNeu();
      if (!active) return null;
      return neu ? h(Neu) : h(Flat);
    };
  }

  // ---- registration ------------------------------------------------------

  REG.register(NAME, StatusTab);
  REG.registerSlot(NAME, "header-left", Wordmark);
  REG.registerSlot(NAME, "chat:top", ChatProfile);
  REG.registerSlot(NAME, "header-right", ThemeSwitch);
  REG.registerSlot(NAME, "cron:top", pick(NeuCron, CronPaused));
  REG.registerSlot(NAME, "skills:top", pick(NeuSkills, SkillsCount));
  REG.registerSlot(NAME, "analytics:top", pick(NeuSpend, SpendHero));
})();
