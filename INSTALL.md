# INSTALL

Everything here is **drop-in**. Nothing in Hermes's own source is patched, rebuilt or re-hosted,
and no step needs a secret.

Checked against Hermes **0.19** and **0.21.5**.

## 1. What ships

| piece | files | destination |
|---|---|---|
| Dashboard theme (flat Nothing) | `theme/nothing.yaml` | `~/.hermes/dashboard-themes/` |
| Dashboard theme (Neumorphism, dark) | `theme/nothing-neu.yaml` | `~/.hermes/dashboard-themes/` |
| Dashboard theme (Neumorphism, light) | `theme/nothing-neu-light.yaml` | `~/.hermes/dashboard-themes/` |
| Terminal skin | `skin/nothing.yaml`, `skin/nothing-neu.yaml` | `~/.hermes/skins/` |
| Header, Status tab, phone layout | `plugins/nothing-hud/` | `~/.hermes/plugins/` |
| Lock In: files, editor, viewers, chat | `plugins/nothing-lockin/` | `~/.hermes/plugins/` |
| Subagents tab | `plugins/nothing-agents/` | `~/.hermes/plugins/` |
| Settings hub | `plugins/nothing-settings/` | `~/.hermes/plugins/` |

A **theme** is what the dashboard looks like. A **skin** is what the terminal (and the dashboard's
Chat tab, which runs the same TUI) looks like. They are separate files because Hermes keeps them
separate; the theme cannot reach the terminal, and the skin cannot reach the page.

## 2. Install

```bash
# 0. Snapshot first, if you have a snapshot script. Then:
mkdir -p ~/.hermes/dashboard-themes ~/.hermes/skins ~/.hermes/plugins

cp theme/*.yaml ~/.hermes/dashboard-themes/
cp skin/*.yaml  ~/.hermes/skins/

for p in nothing-hud nothing-lockin nothing-agents nothing-settings; do
    rm -rf ~/.hermes/plugins/$p
    cp -r plugins/$p ~/.hermes/plugins/$p
done

for p in nothing-hud nothing-lockin nothing-agents nothing-settings; do
    hermes plugins enable $p
done

hermes config set dashboard.theme nothing
hermes config set display.skin nothing
```

Then **restart the dashboard**. A new plugin's backend route is mounted at startup only — a page
rescan is not enough. Restart it the way your host runs it (`systemctl --user restart
hermes-dashboard`, a container restart, whatever it is).

To switch themes afterwards, use the dashboard's own theme picker (*Nothing*, *Nothing Neu*,
*Nothing Neu Light*) or `hermes config set dashboard.theme nothing-neu`. In a terminal, `/skin
nothing` does the same for the skin.

**Per profile.** The dashboard theme is a per-profile setting. A profile whose own config has no
`dashboard.theme` shows Hermes's default look. For each extra profile:

```bash
hermes -p <name> config set dashboard.theme nothing
```

`nothing-agents` also has an agent-side half, and each profile that should have a team needs its own
copy of the plugin plus one "Update for this profile" press in the Subagents tab.

## 3. Verify — proof, not a claim

1. **The plugins loaded, not merely exist.** `hermes plugins list` must show all four as enabled. A
   plugin that is present, valid and `"enabled": true` in its own file still does nothing until
   `hermes plugins enable` has run; that command is what rewires the hooks.
2. **The sidebar** lists the Nothing tabs: `Lock In`, `Subagents`, `Settings`.
3. **The theme picker** shows the three themes, and switching changes the page immediately.
4. **The terminal**: open a new terminal — the banner, the prompt and the status bar should be
   black and white, no gold.
5. **If a tab is missing**, read the dashboard's log for the plugin's load error
   (`~/.hermes/logs/`) and fix that, rather than reinstalling and hoping.

## 4. Uninstall

```bash
hermes config set dashboard.theme default
hermes config set display.skin default
for p in nothing-hud nothing-lockin nothing-agents nothing-settings; do hermes plugins disable $p; done
rm -rf ~/.hermes/plugins/nothing-{hud,lockin,agents,settings}
rm -f  ~/.hermes/skins/nothing.yaml ~/.hermes/skins/nothing-neu.yaml
rm -f  ~/.hermes/dashboard-themes/nothing*.yaml
```

Restart the dashboard. Your data is untouched — these files are presentation only, except
`nothing-lockin`, which creates one folder per profile (see below).

## 5. What it does not reach — the honest list

- **Fonts come from Google Fonts** (`fontUrl` in each theme), so the viewing browser needs internet
  access. Self-host them if that matters: the two faces are Doto and Space Mono.
- **Light mode ships only as the Neumorphism variant.** One theme is one mode; the flat Nothing
  theme is dark only.
- **Built-in pages keep their own type sizes.** The "three sizes per screen" ceiling holds on the
  plugin's own surfaces, not on Hermes's built-in tables.
- **The chat terminal's first seconds.** Until its gateway reports ready, the TUI paints Hermes's
  own palette; on 0.21.5 (a DOM terminal) the theme maps that boot palette to greys, on 0.19 (a
  canvas) only the skin reaches it.
- **The terminal keeps the Hermes banner art**, recoloured to greys. The skin can replace it
  (`banner_hero`) — left alone as a taste call.
- **Spend figures on the Status tab** come from OpenRouter, cached for 60 s, and need
  `OPENROUTER_API_KEY` in the dashboard process's environment or in `~/.hermes/.env`. The key never
  leaves the server and only figures are returned. If OpenRouter is unreachable, the hero falls
  back to the gateway state.
- **The Cron drawer** edits name, prompt, schedule and delivery target. Model, toolsets, skills,
  script, workdir and blueprints stay in the classic editor.
- **The Subagents tab** sets a subagent's model, tools and "can lead". Effort, time limit and depth
  are profile-wide in Hermes, and a subagent runs on the profile's own provider.
- **Lock In's folder mapping** is `~/.hermes/nothing-lockin/folders.json`, one folder per profile,
  created the first time the tab is opened. Delete that file and the folders are re-created; the
  folders themselves are yours.
- **`nothing-lockin` writes files** through Hermes's own file API, behind the login. It does not
  read or write anything outside the profile folder it manages.
