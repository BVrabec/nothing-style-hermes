/*
 * nothing-lockin — Lock In mode (/lockin), rounds 1–2.
 *
 * A full-window, VS Code-style view of the selected profile's own folder
 * (/root/<profile>, chosen by this plugin's GET /folder). Left column: brand,
 * profile box, the folder as a tree (new file, new folder, upload, download,
 * delete), then THEME and MODE boxes in the same place as in the dashboard.
 * Files are listed, uploaded, downloaded and deleted through Hermes's own
 * /api/files routes. Drag files from the desktop anywhere to upload.
 *
 * Round 2: clicking a file opens it in a tab in the main area.
 *   - text / markdown / code / config: a plain editor. Read with
 *     GET /api/fs/read-text, saved with POST /api/fs/write-text (Save button or
 *     Ctrl+S; an amber dot on the tab marks unsaved changes).
 *   - images and PDFs: fetched through /api/files/download (the /api/files/stream
 *     route only serves audio and video) and shown from a blob URL.
 *   - Word (.docx) and Excel (.xlsx), round 3: a read-only view drawn from plain data
 *     returned by this plugin's GET /preview (never HTML).
 *   - anything else (old .doc/.xls, archives, binaries): the file card.
 *
 * The page covers the dashboard while it is open (position: fixed), and its
 * state (open folders, selection, open tabs, the dashboard page you came from)
 * is kept per profile in localStorage, so switching modes returns you to the
 * same place. Unsaved editor text is kept in memory while you switch modes.
 *
 * Round 4: the profile's Chat sits in the same window. It is Hermes's own Chat page
 * (the real terminal UI, same model, tools, memory and sessions) shown in a frame at
 * /chat?nhembed=1, started inside the profile's folder. With no file open the chat
 * fills the main area; with tabs open it docks on the right (drag the bar to resize,
 * × to hide). In the frame (nhembed=1) this same script hides the dashboard's own
 * menu and header and tells Chat which folder to start in.
 *
 * Plain IIFE, no build step: React and fetch helpers come from the plugin SDK.
 */
(function () {
  "use strict";

  var SDK = window.__HERMES_PLUGIN_SDK__;
  var REG = window.__HERMES_PLUGINS__;
  if (!SDK || !REG || !SDK.React) return;

  // ---- inside the chat frame (/chat?nhembed=1&nhcwd=<folder>) ----------------------
  // Hermes's Chat page starts a fresh chat in the workspace stored under
  // "hermes-chat-workspace:<profile>". The parent (Dock below) puts the profile's
  // folder under that key just before the frame loads and puts the old value back as soon
  // as the terminal is up. As a second line of defence, in this frame that read also
  // answers with the folder (the plugin script can load after the chat has connected, so
  // the parent's way is the one that must work). CSS (style.css, html.nhl-embed) hides the
  // dashboard chrome.
  try {
    var sp = new URLSearchParams(window.location.search);
    if (sp.get("nhembed") === "1" && window.parent !== window) {
      document.documentElement.classList.add("nhl-embed");
      var wantCwd = sp.get("nhcwd");
      if (wantCwd) {
        var realGet = Storage.prototype.getItem;
        Storage.prototype.getItem = function (k) {
          if (this === window.localStorage && String(k).indexOf("hermes-chat-workspace:") === 0) return wantCwd;
          return realGet.apply(this, arguments);
        };
      }
    }
  } catch (e) { /* the chat then simply starts where Hermes would start it */ }

  var h = SDK.React.createElement;
  var useState = SDK.hooks.useState;
  var useEffect = SDK.hooks.useEffect;
  var useRef = SDK.hooks.useRef;
  // not in the plugin SDK's own hook set, but React itself has it (round 13): fires synchronously after
  // layout, before the browser paints, so a window's measured on-screen position is never one frame stale
  var useLayoutEffect = SDK.React.useLayoutEffect || useEffect;
  var API = "/api/plugins/nothing-lockin";

  // Round 8: the terminal janitor (plugin_api.py) runs inside the dashboard and is started by this call. Every page
  // of the dashboard loads this script, so it is running whenever anyone has the dashboard open. (Not in a chat frame.)
  try {
    if (!document.documentElement.classList.contains("nhl-embed")) {
      setTimeout(function () { SDK.fetchJSON(API + "/janitor").catch(function () { /* older install: no janitor */ }); }, 1500);
    }
  } catch (e) { /* never in the way */ }
  var KEY = "nh-lockin:";

  // ---- small helpers ------------------------------------------------------
  function q(v) { return encodeURIComponent(v); }
  function errText(e) {
    var m = e && (e.detail || e.message) ? String(e.detail || e.message) : String(e);
    return m.length > 200 ? m.slice(0, 197) + "…" : m;
  }
  function cap(s) { s = String(s || ""); return s.charAt(0).toUpperCase() + s.slice(1); }
  function size(n) {
    if (n == null) return "";
    if (n < 1024) return n + " B";
    if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
    return (n / 1048576).toFixed(1) + " MB";
  }
  function when(t) {
    if (!t) return "";
    try { return new Date(t * 1000).toLocaleString(); } catch (e) { return ""; }
  }
  function ext(name) { var m = /\.([a-z0-9]+)$/i.exec(name || ""); return m ? m[1].toLowerCase() : ""; }
  var KIND = { md: "md", txt: "txt", pdf: "pdf", doc: "doc", docx: "doc", xls: "xls", xlsx: "xls", csv: "csv",
    png: "img", jpg: "img", jpeg: "img", gif: "img", webp: "img", svg: "img", json: "json", yml: "yml", yaml: "yml",
    py: "py", js: "js", ts: "ts", sh: "sh", html: "html", css: "css", zip: "zip" };
  function kind(e) { return e.is_directory ? "dir" : (KIND[ext(e.name)] || ext(e.name).slice(0, 4) || "file"); }
  function baseName(p) { return p.slice(p.lastIndexOf("/") + 1); }

  // What opens how. Images and PDFs get viewers; these types are never tried as
  // text (they get the file card); everything else is tried as text and falls
  // back to the card when Hermes reports it as binary.
  var IMG_MIME = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
    svg: "image/svg+xml", bmp: "image/bmp", ico: "image/x-icon" };
  var NOTEXT = { doc: 1, docx: 1, xls: 1, xlsx: 1, ppt: 1, pptx: 1, odt: 1, ods: 1, zip: 1, gz: 1, tar: 1, "7z": 1, rar: 1,
    mp3: 1, mp4: 1, wav: 1, ogg: 1, m4a: 1, mov: 1, mkv: 1, webm: 1, avi: 1, flac: 1, opus: 1 };
  var SOFTWRAP = { md: 1, markdown: 1, txt: 1, log: 1, rst: 1, "": 1 };
  function viewerOf(path) {
    var x = ext(path);
    return IMG_MIME[x] ? "image" : x === "pdf" ? "pdf" : (x === "docx" || x === "xlsx") ? "office" : NOTEXT[x] ? "card" : "text";
  }
  function colName(i) {   // 1 → A, 27 → AA
    var s = "";
    for (; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
    return s;
  }

  // Open editor buffers live here, outside React state, so unsaved text survives
  // leaving Lock In for the dashboard and coming back. A page reload loses them,
  // which is why leaving the page while any buffer is unsaved asks first.
  var BUF = {};
  function isDirty(b) { return !!b && b.text != null && b.text !== b.base; }
  window.addEventListener("beforeunload", function (e) {
    if (Object.keys(BUF).some(function (p) { return isDirty(BUF[p]); })) { e.preventDefault(); e.returnValue = ""; }
  });
  function parentOf(p) { var i = p.lastIndexOf("/"); return i > 0 ? p.slice(0, i) : "/"; }
  function join(dir, name) { return dir.replace(/\/+$/, "") + "/" + name; }
  function rel(root, p) { return p === root ? "" : p.indexOf(root + "/") === 0 ? p.slice(root.length + 1) : p; }

  function loadState(profile) {
    try { return JSON.parse(localStorage.getItem(KEY + profile) || "{}") || {}; } catch (e) { return {}; }
  }
  function saveState(profile, st) {
    try { localStorage.setItem(KEY + profile, JSON.stringify(st)); } catch (e) { /* private mode: state just isn't kept */ }
  }
  function lastDashboard() {
    try { return localStorage.getItem(KEY + "back") || "/status"; } catch (e) { return "/status"; }
  }

  // Client-side navigation: the dashboard's router listens to popstate.
  function navigate(path) {
    window.history.pushState({}, "", path);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }

  function urlProfile() {
    var p = new URLSearchParams(window.location.search).get("profile");
    return p && p.trim() ? p.trim() : null;
  }

  function mode() {
    return getComputedStyle(document.documentElement).getPropertyValue("--neu-mode").trim() === "light" ? "light" : "dark";
  }

  // ---- markdown (round 16) ------------------------------------------------
  // A .md file opens as formatted text instead of raw source. The parser builds plain
  // objects and MarkdownView turns them into React elements -- never an HTML string --
  // so nothing inside a file can inject markup into the dashboard.
  // Covered: headings (#, and === / --- under a line), bold, italic, strikethrough,
  // inline code, fenced code, unordered / ordered / nested / task lists, blockquotes,
  // tables with alignment, horizontal rules, links, autolinks, escapes. Images show as
  // a chip: their bytes need the dashboard login, which a plain <img> cannot carry.
  var MD_EXT = { md: 1, markdown: 1, mdx: 1, mdwn: 1 };
  function isMarkdown(path) { return !!MD_EXT[ext(path)]; }

  function mdSafeHref(u) {
    var s = String(u == null ? "" : u).trim();
    var m = /^([a-z][a-z0-9+.-]*):/i.exec(s);
    if (!m) return s || null;                                        // no scheme: a relative path or an anchor
    return /^(https?|mailto|tel)$/i.test(m[1]) ? s : null;           // javascript:, data:, file: stay plain text
  }

  function mdInline(src) {
    src = String(src == null ? "" : src);
    var out = [], buf = "", i = 0, n = src.length, m;
    function flush() { if (buf) { out.push({ t: "txt", v: buf }); buf = ""; } }
    function push(node) { flush(); out.push(node); }
    function emphasis(mark) {   // **x** / __x__ / *x* / _x_ / ~~x~~ — no lookbehind: Safari < 16.4 lacks it
      var esc = mark.replace(/([.*+?^${}()|[\]\\])/g, "\\$1");
      var re = new RegExp("^" + esc + "(?!\\s)([\\s\\S]*?)" + esc);
      var mm = re.exec(src.slice(i));
      if (!mm || !mm[1] || /\s$/.test(mm[1])) return false;
      var kind = mark === "~~" ? "del" : mark.length === 2 ? "strong" : "em";
      push({ t: kind, kids: mdInline(mm[1]) });
      i += mm[0].length;
      return true;
    }
    while (i < n) {
      var c = src.charAt(i), rest = src.slice(i);
      if (c === "\\" && i + 1 < n && /[\\`*_{}\[\]()#+\-.!>~|]/.test(src.charAt(i + 1))) { buf += src.charAt(i + 1); i += 2; continue; }
      if (c === "`") {
        m = /^(`+)([\s\S]*?)\1/.exec(rest);
        if (m && m[2].indexOf("`") < 0) { push({ t: "code", v: m[2].replace(/^ ([\s\S]*) $/, "$1") }); i += m[0].length; continue; }
      }
      if (c === "!" || c === "[") {
        m = new RegExp("^" + (c === "!" ? "!" : "") + "\\[([^\\]]*)\\]\\(([^)\\s]*)(?:\\s+\"[^\"]*\")?\\)").exec(rest);
        if (m) {
          var label = m[1] || m[2], href = mdSafeHref(m[2]);
          if (c === "!") push({ t: "img", alt: label, src: m[2] });
          else if (href) push({ t: "link", href: href, kids: mdInline(label) });
          else push({ t: "code", v: label });          // a link we will not follow: show its text
          i += m[0].length; continue;
        }
      }
      if (c === "~" && src.substr(i, 2) === "~~") { if (emphasis("~~")) continue; }
      if (c === "*" || c === "_") {
        // an underscore inside a word (a_file_name) is not emphasis
        if (c === "*" || i === 0 || /[\s([{"'*_~>]/.test(src.charAt(i - 1))) {
          if (emphasis(c + c) || emphasis(c)) continue;
        }
      }
      if ((c === "h" || c === "H") && /^https?:\/\//i.test(rest)) {
        m = /^https?:\/\/[^\s<>()\[\]]*[^\s<>()\[\].,;:!?'"]/.exec(rest);
        if (m) { push({ t: "link", href: m[0], kids: [{ t: "txt", v: m[0] }] }); i += m[0].length; continue; }
      }
      buf += c; i++;
    }
    flush();
    return out;
  }

  function mdIndent(s) { return /^\s*/.exec(s)[0].replace(/\t/g, "    ").length; }
  function mdIsRule(s) { return /^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(s); }
  function mdIsFence(s) { return /^\s{0,3}(`{3,}|~{3,})/.test(s); }
  function mdIsBullet(s) { return /^\s*([-*+]|\d+[.)])\s+/.test(s); }
  function mdIsHeading(s) { return /^\s{0,3}#{1,6}\s/.test(s); }

  function mdSplitRow(row) {
    var s = String(row).trim().replace(/^\|/, "").replace(/\|$/, ""), cells = [], buf = "", i = 0;
    while (i < s.length) {
      var c = s.charAt(i);
      if (c === "\\" && s.charAt(i + 1) === "|") { buf += "|"; i += 2; continue; }
      if (c === "|") { cells.push(buf); buf = ""; i++; continue; }
      buf += c; i++;
    }
    cells.push(buf);
    return cells.map(function (x) { return x.trim(); });
  }

  function mdTable(lines, i) {
    var head = mdSplitRow(lines[i]);
    var align = mdSplitRow(lines[i + 1]).map(function (c) {
      var l = c.charAt(0) === ":", r = c.charAt(c.length - 1) === ":";
      return l && r ? "center" : r ? "right" : l ? "left" : null;
    });
    var rows = [], j = i + 2;
    while (j < lines.length && lines[j].trim() && lines[j].indexOf("|") >= 0) { rows.push(mdSplitRow(lines[j]).map(mdInline)); j++; }
    return { node: { t: "table", head: head.map(mdInline), align: align, rows: rows }, next: j };
  }

  function mdList(lines, i) {
    var base = mdIndent(lines[i]);
    var ordered = /^\s*\d+[.)]\s+/.test(lines[i]);
    var start = ordered ? parseInt(/^\s*(\d+)/.exec(lines[i])[1], 10) : 1;
    var items = [], cur = null, j = i;
    while (j < lines.length) {
      var ln = lines[j];
      if (!ln.trim()) {
        var nx = lines[j + 1];
        if (nx && nx.trim() && mdIndent(nx) > base) { if (cur) cur.lines.push(""); j++; continue; }
        break;
      }
      var m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(ln);
      if (m && mdIndent(ln) <= base + 1) { cur = { lines: [m[3]] }; items.push(cur); j++; continue; }
      if (mdIndent(ln) <= base || !cur) break;
      cur.lines.push(ln.replace(/^ {1,4}/, ""));      // a continuation line of the item above
      j++;
    }
    return { node: { t: ordered ? "ol" : "ul", start: start, items: items.map(function (it) {
      var task = /^\[([ xX])\]\s*([\s\S]*)$/.exec(it.lines[0]);
      var rest = it.lines.slice(1);
      return { task: task ? task[1].toLowerCase() === "x" : null,
        kids: mdInline(task ? task[2] : it.lines[0]),
        blocks: rest.length ? mdBlocks(rest.join("\n")) : [] };
    }) }, next: j };
  }

  function mdBlocks(src) {
    var lines = String(src == null ? "" : src).replace(/\r\n?/g, "\n").split("\n");
    var out = [], i = 0;
    while (i < lines.length) {
      var line = lines[i];
      if (!line.trim()) { i++; continue; }
      var fence = /^\s{0,3}(`{3,}|~{3,})\s*([^\s`]*)\s*$/.exec(line);
      if (fence) {
        var ch = fence[1].charAt(0), want = fence[1].length, body = [];
        i++;
        while (i < lines.length) {
          var close = /^\s{0,3}(`{3,}|~{3,})\s*$/.exec(lines[i]);
          if (close && close[1].charAt(0) === ch && close[1].length >= want) { i++; break; }
          body.push(lines[i]); i++;
        }
        out.push({ t: "code", lang: fence[2] || "", text: body.join("\n") });
        continue;
      }
      var hd = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
      if (hd) { out.push({ t: "h", lvl: hd[1].length, kids: mdInline(hd[2]) }); i++; continue; }
      if (i + 1 < lines.length && /^\s{0,3}(=+|-{2,})\s*$/.test(lines[i + 1])) {
        out.push({ t: "h", lvl: lines[i + 1].trim().charAt(0) === "=" ? 1 : 2, kids: mdInline(line.trim()) });
        i += 2; continue;
      }
      if (mdIsRule(line)) { out.push({ t: "hr" }); i++; continue; }
      if (/^\s{0,3}>/.test(line)) {
        var quote = [];
        while (i < lines.length && (/^\s{0,3}>/.test(lines[i]) || (quote.length && lines[i].trim()))) {
          quote.push(lines[i].replace(/^\s{0,3}>\s?/, "")); i++;
        }
        out.push({ t: "quote", blocks: mdBlocks(quote.join("\n")) });
        continue;
      }
      if (line.indexOf("|") >= 0 && i + 1 < lines.length && /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(lines[i + 1])) {
        var tbl = mdTable(lines, i);
        out.push(tbl.node); i = tbl.next; continue;
      }
      if (mdIsBullet(line)) { var li = mdList(lines, i); out.push(li.node); i = li.next; continue; }
      var para = [];
      while (i < lines.length && lines[i].trim() && !mdIsHeading(lines[i]) && !mdIsFence(lines[i]) && !mdIsBullet(lines[i])
             && !mdIsRule(lines[i]) && !/^\s{0,3}>/.test(lines[i])) {
        para.push(lines[i].trim()); i++;
      }
      if (!para.length) { para.push(lines[i].trim()); i++; }   // never stand still
      out.push({ t: "p", kids: mdInline(para.join(" ")) });
    }
    return out;
  }

  function mdKids(nodes, key) {
    return (nodes || []).map(function (nd, i) {
      var k = key + "." + i;
      switch (nd.t) {
        case "txt": return nd.v;
        case "code": return h("code", { key: k, className: "nhl-md-ic" }, nd.v);
        case "strong": return h("strong", { key: k }, mdKids(nd.kids, k));
        case "em": return h("em", { key: k }, mdKids(nd.kids, k));
        case "del": return h("del", { key: k }, mdKids(nd.kids, k));
        case "link": return h("a", { key: k, className: "nhl-md-a", href: nd.href, target: "_blank", rel: "noopener noreferrer", title: nd.href }, mdKids(nd.kids, k));
        case "img": return h("span", { key: k, className: "nhl-md-img", title: nd.src }, "\u25A3 " + (nd.alt || nd.src));
        default: return null;
      }
    });
  }

  function mdBlocksEl(blocks, key) {
    return (blocks || []).map(function (b, i) {
      var k = key + "." + i;
      switch (b.t) {
        case "h": return h("h" + b.lvl, { key: k, className: "nhl-md-h nhl-md-h" + b.lvl }, mdKids(b.kids, k));
        case "hr": return h("hr", { key: k, className: "nhl-md-hr" });
        case "p": return h("p", { key: k, className: "nhl-md-p" }, mdKids(b.kids, k));
        case "code": return h("pre", { key: k, className: "nhl-md-pre" },
          b.lang ? h("span", { className: "nhl-label nhl-md-lang" }, b.lang) : null, h("code", null, b.text));
        case "quote": return h("blockquote", { key: k, className: "nhl-md-quote" }, mdBlocksEl(b.blocks, k));
        case "table": return h("div", { key: k, className: "nhl-md-tblwrap" }, h("table", { className: "nhl-md-tbl" },
          h("thead", null, h("tr", null, b.head.map(function (c, n) {
            return h("th", { key: n, style: b.align[n] ? { textAlign: b.align[n] } : undefined }, mdKids(c, k + "h" + n));
          }))),
          h("tbody", null, b.rows.map(function (r, n) {
            return h("tr", { key: n }, r.map(function (c, m2) {
              return h("td", { key: m2, style: b.align[m2] ? { textAlign: b.align[m2] } : undefined }, mdKids(c, k + "r" + n + "c" + m2));
            }));
          }))));
        case "ul": case "ol":
          return h(b.t, { key: k, className: "nhl-md-list", start: b.t === "ol" && b.start !== 1 ? b.start : undefined },
            b.items.map(function (it, n) {
              return h("li", { key: n, className: it.task === null ? undefined : "nhl-md-task" + (it.task ? " done" : "") },
                it.task === null ? null : h("span", { className: "nhl-md-box", "aria-hidden": "true" }, it.task ? "\u2713" : ""),
                mdKids(it.kids, k + "i" + n),
                it.blocks && it.blocks.length ? mdBlocksEl(it.blocks, k + "i" + n + "b") : null);
            }));
        default: return null;
      }
    });
  }

  // The formatted view. Nothing in the file is ever interpreted as HTML or script.
  function MarkdownView(props) {
    var text = String(props.text == null ? "" : props.text);
    if (!text.trim()) return h("div", { className: "nhl-md nhl-pressed nhl-md-empty" },
      h("span", { className: "nhl-label" }, "this file is empty \u00b7 switch to source to write in it"));
    var blocks;
    try { blocks = mdBlocks(text); }
    catch (e) {
      return h("div", { className: "nhl-md nhl-pressed" }, h("pre", { className: "nhl-md-pre" }, h("code", null, text)));
    }
    return h("div", { className: "nhl-md nhl-pressed", tabIndex: 0 }, mdBlocksEl(blocks, "md"));
  }

  // ---- API ----------------------------------------------------------------
  function listDir(path) { return SDK.fetchJSON("/api/files?path=" + q(path)); }
  function mkdir(path) {
    return SDK.fetchJSON("/api/files/mkdir", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: path }) });
  }
  function remove(path, recursive) {
    return SDK.fetchJSON("/api/files", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: path, recursive: !!recursive }) });
  }
  function upload(path, blob, name, overwrite) {
    var fd = new FormData();
    fd.append("path", path);
    fd.append("overwrite", String(!!overwrite));
    fd.append("file", blob, name);
    return SDK.fetchJSON("/api/files/upload-stream", { method: "POST", body: fd });
  }
  function download(path, name) {
    var fetcher = SDK.authedFetch || window.fetch;
    return fetcher("/api/files/download?path=" + q(path)).then(function (r) {
      if (!r.ok) throw new Error("download failed (" + r.status + ")");
      return r.blob();
    }).then(function (blob) {
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
    });
  }

  // bytes of a managed file as a blob URL typed by us (the viewers need a MIME type)
  function fetchBlobUrl(path, type) {
    var fetcher = SDK.authedFetch || window.fetch;
    return fetcher("/api/files/download?path=" + q(path)).then(function (r) {
      if (!r.ok) throw new Error(r.status === 404 ? "file not found" : r.status === 413 ? "file is too large to show" : "could not read the file (" + r.status + ")");
      return r.blob();
    }).then(function (b) { return URL.createObjectURL(new Blob([b], { type: type })); });
  }
  function writeText(path, content) {
    return SDK.fetchJSON("/api/fs/write-text", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: path, content: content }) });
  }

  // ---- profile box --------------------------------------------------------
  function ProfileBox(props) {
    var open = useState(false);
    var ref = useRef(null);
    useEffect(function () {
      if (!open[0]) return undefined;
      var close = function (e) { if (ref.current && !ref.current.contains(e.target)) open[1](false); };
      document.addEventListener("mousedown", close);
      return function () { document.removeEventListener("mousedown", close); };
    }, [open[0]]);
    var cur = props.profiles.filter(function (p) { return p.name === props.profile; })[0];
    return h("div", { className: "nhl-pdrop", ref: ref },
      h("button", { type: "button", className: "nhl-pbox nhl-pressed", "aria-haspopup": "menu", "aria-expanded": open[0] ? "true" : "false",
        onClick: function () { open[1](!open[0]); } },
        h("span", null, h("span", { className: "nhl-label" }, "profile"),
          h("span", { className: "nhl-dots nhl-pname" }, (cur && cur.display_name) || (props.profiles.length ? props.profile : "\u00a0"))),   // blank until the names are known: no flash of the raw id
        h("span", { className: "nhl-label" }, "▾")),
      open[0] ? h("div", { className: "nhl-pmenu nhl-raised", role: "menu" }, props.profiles.map(function (p) {
        var on = p.name === props.profile;
        return h("button", { key: p.name, type: "button", role: "menuitem", className: "nhl-popt" + (on ? " on" : ""),
          onClick: function () { open[1](false); if (!on) props.onPick(p.name); } },
          h("i", null), h("span", null, p.display_name || p.name), on ? h("span", { className: "nhl-label" }, "shown") : null);
      })) : null);
  }

  // ---- tree ---------------------------------------------------------------
  function TreeRows(props) {
    var dir = props.dir, entries = props.cache[dir];
    if (!entries) return h("div", { className: "nhl-row nhl-dim", style: { paddingLeft: (14 + props.depth * 16) + "px" } }, "reading …");
    var shown = entries.filter(function (e) { return props.showHidden || e.name.charAt(0) !== "."; });
    if (!shown.length && props.depth === 0) return h("div", { className: "nhl-empty" },
      h("span", null, "This folder is empty."), h("span", { className: "nhl-label" }, "drop files here, or use ＋ / ↑ above"));
    return shown.map(function (e) {
      var isOpen = props.expanded.indexOf(e.path) >= 0;
      var sel = props.selected === e.path;
      return h(SDK.React.Fragment, { key: e.path },
        h("div", { className: "nhl-row" + (sel ? " sel" : "") + (e.is_directory ? " dir" : ""), role: "treeitem",
          "aria-expanded": e.is_directory ? (isOpen ? "true" : "false") : undefined, "aria-selected": sel ? "true" : "false",
          tabIndex: 0, style: { paddingLeft: (10 + props.depth * 16) + "px" }, title: e.path,
          onClick: function () { props.onSelect(e); },
          onKeyDown: function (ev) { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); props.onSelect(e); } } },
          h("span", { className: "nhl-caret" }, e.is_directory ? (isOpen ? "▾" : "▸") : ""),
          h("span", { className: "nhl-kind" }, kind(e)),
          h("span", { className: "nhl-name" }, e.name),
          !e.is_directory ? h("span", { className: "nhl-size" }, size(e.size)) : null),
        e.is_directory && isOpen ? h(TreeRows, Object.assign({}, props, { dir: e.path, depth: props.depth + 1 })) : null);
    });
  }

  // ---- tabs and viewers (round 2) ----------------------------------------
  // (the tab strip itself is drawn generically by Dock, below -- a single window's tabs can now mix
  // files and chats, round 13, so there is no file-only TabBar separate from the chat tab strip any more)

  // The editor is a plain textarea. The text lives in BUF[path] (see above).
  function Editor(props) {
    var path = props.path, n = useState(0);
    var bump = function () { n[1](function (x) { return x + 1; }); };
    useEffect(function () {
      var alive = true;
      if (!BUF[path]) {
        SDK.fetchJSON("/api/fs/read-text?path=" + q(path)).then(function (d) {
          if (!alive) return;
          if (d.binary) {
            BUF[path] = { binary: true };
          } else {
            var raw = d.text || "", crlf = raw.indexOf("\r\n") >= 0, text = crlf ? raw.replace(/\r\n/g, "\n") : raw;
            // never let Save overwrite a file with a partial or lossy copy of it
            var why = d.truncated ? "This file is larger than 512 KB, so it is open read-only (first 512 KB shown)."
              : raw.indexOf("�") >= 0 ? "This file is not plain UTF-8 text, so it is open read-only to avoid damaging it." : null;
            BUF[path] = { orig: raw, base: text, text: text, crlf: crlf, language: d.language || "text", readonly: why,
              mode: isMarkdown(path) && text ? "rendered" : "source" };   // a .md file opens formatted (round 16)
          }
          bump();
        }).catch(function (e) { if (alive) { BUF[path] = { error: errText(e) }; bump(); } });
      }
      // a clean buffer is dropped on the way out, so the next visit reads the file fresh
      return function () { alive = false; if (!isDirty(BUF[path])) delete BUF[path]; };
    }, [path]);

    var b = BUF[path];
    if (!b) return h("div", { className: "nhl-pane-msg nhl-label" }, "opening …");
    if (b.error) return h("div", { className: "nhl-pane-msg" },
      h("div", { className: "nhl-err" }, "✕ " + b.error),
      h("button", { type: "button", className: "nhl-btn nhl-raised-sm", onClick: function () { props.onClose(path); } }, "Close tab"));
    if (b.binary) return props.card(path);
    var dirty = isDirty(b);
    // Round 16: a .md file opens in the formatted view; the two buttons switch between that and the source.
    var md = isMarkdown(path);
    var mdView = b.mode === "source" ? "source" : md ? "rendered" : "source";
    var setView = function (v) { b.mode = v; bump(); };
    return h("div", { className: "nhl-editor" },
      h("div", { className: "nhl-ebar" },
        h("span", { className: "nhl-label nhl-ename", title: path }, rel(props.root, path) + " · " + b.language + (b.crlf ? " · crlf" : "")),
        h("span", { style: { flex: 1 } }),
        md ? h("div", { className: "nhl-seg", role: "group", "aria-label": "Markdown view" },
          h("button", { type: "button", className: "nhl-segb" + (mdView === "rendered" ? " on" : ""), "aria-pressed": mdView === "rendered" ? "true" : "false",
            title: "Read the file as formatted text", onClick: function () { setView("rendered"); } }, "Rendered"),
          h("button", { type: "button", className: "nhl-segb" + (mdView === "source" ? " on" : ""), "aria-pressed": mdView === "source" ? "true" : "false",
            title: "Edit the Markdown source", onClick: function () { setView("source"); } }, "Source")) : null,
        b.readonly ? h("span", { className: "nhl-label nhl-bad" }, "read-only") : null,
        h("span", { className: "nhl-hint" }, dirty ? "unsaved · Ctrl+S" : b.readonly ? "" : "saved"),
        h("button", { type: "button", className: "nhl-btn " + (dirty ? "nhl-primary" : "nhl-raised-sm"), disabled: !dirty || !!b.readonly || props.saving,
          onClick: function () { props.onSave(path); } }, props.saving ? "Saving …" : "Save")),
      b.readonly ? h("div", { className: "nhl-note" }, b.readonly) : null,
      md && mdView === "rendered" ? h(MarkdownView, { key: path, text: b.text })
        : h("textarea", { className: "nhl-ta nhl-pressed", value: b.text, readOnly: !!b.readonly, spellCheck: false,
        wrap: SOFTWRAP[ext(path)] ? "soft" : "off", "aria-label": "Editing " + baseName(path),
        onChange: function (ev) {
          var was = isDirty(b); b.text = ev.target.value;
          if (was !== isDirty(b)) props.onTick();  // only the tab dot needs the page to redraw
          bump();
        } }));
  }

  // images and PDFs: the file's bytes as a blob URL
  function BlobView(props) {
    var url = useState(null), err = useState(null), fit = useState(true), pdf = props.kind === "pdf";
    useEffect(function () {
      var alive = true, made = null;
      fetchBlobUrl(props.path, pdf ? "application/pdf" : IMG_MIME[ext(props.path)] || "application/octet-stream").then(function (u) {
        if (!alive) { URL.revokeObjectURL(u); return; }
        made = u; url[1](u);
      }).catch(function (e) { if (alive) err[1](errText(e)); });
      return function () { alive = false; if (made) URL.revokeObjectURL(made); };
    }, [props.path]);
    var name = baseName(props.path);
    return h("div", { className: "nhl-editor" },
      h("div", { className: "nhl-ebar" },
        h("span", { className: "nhl-label nhl-ename", title: props.path }, rel(props.root, props.path) + " · " + (pdf ? "pdf" : "image")),
        h("span", { style: { flex: 1 } }),
        pdf && url[0] ? h("a", { className: "nhl-btn nhl-raised-sm", href: url[0], target: "_blank", rel: "noopener" }, "Open in new tab") : null,
        h("button", { type: "button", className: "nhl-tbtn nhl-raised-sm", title: "Download this file", "aria-label": "Download", onClick: props.onDownload }, "↓")),
      pdf ? h("div", { className: "nhl-hint nhl-pdfhint" }, "If the page stays blank (some phones cannot show a PDF here), use Open in new tab or the ↓ button.") : null,
      err[0] ? h("div", { className: "nhl-err" }, "✕ " + err[0])
        : !url[0] ? h("div", { className: "nhl-pane-msg nhl-label" }, "opening …")
        : pdf ? h("iframe", { className: "nhl-pdf", src: url[0], title: name })
        : h("div", { className: "nhl-imgwrap nhl-pressed" + (fit[0] ? " fit" : "") },
          h("img", { src: url[0], alt: name, title: fit[0] ? "Click for actual size" : "Click to fit", onClick: function () { fit[1](!fit[0]); } })));
  }

  // Word and Excel (.docx / .xlsx), read-only. The plugin's GET /preview turns the file into plain
  // data (text runs, table cells); it is drawn here with React elements, never as HTML.
  function DocBlocks(props) {
    return props.blocks.map(function (b, i) {
      if (b.t === "tbl") {
        return h("div", { key: i, className: "nhl-dtblwrap" }, h("table", { className: "nhl-dtbl" }, h("tbody", null, b.rows.map(function (r, ri) {
          return h("tr", { key: ri }, r.map(function (c, ci) { return h("td", { key: ci, colSpan: c.s > 1 ? c.s : undefined }, c.x); }));
        }))));
      }
      var runs = b.runs.map(function (r, j) {
        return h("span", { key: j, className: (r.b ? "b " : "") + (r.i ? "i " : "") + (r.u ? "u " : "") + (r.k ? "k" : "") }, r.x);
      });
      var style = b.a ? { textAlign: b.a } : undefined;
      if (b.h) return h("div", { key: i, role: "heading", "aria-level": b.h, className: "nhl-dh nhl-dh" + Math.min(b.h, 4), style: style }, runs);
      if (b.li) {
        return h("div", { key: i, className: "nhl-dli", style: { paddingLeft: (4 + b.li.l * 22) + "px" } },
          h("span", { className: "nhl-dmark", "aria-hidden": "true" }, b.li.o ? b.li.o + "." : "•"), h("span", { className: "nhl-dtext" }, runs));
      }
      return h("div", { key: i, className: "nhl-dp", style: style }, runs);
    });
  }

  function OfficeView(props) {
    var data = useState(null), err = useState(null), sheet = useState(0), xl = props.kind === "xlsx";
    useEffect(function () {
      var alive = true;
      SDK.fetchJSON(API + "/preview?profile=" + q(props.profile || "default") + "&path=" + q(props.path))
        .then(function (d) { if (alive) data[1](d); })
        .catch(function (e) { if (alive) err[1](errText(e)); });
      return function () { alive = false; };
    }, [props.path, props.profile]);

    var d = data[0], sheets = d && d.sheets ? d.sheets : [], s = sheets[Math.min(sheet[0], Math.max(sheets.length - 1, 0))];
    var foot = !d ? "" : xl
      ? "excel · read-only view · " + (s ? s.rows.length + " rows · " + s.ncols + " columns" : "no sheets")
        + (s && s.truncated ? " · first " + s.rows.length + " rows shown" : "") + (s && s.colsTruncated ? " · first 60 columns shown" : "")
      : "word · read-only view · " + d.paragraphs + " paragraphs" + (d.tables ? " · " + d.tables + " tables" : "") + (d.truncated ? " · the rest is not shown" : "");

    var body;
    if (err[0]) {
      body = h("div", { className: "nhl-pane-msg" }, h("div", { className: "nhl-err" }, "✕ " + err[0]),
        h("span", { className: "nhl-hint" }, "You can still download it and open it in Word or Excel."));
    } else if (!d) {
      body = h("div", { className: "nhl-pane-msg nhl-label" }, "opening …");
    } else if (!xl) {
      body = h("div", { className: "nhl-docwrap nhl-pressed" }, d.blocks.length
        ? h("article", { className: "nhl-doc" }, h(DocBlocks, { blocks: d.blocks }))
        : h("div", { className: "nhl-pane-msg nhl-label" }, "this document has no text"));
    } else if (!s || !s.rows.length) {
      body = h("div", { className: "nhl-pane-msg nhl-label" }, s ? "this sheet is empty" : "this workbook has no sheets");
    } else {
      var heads = [];
      for (var c = 1; c <= s.ncols; c++) heads.push(h("th", { key: c, scope: "col" }, colName(c)));
      body = h("div", { className: "nhl-sheetwrap nhl-pressed" }, h("table", { className: "nhl-grid" },
        h("thead", null, h("tr", null, h("th", { className: "nhl-rn" }), heads)),
        h("tbody", null, s.rows.map(function (r) {
          var cells = [];
          for (var i = 0; i < s.ncols; i++) {
            var v = r[1][i];
            cells.push(h("td", { key: i, className: v ? "k-" + v[1] + (v[1] === "n" && v[0].charAt(0) === "-" ? " neg" : "") : "" }, v ? v[0] : ""));
          }
          return h("tr", { key: r[0] }, h("th", { className: "nhl-rn", scope: "row" }, r[0]), cells);
        }))));
    }

    return h("div", { className: "nhl-editor" },
      h("div", { className: "nhl-ebar" },
        h("span", { className: "nhl-label nhl-ename", title: props.path }, rel(props.root, props.path) + " · " + (xl ? "excel" : "word")),
        xl && sheets.length > 1 ? sheets.map(function (sh, i) {
          return h("button", { key: i, type: "button", className: "nhl-chip" + (i === sheet[0] ? " on" : ""), onClick: function () { sheet[1](i); } }, sh.name);
        }) : null,
        xl && sheets.length === 1 ? h("span", { className: "nhl-chip on nhl-chip1" }, sheets[0].name) : null,
        h("span", { style: { flex: 1 } }),
        h("span", { className: "nhl-hint" }, "read-only · ask the AI to change it"),
        h("button", { type: "button", className: "nhl-tbtn nhl-raised-sm", title: "Download this file", "aria-label": "Download", onClick: props.onDownload }, "↓")),
      body,
      d ? h("div", { className: "nhl-label nhl-foot" }, foot) : null);
  }

  // ---- dialogs in the Lock In style (replace the browser's own prompt / confirm boxes) -------------
  // askPrompt / askConfirm return a promise (a text or null / true or false). LockIn shows the box; if
  // none is mounted (it never should be) the browser's own box is used, so nothing is ever lost.
  var DLG = { open: null };
  function askBox(kind, o) {
    return new Promise(function (resolve) {
      if (!DLG.open) { resolve(kind === "prompt" ? window.prompt(o.message, o.value || "") : window.confirm(o.message)); return; }
      DLG.open(Object.assign({ kind: kind, resolve: resolve }, o));
    });
  }
  function askPrompt(o) { return askBox("prompt", o); }
  function askConfirm(o) { return askBox("confirm", o); }

  function Dialog(props) {
    var d = props.d, val = useState(d.value || ""), box = useRef(null), field = useRef(null), prompt = d.kind === "prompt";
    useEffect(function () {
      var el = prompt ? field.current : box.current && box.current.querySelector("[data-ok]");
      if (el) { el.focus(); if (prompt && el.select) el.select(); }
    }, []);
    var ok = function () { props.onDone(prompt ? val[0] : true); };
    var no = function () { props.onDone(prompt ? null : false); };
    var onKey = function (e) {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); no(); }
      else if (e.key === "Enter" && (prompt || e.target.tagName !== "BUTTON")) { e.preventDefault(); e.stopPropagation(); ok(); }
      else if (e.key === "Tab" && box.current) {   // keep the keyboard inside the box
        var f = [].slice.call(box.current.querySelectorAll("input, button")), i = f.indexOf(document.activeElement);
        if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); } else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
      }
    };
    return h("div", { className: "nhl-modalwrap", onMouseDown: function (e) { if (e.target === e.currentTarget) no(); } },
      h("div", { className: "nhl-modal nhl-raised", role: "dialog", "aria-modal": "true", "aria-label": d.title || "Lock In", ref: box, onKeyDown: onKey },
        h("span", { className: "nhl-label" }, d.title || (prompt ? "name" : "confirm")),
        h("div", { className: "nhl-modalmsg" }, d.message),
        prompt ? h("input", { className: "nhl-input nhl-pressed", type: "text", ref: field, value: val[0], spellCheck: false, autoComplete: "off", "aria-label": d.message,
          onChange: function (e) { val[1](e.target.value); } }) : null,
        h("div", { className: "nhl-acts nhl-modalacts" },
          h("button", { type: "button", className: "nhl-btn nhl-raised-sm", "data-cancel": "1", onClick: no }, d.cancelLabel || "Cancel"),
          h("button", { type: "button", className: "nhl-btn " + (d.danger ? "nhl-raised-sm nhl-danger" : "nhl-primary"), "data-ok": "1", onClick: ok }, d.okLabel || "OK"))));
  }

  // ---- the page -----------------------------------------------------------
  // ---- the chat panel (rounds 4 and 5) -------------------------------------------
  // Each chat is Hermes's own Chat page in a frame (its own terminal, started in the profile's
  // folder). A chat tab stays mounted while it is hidden, so switching tabs or hiding the panel
  // does not end a conversation; leaving Lock In and coming back reattaches every chat's
  // terminal (Hermes keeps a terminal alive per "attach" token, and each tab keeps its own).
  //
  // Two settings of the normal Chat page are borrowed for the moment a frame starts its terminal,
  // and put back right after: the folder a fresh chat starts in (localStorage
  // "hermes-chat-workspace:<profile>") and this browser tab's terminal identity (sessionStorage
  // "hermes.pty.token.chat"). The old values are parked under one more key, so a page closed in
  // between cannot make the change stick: the next Lock In start puts them back first.
  // Frames are started one at a time, because both settings are read when a frame connects.
  var TOKEN_KEY = "hermes.pty.token.chat";
  function wsKey(profile) { return "hermes-chat-workspace:" + profile; }
  function parkKey(profile) { return KEY + "prev:" + profile; }
  function restoreChatKeys(profile) {
    try {
      var parked = localStorage.getItem(parkKey(profile));
      if (parked === null) return;
      var p = JSON.parse(parked) || {};
      if (p.ws === null || p.ws === undefined) localStorage.removeItem(wsKey(profile)); else localStorage.setItem(wsKey(profile), p.ws);
      if (p.tok === null || p.tok === undefined) sessionStorage.removeItem(TOKEN_KEY); else sessionStorage.setItem(TOKEN_KEY, p.tok);
      localStorage.removeItem(parkKey(profile));
    } catch (e) { /* storage blocked: nothing was changed either */ }
  }
  function primeChatKeys(profile, folder, token) {
    try {
      restoreChatKeys(profile);
      localStorage.setItem(parkKey(profile), JSON.stringify({ ws: localStorage.getItem(wsKey(profile)), tok: sessionStorage.getItem(TOKEN_KEY) }));
      localStorage.setItem(wsKey(profile), folder);
      sessionStorage.setItem(TOKEN_KEY, token);
    } catch (e) { /* the frame's own override (see top) may still do the folder */ }
  }
  function rid(n) {
    var a = new Uint8Array(n);
    try { crypto.getRandomValues(a); } catch (e) { for (var i = 0; i < n; i++) a[i] = Math.floor(Math.random() * 256); }
    return Array.prototype.map.call(a, function (b) { return (b < 16 ? "0" : "") + b.toString(16); }).join("");
  }
  var MAX_CHATS = 6;
  function newChatTab(seq, sid, title) { return { id: rid(6), token: rid(16), sid: sid || null, title: title || "Chat " + seq }; }
  function ago(t) {
    if (!t) return "";
    var d = Math.max(0, Date.now() / 1000 - t);
    return d < 90 ? "just now" : d < 5400 ? Math.round(d / 60) + " min ago" : d < 129600 ? Math.round(d / 3600) + " h ago" : Math.round(d / 86400) + " days ago";
  }

  // one chat: a frame that starts when it is its turn and takes keys and clicks once its terminal is up
  function ChatFrame(props) {
    var frame = useRef(null), primed = useRef(false), ready = useState(false), shown = useState(false), onUp = props.onUp;
    if (!primed.current) { primed.current = true; primeChatKeys(props.profile, props.root, props.tab.token); }
    // A ref callback must keep the same function identity across renders: React detaches+reattaches
    // (calls it with null, then with the node) whenever the ref prop is a *new* function, even when the
    // underlying DOM element hasn't actually changed. An inline "function (el) {...}" literal is a new
    // function every render, so that detach+reattach cycle used to fire on every re-render of this
    // component (e.g. when the dock's width changes because a file tab opened) and its "frame.current
    // !== el" check — tricked by the detach call's own null-reset — treated every one of those as a
    // brand-new element, re-adding inert unconditionally. The ready/active effect below only clears
    // inert when ready[0] or props.active actually *change value*, so a reapply from a same-value
    // re-render was never undone: once a file was opened the chat frame was stuck inert, unable to take
    // keyboard focus, for the rest of that session. Keeping one stable ref function (created once, via
    // useRef) means React only calls it on a genuine mount/unmount of the iframe element.
    var setFrame = useRef(function (el) {
      if (el && frame.current !== el) { frame.current = el; el.setAttribute("inert", ""); }
      else if (!el) frame.current = null;
    }).current;
    useEffect(function () {
      var n = 0, t = setInterval(function () {
        n++;
        var up = false;
        try { var r = frame.current && frame.current.contentDocument.querySelector(".xterm-rows"); up = !!r && r.textContent.length > 20; } catch (e) { /* not loaded yet */ }
        if (up || n > 80) { clearInterval(t); restoreChatKeys(props.profile); ready[1](true); onUp(props.tab.id); }
      }, 500);
      return function () { clearInterval(t); restoreChatKeys(props.profile); };
    }, []);
    // While the frame loads, Hermes shows its own dashboard (green, with menu); then the terminal starts and, for a few
    // seconds before the skin arrives, prints Hermes's own big default logo ("HERMES-AGENT" in block letters). The frame
    // stays veiled behind a "Starting chat…" cover until it is dressed: the embed rules and the theme's variables are on,
    // the terminal has text, and no default logo has been on screen for 0.5 s (or 10 s have passed: then it is shown
    // whatever state it is in, so a chat can never stay hidden).
    useEffect(function () {
      var n = 0, firstText = 0, lastLogo = 0, t = setInterval(function () {
        n++;
        var ok = false, now = Date.now();
        try {
          var d = frame.current.contentDocument, w = frame.current.contentWindow, rows = d.querySelector(".xterm-rows");
          var txt = rows ? rows.textContent : "";
          if (txt.length > 20 && !firstText) firstText = now;
          if (/█{2}/.test(txt)) lastLogo = now;
          ok = d.documentElement.classList.contains("nhl-embed") && !!rows && txt.length > 20 &&
            !!w.getComputedStyle(d.documentElement).getPropertyValue("--neu-violet").trim() &&
            now - Math.max(firstText, lastLogo) >= 500;
        } catch (e) { /* not loaded yet */ }
        if (ok || n > 125) { clearInterval(t); shown[1](true); if (props.onShown) props.onShown(props.tab.id); }
      }, 80);
      return function () { clearInterval(t); };
    }, []);
    // Hermes's Chat page pulls keyboard focus into its terminal when it mounts: while a chat is starting,
    // or hidden, its frame is inert, so that cannot take the keys of someone typing in an editor tab.
    useEffect(function () {
      var el = frame.current;
      if (!el) return;
      if (ready[0] && props.active) el.removeAttribute("inert"); else el.setAttribute("inert", "");
    }, [ready[0], props.active]);
    var src = "/chat?profile=" + q(props.profile) + "&nhembed=1&nhcwd=" + q(props.root) + (props.tab.sid ? "&resume=" + q(props.tab.sid) : "");
    return h(SDK.React.Fragment, null,
      h("iframe", { ref: setFrame,
        className: "nhl-chatframe" + (props.active ? "" : " off") + (props.spare ? " spare" : "") + (shown[0] ? "" : " veil"), src: src, title: props.tab.title, allow: "clipboard-read; clipboard-write" }),
      !shown[0] && props.active ? h(ChatWait, null) : null);
  }

  // the cover over a chat that is still starting: after a few seconds it counts them, so a slow start looks like work, not a hang
  function ChatWait() {
    var secs = useState(0);
    useEffect(function () { var t0 = Date.now(), t = setInterval(function () { secs[1](Math.floor((Date.now() - t0) / 1000)); }, 1000); return function () { clearInterval(t); }; }, []);
    return h("div", { className: "nhl-chatwait" }, "Starting chat…" + (secs[0] >= 3 ? " " + secs[0] + " s" : ""));
  }

  // The "Chats" side of the left column (round 6): the profile's conversations, newest first, that can be
  // sorted into folders. Hermes keeps the conversations (GET /api/sessions); the folders and which chat sits in
  // which folder are kept by this plugin on the server (GET/PUT /chatorg), so every browser sees the same sorting.
  // Clicking a chat opens it, resumed, in a chat tab.
  function chatLabel(s) {
    var t = (s.title || "").trim();
    if (t && t !== "Untitled") return t;
    return (s.preview || "").trim() || "Untitled chat";
  }
  function ChatList(props) {
    var list = useState(null), total = useState(0), err = useState(null), tick = useState(0), more = useState(false);
    var menu = useState(null), over = useState(null);
    var org = props.org, assign = org.assign || {};
    useEffect(function () { list[1](null); total[1](0); err[1](null); }, [props.profile]);
    useEffect(function () {
      var alive = true;
      SDK.fetchJSON("/api/sessions?limit=100&offset=0&order=recent&exclude_sources=cron&profile=" + q(props.profile)).then(function (d) {
        if (!alive) return;
        err[1](null); list[1]((d && d.sessions) || []); total[1]((d && d.total) || 0);
      }).catch(function (e) { if (alive) err[1](errText(e)); });
      return function () { alive = false; };
    }, [props.profile, tick[0]]);
    // new conversations show up on their own
    useEffect(function () {
      var t = setInterval(function () { if (!document.hidden) tick[1](function (x) { return x + 1; }); }, 20000);
      return function () { clearInterval(t); };
    }, []);
    // a menu or a drop highlight must not stay open when the click lands elsewhere
    useEffect(function () {
      if (!menu[0]) return undefined;
      var close = function (e) {
        if (e.type === "keydown") { if (e.key === "Escape") menu[1](null); return; }
        if (e.target.closest && e.target.closest(".nhl-movemenu, .nhl-movebtn")) return;
        menu[1](null);
      };
      document.addEventListener("mousedown", close); document.addEventListener("keydown", close);
      return function () { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", close); };
    }, [!!menu[0]]);
    var showMore = function () {
      if (!list[0] || more[0]) return;
      more[1](true);
      SDK.fetchJSON("/api/sessions?limit=100&offset=" + list[0].length + "&order=recent&exclude_sources=cron&profile=" + q(props.profile)).then(function (d) {
        var have = {}; list[0].forEach(function (x) { have[x.id] = true; });
        list[1](list[0].concat(((d && d.sessions) || []).filter(function (x) { return !have[x.id]; })));
        more[1](false);
      }).catch(function (e) { more[1](false); err[1](errText(e)); });
    };
    var open = {};
    props.tabs.forEach(function (t) { if (t.sid) open[t.sid] = true; });
    var move = function (sid, fid) {
      props.onOrg(function (o) {
        var a = Object.assign({}, o.assign || {});
        if (fid) a[sid] = fid; else delete a[sid];
        return { folders: o.folders, assign: a };
      });
      menu[1](null);
    };
    var folderIds = {}; org.folders.forEach(function (f) { folderIds[f.id] = true; });
    var chatsIn = function (fid) { return (list[0] || []).filter(function (x) { return (folderIds[assign[x.id]] ? assign[x.id] : null) === fid; }); };
    var row = function (x, indent) {
      var cur = folderIds[assign[x.id]] ? assign[x.id] : null;
      return h("div", { key: x.id, className: "nhl-row nhl-chatrow" + (open[x.id] ? " open" : ""), role: "treeitem", tabIndex: 0, draggable: true, title: chatLabel(x),
        style: indent ? { paddingLeft: 26 } : null,
        onDragStart: function (e) { try { e.dataTransfer.setData("text/x-nhl-chat", x.id); e.dataTransfer.effectAllowed = "move"; } catch (er) { /* no drag data */ } },
        onClick: function () { props.onOpen(x.id, chatLabel(x)); },
        onKeyDown: function (e) { if (e.key === "Enter") props.onOpen(x.id, chatLabel(x)); } },
        h("span", { className: "nhl-name" }, chatLabel(x)),
        open[x.id] ? h("i", { className: "nhl-dot nhl-opendot", title: "open in a chat tab" }) : null,
        h("span", { className: "nhl-size" }, ago(x.last_active || x.started_at)),
        h("button", { type: "button", className: "nhl-movebtn", title: "Move to a folder", "aria-label": "Move " + chatLabel(x),
          onClick: function (e) { e.stopPropagation(); menu[1](menu[0] === x.id ? null : x.id); } }, "⇢"),
        menu[0] === x.id ? h("div", { className: "nhl-movemenu nhl-raised", role: "menu", onClick: function (e) { e.stopPropagation(); } },
          h("span", { className: "nhl-label" }, "move to"),
          h("button", { type: "button", role: "menuitem", className: "nhl-moveopt" + (!cur ? " on" : ""), onClick: function () { move(x.id, null); } }, "no folder"),
          org.folders.map(function (f) { return h("button", { key: f.id, type: "button", role: "menuitem", className: "nhl-moveopt" + (cur === f.id ? " on" : ""), onClick: function () { move(x.id, f.id); } }, f.name); }),
          h("button", { type: "button", role: "menuitem", className: "nhl-moveopt nhl-primary-ink", onClick: function () { menu[1](null); props.onNewFolder(x.id); } }, "＋ new folder …")) : null);
    };
    var drop = function (fid) {
      return {
        onDragOver: function (e) { if ([].indexOf.call((e.dataTransfer && e.dataTransfer.types) || [], "text/x-nhl-chat") >= 0) { e.preventDefault(); if (over[0] !== (fid || "-")) over[1](fid || "-"); } },
        onDragLeave: function () { over[1](null); },
        onDrop: function (e) {
          var sid = ""; try { sid = e.dataTransfer.getData("text/x-nhl-chat"); } catch (er) { /* none */ }
          over[1](null);
          if (sid) { e.preventDefault(); move(sid, fid); }
        }
      };
    };
    var rows = [];
    org.folders.forEach(function (f) {
      var inside = chatsIn(f.id), shut = !!props.collapsed[f.id];
      rows.push(h("div", Object.assign({ key: "f" + f.id, className: "nhl-row dir nhl-chfolder" + (props.sel === f.id ? " sel" : "") + (over[0] === f.id ? " over" : ""), role: "treeitem", "aria-expanded": shut ? "false" : "true",
        tabIndex: 0, title: f.name, "data-folder": f.id,
        onClick: function () { props.onSel(f.id); props.onCollapse(f.id); },
        onKeyDown: function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); props.onSel(f.id); props.onCollapse(f.id); } } }, drop(f.id)),
        h("span", { className: "nhl-caret" }, shut ? "▸" : "▾"),
        h("span", { className: "nhl-name" }, f.name),
        h("span", { className: "nhl-size" }, String(inside.length))));
      if (!shut) inside.forEach(function (x) { rows.push(row(x, true)); });
    });
    var loose = chatsIn(null);
    if (org.folders.length) rows.push(h("div", Object.assign({ key: "none", className: "nhl-sect" + (over[0] === "-" ? " over" : "") }, drop(null)), h("span", { className: "nhl-label" }, "no folder · " + loose.length)));
    loose.forEach(function (x) { rows.push(row(x, false)); });
    var sel = props.sel && folderIds[props.sel] ? props.sel : null;
    return h("div", { className: "nhl-chatside" },
      h("div", { className: "nhl-tools" },
        h("button", { type: "button", className: "nhl-tbtn nhl-raised-sm nhl-primary-ink", title: "Start a new chat (in a new tab)", "aria-label": "Start a new chat", onClick: props.onNew }, "＋"),
        h("button", { type: "button", className: "nhl-tbtn nhl-raised-sm", title: "New folder for chats", "aria-label": "New chat folder", onClick: function () { props.onNewFolder(null); } }, "▤"),
        h("button", { type: "button", className: "nhl-tbtn nhl-raised-sm", title: "Rename the selected folder", "aria-label": "Rename chat folder", disabled: !sel, onClick: function () { props.onRename(sel); } }, "✎"),
        h("button", { type: "button", className: "nhl-tbtn nhl-raised-sm nhl-danger", title: "Delete the selected folder (its chats are kept)", "aria-label": "Delete chat folder", disabled: !sel, onClick: function () { props.onDelete(sel); } }, "✕"),
        h("span", { style: { flex: 1 } }),
        h("button", { type: "button", className: "nhl-tbtn nhl-raised-sm", title: "Refresh", "aria-label": "Refresh chats", onClick: function () { tick[1](tick[0] + 1); } }, "⟳")),
      h("div", { className: "nhl-rows" },
        err[0] ? h("div", { className: "nhl-err" }, err[0])
          : !list[0] ? h("div", { className: "nhl-row nhl-dim" }, "loading …")
          : !list[0].length && !org.folders.length ? h("div", { className: "nhl-empty" }, h("span", null, "No chats yet in " + props.display + "."), h("span", { className: "nhl-hint" }, "Start one with ＋ — it shows up here after its first message."))
          : rows,
        list[0] && total[0] > list[0].length ? h("button", { type: "button", className: "nhl-btn nhl-raised-sm nhl-more", disabled: more[0], onClick: showMore }, more[0] ? "loading …" : "show older chats (" + (total[0] - list[0].length) + ")") : null));
  }

  // One window (round 13): a tab strip that can mix open files and open chats, and the content for
  // whichever tab is active. This replaces the old file-only "stage" and the chat-only ChatDock with a
  // single component, so a file and a chat can share one window, tabs can be dragged between windows, and
  // "+ window" can make as many windows as wanted -- not just a fixed file area plus up to two chats.
  function Dock(props) {
    var d = props.dock;
    var strip = useRef(null), over = useState(false);
    var act = d.items.filter(function (it) { return it.key === d.activeId; })[0] || d.items[0] || null;
    // keep the active tab in view when there are more tabs than room
    useEffect(function () {
      try { var on = strip.current && strip.current.querySelector(".nhl-ctab.on"); if (on) on.scrollIntoView({ inline: "nearest", block: "nearest" }); } catch (e) { /* older browser */ }
    }, [d.activeId, d.items.length]);
    // drag & drop (round 13): a file or chat tab, picked up here, can be dropped onto any window's tab strip
    var onTabDragStart = function (it) {
      return function (e) { try { e.dataTransfer.setData("text/x-nhl-tab", JSON.stringify({ dock: d.id, kind: it.kind, key: it.key })); e.dataTransfer.effectAllowed = "move"; } catch (er) { /* no drag data */ } };
    };
    var acceptsDrag = function (e) { return [].indexOf.call((e.dataTransfer && e.dataTransfer.types) || [], "text/x-nhl-tab") >= 0; };
    var onStripDragOver = function (e) { if (acceptsDrag(e)) { e.preventDefault(); if (!over[0]) over[1](true); } };
    var onStripDrop = function (e) {
      if (!acceptsDrag(e)) return;
      e.preventDefault(); over[1](false);
      var raw = ""; try { raw = e.dataTransfer.getData("text/x-nhl-tab"); } catch (er) { /* none */ }
      var payload = null; try { payload = JSON.parse(raw); } catch (er) { /* none */ }
      if (payload) props.onDropItem(payload, d.id);
    };
    var names = {};
    d.items.forEach(function (it) { if (it.kind === "file") { var n = baseName(it.key); names[n] = (names[n] || 0) + 1; } });
    var tabNode = function (it) {
      var on = act && it.key === act.key, isFile = it.kind === "file";
      var dirty = isFile && isDirty(BUF[it.key]);
      var n = isFile ? baseName(it.key) : it.title;
      var label = isFile && names[n] > 1 ? baseName(parentOf(it.key)) + "/" + n : n;
      var title = isFile ? rel(props.root, it.key) : it.title;
      return h("span", { key: it.kind + ":" + it.key, className: "nhl-ctab" + (on ? " on" : ""), role: "tab", "aria-selected": on ? "true" : "false",
        draggable: true, onDragStart: onTabDragStart(it) },
        h("button", { type: "button", className: "nhl-ctabname", title: title, onClick: function () { props.onPick(it.key); } },
          dirty ? h("i", { className: "nhl-udot", title: "unsaved changes", "aria-label": "unsaved changes" }) : null, label),
        h("button", { type: "button", className: "nhl-ctabx", title: isFile ? "Close" : "Close this chat tab (the conversation stays in History)",
          "aria-label": "Close " + n, onClick: function () { props.onCloseItem(it.kind, it.key); } }, "×"));
    };
    return h("section", { className: "nhl-dock nhl-raised" + (props.fill ? " fill" : ""), style: props.fill ? null : { width: d.w + "px" }, hidden: !props.visible },
      h("div", { className: "nhl-dockbar", title: props.root ? "in " + props.root : "" },
        h("div", { className: "nhl-ctabs" + (over[0] ? " over" : ""), role: "tablist", "aria-label": "Open tabs", ref: strip,
          onDragOver: onStripDragOver, onDragLeave: function () { over[1](false); }, onDrop: onStripDrop }, d.items.map(tabNode)),
        h("button", { type: "button", className: "nhl-tbtn nhl-raised-sm nhl-newchat", title: "New chat in this window", "aria-label": "New chat", onClick: props.onNewChat }, "＋"),
        props.canLeft ? h("button", { type: "button", className: "nhl-tbtn nhl-raised-sm", title: "Move this window left", "aria-label": "Move window left", onClick: function () { props.onReorder(-1); } }, "◂") : null,
        props.canRight ? h("button", { type: "button", className: "nhl-tbtn nhl-raised-sm", title: "Move this window right", "aria-label": "Move window right", onClick: function () { props.onReorder(1); } }, "▸") : null,
        !props.primary ? h("button", { type: "button", className: "nhl-tbtn nhl-raised-sm", title: d.items.length ? "Hide this window (its tabs are kept)" : "Remove this window", "aria-label": "Close window", onClick: props.onCloseWindow }, "×") : null),
      h("div", { className: "nhl-frames" + (over[0] ? " over" : ""), onDragOver: onStripDragOver, onDragLeave: function () { over[1](false); },
          // this element's own on-screen rect is all a window contributes to its chats any more (round 13,
          // see the floating frames below LockIn's own return): the actual <iframe> is rendered once, at
          // the top of the whole app, and just overlaid here, so dragging a chat to a different window
          // never has to recreate (and so never has to reconnect) its frame
          onDrop: onStripDrop, ref: function (el) { props.registerFrameEl(d.id, el); } },
        !d.items.length ? h("div", { className: "nhl-pane-msg" },
          h("span", { className: "nhl-label" }, props.primary ? "your files live in " + (props.root || "…") : "nothing open in this window"),
          h("button", { type: "button", className: "nhl-btn nhl-primary", onClick: props.onNewChat }, "New chat"),
          h("span", { className: "nhl-hint" }, props.primary ? "click a file on the left, or drag a tab here" : "or drag a file or chat tab in from another window")) : null,
        act && act.kind === "file" ? h("div", { className: "nhl-pane nhl-abs" }, props.fileContent(act.key)) : null),
      props.dragging ? h("div", { className: "nhl-dockshield" }) : null);
  }

  function LockIn() {
    var profileS = useState(urlProfile());
    var profiles = useState([]);
    var folder = useState(null), ferr = useState(null);
    var cache = useState({}), expanded = useState([]), selected = useState(null);
    var busy = useState(null), msg = useState(null), drag = useState(false);
    var showHidden = useState(false);
    // windows (round 13): "d0" is the always-present files window; any other window can hold files, chats,
    // or a mix of both, in whatever order the person drags them into. Each window is
    // { id, open, items:[{kind:'file',key,title}|{kind:'chat',key,id,token,sid,title}], activeId, w, seq, spare }.
    // "open" only matters for a window other than d0: d0 instead hides itself automatically once it is
    // empty and some other window is open, the same way the old file "stage" used to give way to chat.
    var docks = useState([]);
    var draggingId = useState(null);   // the id of the window currently being resized by its divider, if any
    var focusedDock = useRef("d0");    // which window Ctrl/Cmd+S should save in -- the one last clicked into
    // chat frames (round 13): every chat <iframe> is now mounted exactly once, here, for as long as its
    // tab exists anywhere -- not once per window it ever sits in. Earlier, each window mounted its own
    // ChatFrame, so dragging a chat tab into a different window (a different window = a different parent
    // in the component tree) unmounted the old one and mounted a fresh one, forcing a several-second
    // reconnect even though nothing about the chat itself had changed. A window now only measures and
    // reports the on-screen rectangle it wants its active chat to appear in (registerFrameEl, below); the
    // frames themselves float on top of the whole app, each one simply repositioned to match its current
    // window's rectangle, so moving a chat between windows is just a CSS move, not a re-mount.
    var frameMounted = useState([]);    // chat/spare ids ever told to mount, for the life of this page
    var frameStarting = useState({});   // dock id -> the one chat/spare id that window is currently booting
    var frameShown = useState([]);      // chat/spare ids whose frame has fully shown at least once
    var frameRects = useState({});      // dock id -> {left, top, width, height} of its window's content area
    var frameEls = useRef({});          // dock id -> that DOM node (not state: read synchronously, never rendered from)
    var dlg = useState(null);
    var side = useState("files"), org = useState({ folders: [], assign: {} }), cx = useState({ collapsed: {}, sel: null });
    var leftOpen = useState(true);   // round 13: the left sidebar can be collapsed to a thin rail
    var tick = useState(0), saving = useState(false);
    var m = useState(mode());
    var fileInput = useRef(null);
    var loaded = useRef(null);   // the profile whose saved state is in the fields above (guards saving)
    var saveRef = useRef(null);
    var mainRef = useRef(null);
    var profile = profileS[0];

    // which profile: ?profile=…, else the dashboard's active one
    useEffect(function () {
      SDK.fetchJSON("/api/profiles").then(function (d) { profiles[1]((d && d.profiles) || []); }).catch(function () {});
      if (!profile) SDK.fetchJSON("/api/profiles/active").then(function (d) { profileS[1]((d && (d.active || d.current)) || "default"); })
        .catch(function () { profileS[1]("default"); });
      var mo = new MutationObserver(function () { m[1](mode()); });
      mo.observe(document.head, { childList: true, subtree: true, characterData: true });
      mo.observe(document.documentElement, { attributes: true });
      document.documentElement.classList.add("nh-lockin-open");
      return function () { mo.disconnect(); document.documentElement.classList.remove("nh-lockin-open"); };
    }, []);

    // the profile's folder, then the saved state for it
    useEffect(function () {
      if (!profile) return undefined;
      var alive = true;
      loaded.current = null;
      folder[1](null); ferr[1](null); cache[1]({}); selected[1](null); side[1]("files"); cx[1]({ collapsed: {}, sel: null }); org[1]({ folders: [], assign: {} }); docks[1]([]);
      SDK.fetchJSON(API + "/folder?profile=" + q(profile)).then(function (d) {
        if (!alive) return;
        var st = loadState(profile);
        expanded[1]((st.expanded || []).filter(function (p) { return p.indexOf(d.path) === 0; }));
        selected[1](st.selected && st.selected.indexOf(d.path) === 0 ? st.selected : null);
        side[1](st.side === "chats" ? "chats" : "files");
        leftOpen[1](st.leftOpen !== false);
        cx[1]({ collapsed: st.cx && st.cx.collapsed && typeof st.cx.collapsed === "object" ? st.cx.collapsed : {}, sel: null });

        var parseChatItems = function (arr) {
          return (Array.isArray(arr) ? arr : []).filter(function (t) { return t && typeof t.id === "string" && typeof t.token === "string"; }).slice(0, MAX_CHATS)
            .map(function (t) { return { kind: "chat", key: t.id, id: t.id, token: t.token, sid: typeof t.sid === "string" ? t.sid : null, title: typeof t.title === "string" && t.title ? t.title.slice(0, 80) : "Chat" }; });
        };
        var parseSpare = function (s) { return s && typeof s.id === "string" && typeof s.token === "string" ? { id: s.id, token: s.token } : null; };
        var built;   // the windows this profile opens with, before any lost chat terminals are reclaimed
        if (Array.isArray(st.docks) && st.docks.length) {
          // the current save format (round 13): each window keeps its own mixed file/chat tabs
          built = st.docks.filter(function (w) { return w && typeof w.id === "string"; }).map(function (w) {
            var items = (Array.isArray(w.items) ? w.items : []).map(function (it) {
              if (it && it.kind === "file" && typeof it.key === "string" && it.key.indexOf(d.path + "/") === 0) return { kind: "file", key: it.key, title: baseName(it.key) };
              if (it && it.kind === "chat" && typeof it.id === "string" && typeof it.token === "string") return { kind: "chat", key: it.id, id: it.id, token: it.token, sid: typeof it.sid === "string" ? it.sid : null, title: typeof it.title === "string" && it.title ? it.title.slice(0, 80) : "Chat" };
              return null;
            }).filter(Boolean);
            var activeId = items.some(function (it) { return it.key === w.activeId; }) ? w.activeId : (items[0] ? items[0].key : null);
            return { id: w.id, open: w.id === "d0" ? true : !!w.open, items: items, activeId: activeId, w: w.w >= 280 ? Math.min(w.w, 1400) : 440, seq: typeof w.seq === "number" ? w.seq : 0, spare: parseSpare(w.spare) };
          });
          if (!built.some(function (w) { return w.id === "d0"; })) built.unshift({ id: "d0", open: true, items: [], activeId: null, w: 440, seq: 0, spare: null });
        } else {
          // migrating a save from before round 13: one files window, plus up to two chat windows
          var tb = (st.tabs || []).filter(function (p) { return typeof p === "string" && p.indexOf(d.path + "/") === 0; });
          var d0 = { id: "d0", open: true, items: tb.map(function (p) { return { kind: "file", key: p, title: baseName(p) }; }),
            activeId: tb.indexOf(st.active) >= 0 ? st.active : (tb[0] || null), w: 440, seq: 0, spare: null };
          var sc = st.chat || {};
          var ctabs = Array.isArray(sc.tabs) ? parseChatItems(sc.tabs) : null;
          if (ctabs === null) { var t0 = newChatTab(1); ctabs = [{ kind: "chat", key: t0.id, id: t0.id, token: t0.token, sid: null, title: t0.title }]; }   // first start of this profile: one fresh chat
          var d1 = { id: "d1", open: sc.open !== false, items: ctabs, activeId: ctabs.some(function (it) { return it.key === sc.active; }) ? sc.active : (ctabs[0] ? ctabs[0].key : null),
            w: sc.w >= 280 ? Math.min(sc.w, 1400) : 440, seq: typeof sc.seq === "number" ? sc.seq : ctabs.length, spare: parseSpare(sc.spare) };
          var sc2 = st.chat2 || {};
          var ctabs2 = parseChatItems(sc2.tabs);
          built = [d0, d1];
          if (ctabs2.length || sc2.open) {
            built.push({ id: "d2", open: !!sc2.open, items: ctabs2, activeId: ctabs2.some(function (it) { return it.key === sc2.active; }) ? sc2.active : (ctabs2[0] ? ctabs2[0].key : null),
              w: sc2.w >= 280 ? Math.min(sc2.w, 1400) : 440, seq: typeof sc2.seq === "number" ? sc2.seq : ctabs2.length, spare: parseSpare(sc2.spare) });
          }
        }
        var ready = function (list) {
          docks[1](list);
          loaded.current = profile;
          folder[1](d);   // last: the page treats the folder as "state is ready"
        };
        // a chat tab whose terminal the janitor closed (nobody was viewing it) continues its conversation
        // (one claim call covers every window's lost tabs together)
        var lost = [];
        built.forEach(function (w) { w.items.forEach(function (it) { if (it.kind === "chat" && !it.sid) lost.push(it.token); }); if (w.spare) lost.push(w.spare.token); });
        if (!lost.length) ready(built);
        else {
          SDK.fetchJSON(API + "/terminals/claim", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tokens: lost }) })
            .then(function (r) { return (r && r.sids) || {}; }, function () { return {}; })
            .then(function (sids) {
              if (!alive) return;
              ready(built.map(function (w) { return Object.assign({}, w, { items: w.items.map(function (it) { return it.kind === "chat" && !it.sid && sids[it.token] ? Object.assign({}, it, { sid: sids[it.token] }) : it; }) }); }));
            });
        }
        if (d.created) msg[1]("created " + d.path);
      }).catch(function (e) { if (alive) ferr[1](errText(e)); });
      return function () { alive = false; };
    }, [profile]);

    // the Lock In-style question box (see askPrompt / askConfirm): one at a time
    useEffect(function () {
      DLG.open = function (d) {
        dlg[1](function (cur) { if (cur) cur.resolve(cur.kind === "prompt" ? null : false); return d; });
      };
      return function () { DLG.open = null; };
    }, []);

    // the profile's chat folders (kept on the server, so every browser sees the same sorting)
    var orgFor = useRef(null);
    useEffect(function () {
      if (!profile) return undefined;
      var alive = true;
      orgFor.current = null;
      SDK.fetchJSON(API + "/chatorg?profile=" + q(profile)).then(function (d) {
        if (!alive) return;
        org[1]({ folders: Array.isArray(d.folders) ? d.folders : [], assign: d.assign && typeof d.assign === "object" ? d.assign : {} });
        orgFor.current = profile;
      }).catch(function (e) { if (alive) msg[1]("✕ chat folders: " + errText(e)); });
      return function () { alive = false; };
    }, [profile]);

    // load every open directory that is not cached yet
    var root = folder[0] && folder[0].path;
    var openDirs = root ? [root].concat(expanded[0]) : [];
    useEffect(function () {
      openDirs.forEach(function (d) {
        if (cache[0][d] !== undefined) return;
        listDir(d).then(function (r) {
          cache[1](function (c) { var n = Object.assign({}, c); n[d] = r.entries || []; return n; });
        }).catch(function (e) {
          if (d === root) ferr[1](errText(e));
          expanded[1](function (x) { return x.filter(function (p) { return p !== d; }); });
        });
      });
    }, [root, expanded[0].join("|"), Object.keys(cache[0]).length]);

    // one spare chat per window is kept ready (round 9, generalized to every window in round 13): made
    // here, started and hidden by the window, taken over by "New chat" -- but only once a window actually
    // holds a conversation already; an empty extra window (or a files-only one) warms no terminal at all
    useEffect(function () {
      if (!profile || !root || loaded.current !== profile) return;
      docks[1](function (list) {
        var changed = false;
        var next = list.map(function (d) {
          var chatCount = d.items.filter(function (it) { return it.kind === "chat"; }).length;
          if (!d.spare && chatCount >= 1 && chatCount < MAX_CHATS) { changed = true; return Object.assign({}, d, { spare: { id: rid(6), token: rid(16) } }); }
          return d;
        });
        return changed ? next : list;
      });
    }, [profile, root, docks[0].map(function (d) { return d.id + ":" + d.items.filter(function (it) { return it.kind === "chat"; }).length + ":" + (d.spare ? 1 : 0); }).join("|")]);

    // start each window's active chat, one at a time per window (round 13: this used to live inside Dock
    // itself, one copy of this logic per window; lifted here and keyed by chat id instead of by window, so
    // a chat already mounted elsewhere is recognised as already mounted instead of started over again)
    useEffect(function () {
      if (!root) return;
      docks[0].forEach(function (d) {
        var act = d.items.filter(function (it) { return it.key === d.activeId; })[0] || d.items[0] || null;
        var actChatId = act && act.kind === "chat" ? act.key : null;
        if (!actChatId) return;
        var st = frameStarting[0][d.id];
        // (a spare that is starting never holds a chat the person asked for back)
        if ((st && !(d.spare && st === d.spare.id)) || frameMounted[0].indexOf(actChatId) >= 0) return;
        frameMounted[1](function (arr) { return arr.indexOf(actChatId) >= 0 ? arr : arr.concat([actChatId]); });
        frameStarting[1](function (map) { var n = Object.assign({}, map); n[d.id] = actChatId; return n; });
      });
    }, [root, docks[0], frameStarting[0], frameMounted[0].length]);
    // the spare starts last: only once the chat on show is on screen, so two terminals never boot at the same time
    // (booting two together made the chat the person is waiting for slower)
    useEffect(function () {
      if (!root) return;
      docks[0].forEach(function (d) {
        if (!d.spare || frameStarting[0][d.id] || frameMounted[0].indexOf(d.spare.id) >= 0) return;
        var act = d.items.filter(function (it) { return it.key === d.activeId; })[0] || d.items[0] || null;
        var actChatId = act && act.kind === "chat" ? act.key : null;
        if (actChatId && frameShown[0].indexOf(actChatId) < 0) return;
        var sid = d.spare.id;
        frameMounted[1](function (arr) { return arr.indexOf(sid) >= 0 ? arr : arr.concat([sid]); });
        frameStarting[1](function (map) { var n = Object.assign({}, map); n[d.id] = sid; return n; });
      });
    }, [root, docks[0], frameStarting[0], frameMounted[0].length, frameShown[0].length]);
    // a chat (or spare) closed, or dragged out, while it was still starting must not keep its window
    // waiting forever for a turn that chat no longer has
    useEffect(function () {
      var next = Object.assign({}, frameStarting[0]), changed = false;
      Object.keys(next).forEach(function (dockId) {
        var dd = docks[0].filter(function (x) { return x.id === dockId; })[0];
        var id = next[dockId];
        var stillThere = dd && (dd.items.some(function (it) { return it.kind === "chat" && it.key === id; }) || (dd.spare && dd.spare.id === id));
        if (!stillThere) { delete next[dockId]; changed = true; }
      });
      if (changed) frameStarting[1](next);
    }, [docks[0]]);

    // remember where we are, per profile
    // (not while a different profile's state is still on screen: that would copy it into this profile's slot)
    useEffect(function () {
      if (profile && root && loaded.current === profile) {
        saveState(profile, { expanded: expanded[0], selected: selected[0], side: side[0], leftOpen: leftOpen[0], cx: { collapsed: cx[0].collapsed },
          docks: docks[0].map(function (d) {
            return { id: d.id, open: d.open, activeId: d.activeId, w: d.w, seq: d.seq, spare: d.spare,
              items: d.items.map(function (it) { return it.kind === "file" ? { kind: "file", key: it.key } : { kind: "chat", id: it.id, token: it.token, sid: it.sid, title: it.title }; }) };
          }) });
      }
    }, [profile, root, side[0], leftOpen[0], JSON.stringify(cx[0].collapsed), expanded[0].join("|"), selected[0],
      docks[0].map(function (d) { return d.id + "|" + d.open + "|" + d.activeId + "|" + d.w + "|" + (d.spare || {}).id + "|" + d.items.map(function (it) { return it.kind + ":" + it.key + ":" + (it.sid || "") + ":" + (it.title || ""); }).join(","); }).join("~")]);

    var refresh = function (dirs) {
      cache[1](function (c) { var n = Object.assign({}, c); (dirs || Object.keys(n)).forEach(function (d) { delete n[d]; }); return n; });
    };

    // the folder new files and uploads go into: the selected folder, the selected file's folder, or the root
    var entryOf = function (p) {
      var dir = parentOf(p), list = cache[0][dir] || [];
      return list.filter(function (e) { return e.path === p; })[0] || null;
    };
    var selEntry = selected[0] ? entryOf(selected[0]) : null;
    var targetDir = !root ? null : !selEntry ? root : selEntry.is_directory ? selEntry.path : parentOf(selEntry.path);

    // ---- windows (round 13): every window keeps its own tab strip, which can mix files and chats
    var bumpTick = function () { tick[1](function (x) { return x + 1; }); };
    var patchDock = function (id, fn) { docks[1](function (list) { return list.map(function (d) { return d.id === id ? fn(d) : d; }); }); };
    // remove one item from a window's own item list, moving its activeId to a sensible neighbor if it was the active one
    var removeItemFrom = function (d, kind, key) {
      var at = d.items.map(function (it) { return it.key; }).indexOf(key);
      var rest = d.items.filter(function (it) { return !(it.kind === kind && it.key === key); });
      var activeId = d.activeId;
      if (activeId === key) { var pick = rest[at] || rest[at - 1] || null; activeId = pick ? pick.key : null; }
      return Object.assign({}, d, { items: rest, activeId: activeId });
    };
    var openTabIn = function (path) {
      focusedDock.current = "d0";
      patchDock("d0", function (d) {
        var have = d.items.filter(function (it) { return it.kind === "file" && it.key === path; })[0];
        var items = have ? d.items : d.items.concat([{ kind: "file", key: path, title: baseName(path) }]);
        return Object.assign({}, d, { items: items, activeId: path });
      });
      // on a phone the main area sits below the tree: bring the opened file into view
      try {
        if (window.matchMedia("(max-width: 760px)").matches && mainRef.current) mainRef.current.scrollIntoView({ behavior: "smooth", block: "start" });
      } catch (e) { /* no scrolling is not a failure */ }
    };
    // drop every open file tab (in any window) that matches, and its unsaved text; callers have already asked if that needs asking
    var dropFileTabs = function (test) {
      docks[1](function (list) {
        return list.map(function (d) {
          var hit = d.items.filter(function (it) { return it.kind === "file" && test(it.key); });
          if (!hit.length) return d;
          hit.forEach(function (it) { delete BUF[it.key]; });
          var next = d;
          hit.forEach(function (it) { next = removeItemFrom(next, "file", it.key); });
          return next;
        });
      });
    };
    var closeItem = function (dockId, kind, key) {
      if (kind !== "file") { patchDock(dockId, function (d) { return removeItemFrom(d, "chat", key); }); return; }
      var drop = function () { delete BUF[key]; patchDock(dockId, function (d) { return removeItemFrom(d, "file", key); }); };
      if (!isDirty(BUF[key])) { drop(); return; }
      askConfirm({ title: "unsaved changes", message: "Discard your unsaved changes to “" + baseName(key) + "”?", okLabel: "Discard", danger: true }).then(function (yes) { if (yes) drop(); });
    };
    // move a tab, picked up by drag from one window's strip, into another window's strip (round 13)
    var moveItem = function (payload, toDockId) {
      if (!payload || typeof payload.dock !== "string" || typeof payload.kind !== "string" || typeof payload.key !== "string" || payload.dock === toDockId) return;
      var list = docks[0];
      var src = list.filter(function (d) { return d.id === payload.dock; })[0];
      var dst = list.filter(function (d) { return d.id === toDockId; })[0];
      if (!src || !dst) return;
      var moved = src.items.filter(function (it) { return it.kind === payload.kind && it.key === payload.key; })[0];
      if (!moved) return;
      if (payload.kind === "chat" && dst.items.filter(function (it) { return it.kind === "chat"; }).length >= MAX_CHATS) { msg[1]("✕ " + MAX_CHATS + " chats are open in that window: close one first"); return; }
      docks[1](function (cur) {
        return cur.map(function (d) {
          if (d.id === payload.dock) return removeItemFrom(d, payload.kind, payload.key);
          if (d.id === toDockId) return Object.assign({}, d, { items: d.items.concat([moved]), activeId: moved.key, open: true });
          return d;
        });
      });
      focusedDock.current = toDockId;
    };
    // the tree selection follows whichever file tab is active -- d0's, if it has one, else any window's
    useEffect(function () {
      var fileAct = null;
      var d0 = docks[0].filter(function (d) { return d.id === "d0"; })[0];
      if (d0 && d0.activeId && d0.items.some(function (it) { return it.key === d0.activeId && it.kind === "file"; })) fileAct = d0.activeId;
      else docks[0].forEach(function (d) { if (fileAct || !d.activeId) return; var a = d.items.filter(function (it) { return it.key === d.activeId; })[0]; if (a && a.kind === "file") fileAct = a.key; });
      if (fileAct) selected[1](fileAct);
    }, [docks[0].map(function (d) { return d.id + ":" + d.activeId; }).join("|")]);

    var onSelect = function (e) {
      selected[1](e.path);
      if (e.is_directory) {
        expanded[1](function (x) { return x.indexOf(e.path) >= 0 ? x.filter(function (p) { return p !== e.path && p.indexOf(e.path + "/") !== 0; }) : x.concat([e.path]); });
      } else {
        openTabIn(e.path);
      }
    };

    // ---- extra windows: "+ window" makes an empty one to drag a tab into; closing hides a window that
    // still has tabs (a chip up top brings it back) or removes it outright if it was already empty
    var addWindow = function () {
      var id = "w" + rid(4);
      docks[1](function (list) { return list.concat([{ id: id, open: true, items: [], activeId: null, w: 440, seq: 0, spare: null }]); });
      focusedDock.current = id;
      return id;
    };
    var closeWindow = function (id) {
      docks[1](function (list) {
        var d = list.filter(function (x) { return x.id === id; })[0];
        if (!d) return list;
        if (!d.items.length) return list.filter(function (x) { return x.id !== id; });
        return list.map(function (x) { return x.id === id ? Object.assign({}, x, { open: false }) : x; });
      });
    };
    var reorderDock = function (id, dir) {
      docks[1](function (list) {
        var i = list.map(function (x) { return x.id; }).indexOf(id), j = i + dir;
        if (i < 0 || j < 0 || j >= list.length) return list;
        var next = list.slice(), tmp = next[i]; next[i] = next[j]; next[j] = tmp;
        return next;
      });
    };
    // add a chat to a specific window (used when dropping/creating directly into one)
    var addChatTo = function (dockId, sid, title) {
      focusedDock.current = dockId;
      patchDock(dockId, function (d) {
        if (sid) { var have = d.items.filter(function (it) { return it.kind === "chat" && it.sid === sid; })[0]; if (have) return Object.assign({}, d, { activeId: have.key, open: true }); }
        var chatCount = d.items.filter(function (it) { return it.kind === "chat"; }).length;
        if (chatCount >= MAX_CHATS) { msg[1]("✕ " + MAX_CHATS + " chats are open in that window: close one first"); return d; }
        var seq = (d.seq || 0) + 1, t = newChatTab(seq, sid, title);
        // a fresh chat takes over the spare that is already started (or starting); a new spare is made right after
        if (!sid && d.spare) {
          var sp = { kind: "chat", key: d.spare.id, id: d.spare.id, token: d.spare.token, sid: null, title: "Chat " + seq };
          return Object.assign({}, d, { items: d.items.concat([sp]), activeId: sp.key, seq: seq, open: true, spare: null });
        }
        var it = { kind: "chat", key: t.id, id: t.id, token: t.token, sid: t.sid, title: t.title };
        return Object.assign({}, d, { items: d.items.concat([it]), activeId: it.key, seq: seq, open: true });
      });
    };
    // add/resume a chat wherever chats already live (the "Chats" list on the left, and any other caller
    // that does not care which window); if no window has a chat yet, a new one is made for it
    var primaryChatDock = function () {
      var found = docks[0].filter(function (d) { return d.items.some(function (it) { return it.kind === "chat"; }); })[0];
      return found ? found.id : null;
    };
    var addChat = function (sid, title) { addChatTo(primaryChatDock() || addWindow(), sid, title); };

    var run = function (label, p, after) {
      busy[1](label); msg[1](null);
      return p.then(function (r) { busy[1](null); if (after) after(r); return r; })
        .catch(function (e) { busy[1](null); msg[1]("✕ " + errText(e)); });
    };

    var newFolder = function () {
      var dir = targetDir;
      askPrompt({ title: "new folder", message: "New folder in " + (rel(root, dir) || folder[0].display) + ":", value: "", okLabel: "Create" }).then(function (name) {
        if (!name || !name.trim()) return;
        if (/[\/\\]/.test(name)) { msg[1]("✕ a name cannot contain / or \\"); return; }
        var p = join(dir, name.trim());
        run("creating", mkdir(p), function () {
          refresh([dir]);
          if (dir !== root && expanded[0].indexOf(dir) < 0) expanded[1](expanded[0].concat([dir]));
          msg[1]("created " + rel(root, p));
        });
      });
    };
    var newFile = function () {
      var dir = targetDir;
      askPrompt({ title: "new file", message: "New file in " + (rel(root, dir) || folder[0].display) + ":", value: "untitled.md", okLabel: "Create" }).then(function (name) {
        if (!name || !name.trim()) return;
        if (/[\/\\]/.test(name)) { msg[1]("✕ a name cannot contain / or \\"); return; }
        var p = join(dir, name.trim());
        var exists = (cache[0][dir] || []).some(function (e) { return e.name === name.trim(); });
        if (exists) { msg[1]("✕ " + name.trim() + " already exists there"); return; }
        run("creating", upload(p, new Blob([""], { type: "text/plain" }), name.trim(), false), function () {
          refresh([dir]); openTabIn(p); msg[1]("created " + rel(root, p));
        });
      });
    };
    var uploadFiles = function (files, dir) {
      files = [].slice.call(files || []);
      if (!files.length) return;
      dir = dir || targetDir;
      var existing = (cache[0][dir] || []).map(function (e) { return e.name; });
      var clash = files.filter(function (f) { return existing.indexOf(f.name) >= 0; }).map(function (f) { return f.name; });
      if (!clash.length) { sendFiles(files, dir); return; }
      askConfirm({ title: "replace files", message: "Replace " + clash.join(", ") + " in " + (rel(root, dir) || folder[0].display) + "?", okLabel: "Replace", danger: true }).then(function (yes) {
        sendFiles(yes ? files : files.filter(function (f) { return clash.indexOf(f.name) < 0; }), dir);
      });
    };
    var sendFiles = function (files, dir) {
      if (!files.length) return;
      var done = 0;
      busy[1]("uploading 0/" + files.length); msg[1](null);
      files.reduce(function (p, f) {
        return p.then(function () {
          return upload(join(dir, f.name), f, f.name, true).then(function () { done++; busy[1]("uploading " + done + "/" + files.length); });
        });
      }, Promise.resolve()).then(function () {
        busy[1](null); refresh([dir]);
        if (dir !== root && expanded[0].indexOf(dir) < 0) expanded[1](expanded[0].concat([dir]));
        msg[1]("uploaded " + done + (done === 1 ? " file" : " files") + " to " + (rel(root, dir) || folder[0].display));
      }).catch(function (e) { busy[1](null); refresh([dir]); msg[1]("✕ " + errText(e) + (done ? " (" + done + " uploaded)" : "")); });
    };
    var downloadPath = function (p) {
      run("downloading", download(p, baseName(p)), function () { msg[1]("downloaded " + baseName(p)); });
    };
    var downloadSel = function () {
      if (!selEntry || selEntry.is_directory) { msg[1]("select a file to download"); return; }
      downloadPath(selEntry.path);
    };
    var deleteEntry = function (en) {
      var inside = function (p) { return p === en.path || p.indexOf(en.path + "/") === 0; };
      var what = en.is_directory ? "the folder “" + en.name + "” and everything in it" : "“" + en.name + "”";
      var lose = docks[0].some(function (d) { return d.items.some(function (it) { return it.kind === "file" && inside(it.key) && isDirty(BUF[it.key]); }); });
      askConfirm({ title: "delete", message: "Delete " + what + "? This cannot be undone." + (lose ? "\n\nUnsaved changes in open tabs will be lost." : ""), okLabel: "Delete", danger: true }).then(function (yes) {
        if (!yes) return;
        var dir = parentOf(en.path);
        run("deleting", remove(en.path, en.is_directory), function () {
          dropFileTabs(inside);
          selected[1](null); refresh([dir]);
          expanded[1](expanded[0].filter(function (p) { return !inside(p); }));
          msg[1]("deleted " + en.name);
        });
      });
    };
    var deleteSel = function () {
      if (!selEntry) { msg[1]("select a file or folder to delete"); return; }
      deleteEntry(selEntry);
    };

    // Save: re-read the file first, because write-text does not check for edits made
    // elsewhere (the AI, another window); if it changed, ask before replacing it.
    var saveTab = function (path) {
      var b = BUF[path];
      if (!b || b.readonly || !isDirty(b) || saving[0]) return;
      if (!root || path.indexOf(root + "/") !== 0) { msg[1]("✕ refusing to write outside " + (root || "the profile folder")); return; }
      var out = b.crlf ? b.text.replace(/\n/g, "\r\n") : b.text, sent = b.text, name = baseName(path);
      saving[1](true); msg[1](null);
      SDK.fetchJSON("/api/fs/read-text?path=" + q(path))
        .then(function (d) { return d.truncated || d.text !== b.orig ? "changed" : "ok"; }, function () { return "unknown"; })
        .then(function (s) {
          if (s === "ok") return true;
          return askConfirm({ title: "file changed", okLabel: s === "changed" ? "Replace" : "Save anyway", danger: true,
            message: s === "changed"
              ? "“" + name + "” changed on disk since you opened it (the AI or another window may have edited it).\n\nReplace it with your version?"
              : "Could not check “" + name + "” on disk first. Save anyway?" });
        })
        .then(function (go) {
          if (!go) { saving[1](false); return undefined; }
          return writeText(path, out).then(function () {
            b.orig = out; b.base = sent;
            saving[1](false); bumpTick(); refresh([parentOf(path)]);
            msg[1]("saved " + name);
          });
        })
        .catch(function (e) { saving[1](false); msg[1]("✕ " + errText(e)); });
    };
    // Ctrl/Cmd+S saves the open tab (and never opens the browser's "save page" dialog while Lock In is up)
    saveRef.current = function () {
      var d = docks[0].filter(function (x) { return x.id === focusedDock.current; })[0] || docks[0].filter(function (x) { return x.id === "d0"; })[0];
      var a = d && d.items.filter(function (it) { return it.key === d.activeId; })[0];
      if (a && a.kind === "file") saveTab(a.key);
    };
    useEffect(function () {
      var onKey = function (e) {
        if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key === "s" || e.key === "S")) {
          e.preventDefault();
          if (saveRef.current) saveRef.current();
        }
      };
      window.addEventListener("keydown", onKey);
      return function () { window.removeEventListener("keydown", onKey); };
    }, []);

    // drag & drop from the desktop, anywhere in the window
    useEffect(function () {
      var depth = 0;
      var hasFiles = function (e) { return e.dataTransfer && [].indexOf.call(e.dataTransfer.types || [], "Files") >= 0; };
      var enter = function (e) { if (!hasFiles(e)) return; e.preventDefault(); depth++; drag[1](true); };
      var over = function (e) { if (hasFiles(e)) e.preventDefault(); };
      var leave = function (e) { if (!hasFiles(e)) return; depth = Math.max(0, depth - 1); if (!depth) drag[1](false); };
      var drop = function (e) {
        if (!hasFiles(e)) return;
        e.preventDefault(); depth = 0; drag[1](false);
        var row = e.target && e.target.closest ? e.target.closest(".nhl-row.dir") : null;
        var dir = row ? row.getAttribute("title") : null;
        uploadFiles(e.dataTransfer.files, dir);
      };
      window.addEventListener("dragenter", enter); window.addEventListener("dragover", over);
      window.addEventListener("dragleave", leave); window.addEventListener("drop", drop);
      return function () {
        window.removeEventListener("dragenter", enter); window.removeEventListener("dragover", over);
        window.removeEventListener("dragleave", leave); window.removeEventListener("drop", drop);
      };
    });

    var pickProfile = function (name) {
      var u = new URLSearchParams(window.location.search); u.set("profile", name);
      window.history.replaceState({}, "", window.location.pathname + "?" + u.toString());
      profileS[1](name);
    };
    var toDashboard = function () {
      var back = lastDashboard();
      var u = new URLSearchParams(window.location.search);
      var b = back.split("?")[0], bq = new URLSearchParams(back.split("?")[1] || "");
      if (u.get("profile")) bq.set("profile", u.get("profile"));
      navigate(b + (bq.toString() ? "?" + bq.toString() : ""));
    };
    var setTheme = function (name) {
      if ((name === "nothing-neu-light") === (m[0] === "light")) return;
      SDK.api.setTheme(name).then(function () { window.location.reload(); }).catch(function (e) { msg[1]("✕ " + errText(e)); });
    };

    // ---- chat folders: every change is saved to the server at once; if that fails the old sorting comes back
    var changeOrg = function (fn) {
      if (orgFor.current !== profile) { msg[1]("✕ chat folders are still loading"); return; }
      var before = org[0], next = fn(before);
      org[1](next);
      SDK.fetchJSON(API + "/chatorg?profile=" + q(profile), { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(next) })
        .then(function (d) { org[1]({ folders: d.folders, assign: d.assign }); })
        .catch(function (e) { org[1](before); msg[1]("✕ could not save the chat folders: " + errText(e)); });
    };
    var newChatFolder = function (moveSid) {
      askPrompt({ title: "new chat folder", message: "Name of the new chat folder:", value: "", okLabel: "Create" }).then(function (name) {
        name = name ? name.trim().slice(0, 60) : "";
        if (!name) return;
        var id = rid(5);
        changeOrg(function (o) {
          if (o.folders.length >= 100) { msg[1]("✕ 100 folders is the limit"); return o; }
          var a = Object.assign({}, o.assign); if (moveSid) a[moveSid] = id;
          return { folders: o.folders.concat([{ id: id, name: name }]), assign: a };
        });
        cx[1](function (c) { var col = Object.assign({}, c.collapsed); delete col[id]; return { collapsed: col, sel: id }; });
      });
    };
    var renameChatFolder = function (id) {
      var f = org[0].folders.filter(function (x) { return x.id === id; })[0];
      if (!f) return;
      askPrompt({ title: "rename chat folder", message: "New name for the folder:", value: f.name, okLabel: "Rename" }).then(function (name) {
        name = name ? name.trim().slice(0, 60) : "";
        if (!name || name === f.name) return;
        changeOrg(function (o) { return { folders: o.folders.map(function (x) { return x.id === id ? { id: id, name: name } : x; }), assign: o.assign }; });
      });
    };
    var deleteChatFolder = function (id) {
      var f = org[0].folders.filter(function (x) { return x.id === id; })[0];
      if (!f) return;
      var n = Object.keys(org[0].assign).filter(function (k) { return org[0].assign[k] === id; }).length;
      askConfirm({ title: "delete chat folder", okLabel: "Delete folder", danger: true,
        message: "Delete the folder “" + f.name + "”?\n\n" + (n ? "Its " + n + " chat" + (n === 1 ? "" : "s") + " are kept and move back to “no folder”." : "It is empty.") + " No conversation is deleted." }).then(function (yes) {
        if (!yes) return;
        changeOrg(function (o) {
          var a = {}; Object.keys(o.assign).forEach(function (k) { if (o.assign[k] !== id) a[k] = o.assign[k]; });
          return { folders: o.folders.filter(function (x) { return x.id !== id; }), assign: a };
        });
        cx[1](function (c) { return { collapsed: c.collapsed, sel: c.sel === id ? null : c.sel }; });
      });
    };
    // the name shown for the profile: the folder's, else the profile list's; blank until either is known (no flash of the raw id)
    var curProf = profiles[0].filter(function (p) { return p.name === profile; })[0];
    var display = (folder[0] && folder[0].display) || (curProf && (curProf.display_name || cap(curProf.name))) || (profiles[0].length ? cap(profile || "") : "");

    // every open chat, across every window -- used by the "Chats" history list on the left to mark which ones are already open
    var allChatItems = [];
    docks[0].forEach(function (d) { d.items.forEach(function (it) { if (it.kind === "chat") allChatItems.push(it); }); });

    // the left column, collapsed to a thin rail (round 13): just the knob and a button to bring it back,
    // so the file tree and chats can get out of the way when the panes need the room
    var left = !leftOpen[0]
      ? h("div", { className: "nhl-left" },
          h("span", { className: "nhl-knob nhl-raised-sm" }, h("i")),
          h("button", { type: "button", className: "nhl-btn nhl-raised-sm nhl-railbtn", title: "Show the sidebar", "aria-label": "Show the sidebar", onClick: function () { leftOpen[1](true); } }, "»"))
      : h("div", { className: "nhl-left" },
      h("div", { className: "nhl-brand" },
        h("span", { className: "nhl-knob nhl-raised-sm" }, h("i")),
        h("span", null, h("span", { className: "nhl-brandname" }, "Hermes"), h("span", { className: "nhl-label" }, "hermes · lock in")),
        h("span", { style: { flex: 1 } }),
        h("button", { type: "button", className: "nhl-tbtn nhl-raised-sm", title: "Hide the sidebar", "aria-label": "Hide the sidebar", onClick: function () { leftOpen[1](false); } }, "«")),
      profile ? h(ProfileBox, { profiles: profiles[0], profile: profile, onPick: pickProfile }) : null,
      h("section", { className: "nhl-tree nhl-raised", role: "tree", "aria-label": side[0] === "chats" ? "Chats" : "Files" },
        h("div", { className: "nhl-thead" },
          h("i", { className: "nhl-dot" }), h("b", null, display),
          h("span", { className: "nhl-path", title: root || "" }, root || "")),
        h("div", { className: "nhl-seg nhl-pressed", role: "tablist", "aria-label": "Show" },
          [["files", "Files"], ["chats", "Chats"]].map(function (o) {
            return h("button", { key: o[0], type: "button", role: "tab", "aria-selected": side[0] === o[0] ? "true" : "false", className: "nhl-chip" + (side[0] === o[0] ? " on" : ""), onClick: function () { side[1](o[0]); } }, o[1]);
          })),
        side[0] === "chats" ? h(ChatList, { profile: profile, display: display, tabs: allChatItems, org: org[0], collapsed: cx[0].collapsed, sel: cx[0].sel,
          onOrg: changeOrg, onOpen: addChat, onNew: function () { addChat(null, null); }, onNewFolder: newChatFolder, onRename: renameChatFolder, onDelete: deleteChatFolder,
          onSel: function (id) { cx[1](function (c) { return { collapsed: c.collapsed, sel: id }; }); },
          onCollapse: function (id) { cx[1](function (c) { var col = Object.assign({}, c.collapsed); if (col[id]) delete col[id]; else col[id] = true; return { collapsed: col, sel: c.sel }; }); } }) : null,
        side[0] === "chats" ? null : h("div", { className: "nhl-tools" },
          h("button", { type: "button", className: "nhl-tbtn nhl-raised-sm nhl-primary-ink", title: "New file", "aria-label": "New file", disabled: !root || !!busy[0], onClick: newFile }, "＋"),
          h("button", { type: "button", className: "nhl-tbtn nhl-raised-sm", title: "New folder", "aria-label": "New folder", disabled: !root || !!busy[0], onClick: newFolder }, "▤"),
          h("button", { type: "button", className: "nhl-tbtn nhl-raised-sm", title: "Upload files", "aria-label": "Upload files", disabled: !root || !!busy[0], onClick: function () { fileInput.current && fileInput.current.click(); } }, "↑"),
          h("button", { type: "button", className: "nhl-tbtn nhl-raised-sm", title: "Download the selected file", "aria-label": "Download", disabled: !selEntry || selEntry.is_directory || !!busy[0], onClick: downloadSel }, "↓"),
          h("button", { type: "button", className: "nhl-tbtn nhl-raised-sm nhl-danger", title: "Delete the selected item", "aria-label": "Delete", disabled: !selEntry || !!busy[0], onClick: deleteSel }, "✕"),
          h("span", { style: { flex: 1 } }),
          h("button", { type: "button", className: "nhl-tbtn nhl-raised-sm", title: "Refresh", "aria-label": "Refresh", disabled: !root, onClick: function () { refresh(); } }, "⟳"),
          h("input", { type: "file", multiple: true, ref: fileInput, style: { display: "none" },
            onChange: function (e) { uploadFiles(e.target.files); e.target.value = ""; } })),
        side[0] === "chats" ? null : h("div", { className: "nhl-rows" },
          ferr[0] ? h("div", { className: "nhl-err" }, ferr[0])
            : !root ? h("div", { className: "nhl-row nhl-dim" }, "finding the folder …")
            : h(TreeRows, { dir: root, depth: 0, cache: cache[0], expanded: expanded[0], selected: selected[0], showHidden: showHidden[0], onSelect: onSelect })),
        side[0] === "chats" ? null : h("label", { className: "nhl-hidden" }, h("input", { type: "checkbox", checked: showHidden[0], onChange: function (e) { showHidden[1](e.target.checked); } }), "show hidden files")),
      h("section", { className: "nhl-box nhl-pressed" }, h("span", { className: "nhl-label" }, "mode"),
        h("button", { type: "button", className: "nhl-btn nhl-primary", onClick: toDashboard }, "← Dashboard"),
        h("span", { className: "nhl-hint" }, "your open folders and selection stay")));

    // the file card: for types with no viewer yet (Word, Excel, archives, binaries)
    var card = function (p) {
      var en = entryOf(p), name = baseName(p), ty = en ? kind(en) : (KIND[ext(name)] || ext(name).slice(0, 4) || "file");
      return h("div", { className: "nhl-pane-msg" }, h("section", { className: "nhl-card nhl-raised" },
        h("div", { className: "nhl-label" }, rel(root, parentOf(p)) || display),
        h("div", { className: "nhl-ctitle" }, name),
        h("div", { className: "nhl-kv" },
          h("div", { className: "nhl-pressed" }, h("span", { className: "nhl-label" }, "type"), h("span", null, ty)),
          h("div", { className: "nhl-pressed" }, h("span", { className: "nhl-label" }, "size"), h("span", null, en ? size(en.size) : "–")),
          h("div", { className: "nhl-pressed" }, h("span", { className: "nhl-label" }, "changed"), h("span", null, en ? when(en.mtime) : "–"))),
        h("div", { className: "nhl-acts" },
          h("button", { type: "button", className: "nhl-btn nhl-primary", disabled: !!busy[0], onClick: function () { downloadPath(p); } }, "↓ Download"),
          en ? h("button", { type: "button", className: "nhl-btn nhl-raised-sm nhl-danger", disabled: !!busy[0], onClick: function () { deleteEntry(en); } }, "Delete") : null),
        h("span", { className: "nhl-hint" }, ext(name) === "doc" || ext(name) === "xls"
          ? "This is the old Word/Excel format (." + ext(name) + "), which cannot be shown here. Save it as ." + ext(name) + "x, or download it, or ask the AI."
          : "This type cannot be opened here. Download it, or ask the AI about it.")));
    };

    // ---- windows (round 13): laid out left to right; the first one visible flexes to fill the room, every
    // later one is a fixed, independently resizable width with its own divider to drag
    // Hermes shrinks its own terminal font as the window narrows in steps (<420px->9px, <520->10px,
    // <720->11px, <1024->12px, else 14px -- web/src/lib/terminal-appearance.ts, not something this plugin
    // can patch); the terminal's own content area measures ~36px narrower than the window's CSS width
    // (xterm's own padding/scrollbar chrome), so the window needs real headroom above the 520px line to
    // keep the 11px tier -- measured empirically: a 520px window still lands in the 10px tier, 580px clears it
    var RESIZE_FLOOR = 580;
    var startDragFor = function (dockId) {
      return function (e) {
        if (e.button !== undefined && e.button !== 0) return;
        e.preventDefault();
        var work = e.currentTarget.parentNode, x0 = e.clientX;
        var w0 = (docks[0].filter(function (x) { return x.id === dockId; })[0] || {}).w || 440;
        var max = Math.max(300, work.getBoundingClientRect().width - 260);
        draggingId[1](dockId);
        var move = function (ev) { patchDock(dockId, function (d) { return Object.assign({}, d, { w: Math.round(Math.max(RESIZE_FLOOR, Math.min(max, w0 + (x0 - ev.clientX)))) }); }); };
        var up = function () { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); draggingId[1](null); };
        window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
      };
    };
    var fileContentFor = function (dockId, path) {
      var vw = viewerOf(path);
      return vw === "image" || vw === "pdf" ? h(BlobView, { key: path, path: path, kind: vw, root: root, onDownload: function () { downloadPath(path); } })
        : vw === "office" ? h(OfficeView, { key: path, path: path, kind: ext(path), profile: profile, root: root, onDownload: function () { downloadPath(path); } })
        : vw === "card" ? card(path)
        : h(Editor, { key: path, path: path, root: root, saving: saving[0], card: card, onSave: saveTab, onClose: function () { closeItem(dockId, "file", path); }, onTick: bumpTick });
    };

    // where each window's content area actually sits on screen right now (round 13), so a chat frame
    // floated above the whole app (below) can be laid exactly on top of whichever window wants to show it.
    // A ref, not state: Dock's own content div reports itself here on every mount/update, read back
    // synchronously by the measuring effect just below rather than through a render.
    var registerFrameEl = function (dockId, el) { if (el) frameEls.current[dockId] = el; else delete frameEls.current[dockId]; };
    var measureFrames = function () {
      var next = {};
      docks[0].forEach(function (d) {
        var el = frameEls.current[d.id];
        if (!el) return;
        var r = el.getBoundingClientRect();
        next[d.id] = { left: r.left, top: r.top, width: r.width, height: r.height };
      });
      frameRects[1](function (prev) {
        var keys = Object.keys(next);
        var same = keys.length === Object.keys(prev).length && keys.every(function (k) {
          var a = prev[k], b = next[k];
          return a && a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height;
        });
        return same ? prev : next;
      });
    };
    // re-measure synchronously after layout, before the browser paints, whenever anything that could move
    // a window happens -- opening/closing/reordering/resizing a window, or collapsing the sidebar; a plain
    // browser resize is covered separately since it does not change this state
    useLayoutEffect(function () { measureFrames(); }, [docks[0], leftOpen[0]]);
    useEffect(function () {
      var onResize = function () { measureFrames(); };
      window.addEventListener("resize", onResize);
      return function () { window.removeEventListener("resize", onResize); };
    }, [docks[0]]);

    // every chat (and spare) tab that exists anywhere right now, and which window currently owns it --
    // used both to start/stop the right terminals (above) and to render each mounted frame in the right
    // place (below)
    var chatOwner = {}, chatTabs = {}, chatIsSpare = {}, chatIsActive = {};
    docks[0].forEach(function (d) {
      var dAct = d.items.filter(function (it) { return it.key === d.activeId; })[0] || d.items[0] || null;
      var dActChatId = dAct && dAct.kind === "chat" ? dAct.key : null;
      d.items.forEach(function (it) {
        if (it.kind !== "chat") return;
        chatOwner[it.key] = d.id; chatTabs[it.key] = it; chatIsSpare[it.key] = false; chatIsActive[it.key] = it.key === dActChatId;
      });
      if (d.spare) {
        chatOwner[d.spare.id] = d.id;
        chatTabs[d.spare.id] = { id: d.spare.id, token: d.spare.token, sid: null, title: "Spare chat" };
        chatIsSpare[d.spare.id] = true;
        chatIsActive[d.spare.id] = false;
      }
    });
    var chatOwnerRef = useRef({});
    chatOwnerRef.current = chatOwner;
    var onFrameUp = function (id) {
      var dockId = chatOwnerRef.current[id];
      if (!dockId) return;
      frameStarting[1](function (map) { if (map[dockId] !== id) return map; var n = Object.assign({}, map); delete n[dockId]; return n; });
    };
    var onFrameShown = function (id) { frameShown[1](function (arr) { return arr.indexOf(id) >= 0 ? arr : arr.concat([id]); }); };
    // the floating frames themselves: one per mounted chat, positioned over whichever window currently
    // owns it. A chat frame's own key is its id plus the theme mode, same as before, so it still reloads
    // on a theme switch; the wrapper around it is keyed on the id alone and never needs to remount -- only
    // its position moves when the chat's owning window changes
    var floatFrames = frameMounted[0].filter(function (id) { return !!chatOwner[id]; }).map(function (id) {
      var r = frameRects[0][chatOwner[id]];
      var style = r ? { left: r.left + "px", top: r.top + "px", width: r.width + "px", height: r.height + "px" } : { left: 0, top: 0, width: 0, height: 0 };
      return h("div", { key: id, className: "nhl-floatframe", style: style },
        h(ChatFrame, { key: id + "|" + m[0], tab: chatTabs[id], profile: profile, root: root, active: chatIsActive[id], spare: chatIsSpare[id], onUp: onFrameUp, onShown: onFrameShown }),
        draggingId[0] && draggingId[0] === chatOwner[id] && chatIsActive[id] ? h("div", { className: "nhl-dockshield" }) : null);
    });

    var winList = docks[0];
    // d0 hides itself once it is empty and some other window is open (the old file "stage" gave way to
    // chat the same way); every other window is simply shown or hidden by its own "open" flag
    var winVisible = winList.map(function (d) {
      if (d.id === "d0") return d.items.length > 0 || !winList.some(function (x) { return x.id !== "d0" && x.open; });
      return !!d.open;
    });
    var firstVisI = -1;
    for (var vi = 0; vi < winList.length; vi++) { if (winVisible[vi]) { firstVisI = vi; break; } }
    var workChildren = [];
    winList.forEach(function (d, i) {
      if (winVisible[i] && i !== firstVisI) {
        workChildren.push(h("div", { key: "sp" + d.id, className: "nhl-split", role: "separator", "aria-orientation": "vertical", title: "Drag to resize this window", onPointerDown: startDragFor(d.id) }));
      }
      workChildren.push(h(Dock, {
        key: d.id, dock: d, root: root, profile: profile,
        fill: winVisible[i] && i === firstVisI, visible: winVisible[i], dragging: draggingId[0] === d.id,
        canLeft: i > 0, canRight: i < winList.length - 1, primary: d.id === "d0",
        onPick: function (key) { focusedDock.current = d.id; patchDock(d.id, function (dd) { return Object.assign({}, dd, { activeId: key }); }); },
        onNewChat: function () { addChatTo(d.id); },
        onCloseWindow: function () { closeWindow(d.id); },
        onReorder: function (dir) { reorderDock(d.id, dir); },
        onCloseItem: function (kind, key) { closeItem(d.id, kind, key); },
        onDropItem: function (payload, toDockId) { moveItem(payload, toDockId); },
        fileContent: function (path) { return fileContentFor(d.id, path); },
        registerFrameEl: registerFrameEl }));
    });
    // a window that still has tabs but is hidden gets a small chip up top to bring it straight back
    var hiddenNonEmpty = winList.filter(function (d, i) { return d.id !== "d0" && !winVisible[i] && d.items.length; });

    return h("div", { className: "nhl-app" + (leftOpen[0] ? "" : " nhl-rail"), "data-mode": m[0] },
      left,
      h("main", { className: "nhl-main", ref: mainRef },
        h("div", { className: "nhl-top" },
          h("span", { className: "nhl-label" }, display.toLowerCase() + " · " + (targetDir ? (rel(root, targetDir) ? "/" + rel(root, targetDir) : "folder root") : "")),
          h("span", { style: { flex: 1 } }),
          hiddenNonEmpty.map(function (d) {
            var first = d.items[0], extra = d.items.length - 1;
            return h("button", { key: d.id, type: "button", className: "nhl-btn nhl-raised-sm", title: "Bring this window back", onClick: function () { patchDock(d.id, function (dd) { return Object.assign({}, dd, { open: true }); }); } },
              "↩ " + (first ? first.title : "window") + (extra > 0 ? " +" + extra : ""));
          }),
          h("button", { type: "button", className: "nhl-btn nhl-raised-sm", title: "Open a new window -- drag a file or chat tab into it", "aria-label": "New window", onClick: function () { addWindow(); } }, "+ window"),
          busy[0] ? h("span", { className: "nhl-label nhl-busy" }, busy[0] + " …") : null,
          msg[0] ? h("span", { className: "nhl-label nhl-msg" + (msg[0].charAt(0) === "✕" ? " nhl-bad" : "") }, msg[0]) : null,
          h("div", { className: "nhl-themefloat nhl-raised-sm", role: "group", "aria-label": "Theme" },
            h("button", { type: "button", className: m[0] !== "light" ? "on" : "", title: "Dark", "aria-label": "Dark", onClick: function () { setTheme("nothing-neu"); } }, "☾"),
            h("button", { type: "button", className: m[0] === "light" ? "on" : "", title: "White", "aria-label": "White", onClick: function () { setTheme("nothing-neu-light"); } }, "☀"))),
        h("div", { className: "nhl-work" }, workChildren)),
      floatFrames,
      dlg[0] ? h(Dialog, { key: "dlg", d: dlg[0], onDone: function (r) { var d = dlg[0]; dlg[1](null); if (d) d.resolve(r); } }) : null,
      drag[0] ? h("div", { className: "nhl-drop" }, h("div", { className: "nhl-dropbox nhl-raised" },
        h("div", { className: "nhl-dots nhl-dropword" }, "drop"),
        h("div", null, "Drop files to upload"),
        h("div", { className: "nhl-label" }, "into " + (targetDir || ""), " · or onto a folder in the tree"))) : null);
  }

  REG.register("nothing-lockin", LockIn);
})();
