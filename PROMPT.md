# A prompt you can hand to your agent

The install is a copy of files and two settings. Rather than typing the paths yourself, give the
block below to a Hermes agent running on the machine that serves your dashboard — it can read
`INSTALL.md` in this repository for the detail.

---

> Install the **Nothing style for Hermes** on this machine from
> `<this repository>` (clone it somewhere outside `~/.hermes` first).
>
> 1. Copy `theme/*.yaml` to `~/.hermes/dashboard-themes/` and `skin/*.yaml` to `~/.hermes/skins/`.
> 2. Copy `plugins/nothing-hud`, `plugins/nothing-lockin`, `plugins/nothing-agents` and
>    `plugins/nothing-settings` to `~/.hermes/plugins/`.
> 3. Enable the four plugins with `hermes plugins enable <name>` — a plugin that is merely present,
>    with `"enabled": true` in its own file, does not run.
> 4. Set the theme and the skin: `hermes config set dashboard.theme nothing` and
>    `hermes config set display.skin nothing` (or pick *Nothing* in the dashboard's own theme
>    picker, and `/skin nothing` in the terminal).
> 5. Restart the dashboard service and tell me the URL to open.
> 6. Then show me it worked: take a screenshot of the dashboard with the theme applied and tell me
>    which plugins appear in the sidebar. If a plugin is missing from the sidebar, read
>    `~/.hermes/logs/` for its load error and report it rather than retrying blindly.
>
> Do not edit anything inside the Hermes installation itself — every file here is drop-in, and
> nothing in Hermes's own source should be patched.

---

Two things to check yourself afterwards, because an agent can report success it did not get:

- the sidebar lists the Nothing tabs (`Lock In`, `Subagents`, `Settings`);
- the theme picker shows *Nothing*, *Nothing Neu* and *Nothing Neu Light*, and switching to one
  changes the dashboard immediately.
