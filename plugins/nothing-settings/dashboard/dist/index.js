/*
 * nothing-settings — the Settings hub tab (/hub).
 *
 * Every page that is a setting rather than daily work sits here as a tile.
 * The pages themselves are the dashboard's own; a tile only navigates. Under
 * the Neumorphism themes nothing-hud's style.css hides their sidebar links
 * and keeps this one, so the rail stays short.
 *
 * Plain IIFE, no build step: React and fetchJSON come from the plugin SDK.
 * Live readouts on the tiles are counts and names only, never values.
 */
(function () {
  "use strict";

  var SDK = window.__HERMES_PLUGIN_SDK__;
  var REG = window.__HERMES_PLUGINS__;
  if (!SDK || !REG || !SDK.React) return;

  var h = SDK.React.createElement;
  var useState = SDK.hooks.useState;
  var useEffect = SDK.hooks.useEffect;

  function useJSON(path) {
    var s = useState(null);
    useEffect(function () {
      var alive = true;
      SDK.fetchJSON(path).then(function (d) { if (alive) s[1](d); })
        .catch(function () { /* a readout that cannot be read is left out */ });
      return function () { alive = false; };
    }, [path]);
    return s[0];
  }
  function two(n) { return n < 10 ? "0" + n : String(n); }
  function count(d, key) {
    var l = Array.isArray(d) ? d : d && Array.isArray(d[key]) ? d[key] : null;
    return l ? l.length : null;
  }

  var SECTIONS = [
    { title: "AI · the agent's brain", tiles: [
      { path: "/models", name: "Models", tone: "violet", text: "Main model, helper-task models, Mixture of Agents, usage per model." },
      { path: "/profiles", name: "Profiles", tone: "violet", text: "Separate agents: each with its own config, skills, memory and cron." },
      { path: "/mcp", name: "MCP", tone: "sky", text: "Tool servers the agent can call." },
      { path: "/plugins", name: "Plugins", tone: "sky", text: "Dashboard and agent plugins: install, enable, disable." }] },
    { title: "Connections", tiles: [
      { path: "/channels", name: "Channels", tone: "mint", text: "Telegram, Discord and the other messaging platforms." },
      { path: "/pairing", name: "Pairing", tone: "mint", text: "Pair a chat account with the agent." },
      { path: "/webhooks", name: "Webhooks", tone: "mint", text: "Incoming hooks that start agent runs." },
      { path: "/env", name: "Keys", tone: "amber", text: "API keys and secrets in .env. Values stay on that page." }] },
    { title: "System", tiles: [
      { path: "/config", name: "Config", tone: "fg", text: "Every config.yaml setting, as a form or raw YAML." },
      { path: "/system", name: "System", tone: "fg", text: "Version, updates, restart, backups and diagnostics." },
      { path: "/docs", name: "Documentation", tone: "fg", text: "The Hermes docs, inside the dashboard." },
      { path: "/achievements", name: "Achievements", tone: "fg", text: "Badges for the ways you use the agent." }] },
  ];

  function useMeta() {
    var cfg = useJSON("/api/config");
    var profiles = useJSON("/api/profiles");
    var mcp = useJSON("/api/mcp/servers");
    var plugins = useJSON("/api/dashboard/plugins");
    var st = useJSON("/api/status");
    var env = useJSON("/api/env");
    var meta = {};
    var m = cfg && cfg.model;
    if (m && typeof m === "object") m = m.default || m.name || m.model;
    if (typeof m === "string") meta["/models"] = m;
    var n = count(profiles, "profiles");
    if (n !== null) meta["/profiles"] = n + (n === 1 ? " profile" : " profiles");
    n = count(mcp, "servers");
    if (n !== null) meta["/mcp"] = two(n) + (n === 1 ? " server" : " servers");
    n = count(plugins, "plugins");
    if (n !== null) meta["/plugins"] = two(n) + " in dashboard";
    if (st && st.gateway_platforms && typeof st.gateway_platforms === "object") {
      var names = Object.keys(st.gateway_platforms);
      var on = names.filter(function (k) { return st.gateway_platforms[k] && st.gateway_platforms[k].state === "connected"; });
      meta["/channels"] = names.length ? on.length + " / " + names.length + " connected" : "none set up";
    }
    if (st && st.version) meta["/system"] = "v" + st.version + (st.can_update_hermes ? " · update" : "");
    if (env && typeof env === "object" && !Array.isArray(env)) {
      var set = Object.keys(env).filter(function (k) { return env[k] && env[k].is_set; }).length;
      meta["/env"] = two(set) + " set";
    }
    return meta;
  }

  // Navigate inside the app: click the dashboard's own (hidden) link so the
  // router keeps ?profile=; plain navigation when the link is not there.
  function go(e, path) {
    var link = document.querySelector('#app-sidebar nav a[href="' + path + '"]');
    if (link && !e.metaKey && !e.ctrlKey && !e.shiftKey) { e.preventDefault(); link.click(); }
  }

  function Hub() {
    var q = useState("");
    var meta = useMeta();
    var needle = q[0].trim().toLowerCase();
    var present = function (t) { return !!document.querySelector('#app-sidebar nav a[href="' + t.path + '"]') || !document.getElementById("app-sidebar"); };
    var sections = SECTIONS.map(function (s) {
      return { title: s.title, tiles: s.tiles.filter(function (t) {
        return present(t) && (!needle || (t.name + " " + t.text + " " + (meta[t.path] || "")).toLowerCase().indexOf(needle) >= 0);
      }) };
    }).filter(function (s) { return s.tiles.length; });

    return h("div", { className: "nhs-page" },
      h("div", { className: "nhs-top" },
        h("span", { className: "nhs-label" }, "everything that is a setting, in one place"),
        h("label", { className: "nhs-search nhs-pressed" },
          h("span", { className: "nhs-label", "aria-hidden": "true" }, "⌕"),
          h("input", { type: "search", placeholder: "Search settings…", value: q[0],
            onChange: function (e) { q[1](e.target.value); }, "aria-label": "Search settings" }))),
      sections.length ? sections.map(function (s) {
        return h("section", { key: s.title, className: "nhs-sec" },
          h("div", { className: "nhs-sechead" }, h("h2", null, s.title), h("span", { className: "nhs-label" }, s.tiles.length + (s.tiles.length === 1 ? " page" : " pages"))),
          h("div", { className: "nhs-grid" }, s.tiles.map(function (t) {
            return h("a", { key: t.path, href: t.path, className: "nhs-tile nhs-raised", onClick: function (e) { go(e, t.path); } },
              h("div", { className: "nhs-row" },
                h("span", { className: "nhs-ico nhs-pressed" }, h("i", { className: "nhs-bg-" + t.tone })),
                meta[t.path] ? h("span", { className: "nhs-label nhs-meta" }, meta[t.path]) : null),
              h("b", null, t.name),
              h("p", null, t.text));
          })));
      }) : h("span", { className: "nhs-label" }, "nothing matches “" + q[0] + "”"));
  }

  REG.register("nothing-settings", Hub);
})();
