# The Nothing design language — distilled

Reference: nothing.tech. This is a homage, not a clone. The Nothing wordmark,
logo and the NDot typeface are trademarked; **do not reproduce the wordmark or
imply affiliation**. Use free look-alike fonts (below) and our own name.

## 1. Palette — monochrome is the canvas

| Token | Value | Use |
|---|---|---|
| `--ink` | `#000000` | OLED black. Dark-mode background, light-mode text |
| `--paper` | `#FFFFFF` | Light-mode background, dark-mode text |
| `--paper-warm` | `#F4F3F1` | Light-mode background variant (warm off-white) |
| `--grey-100` | `#F5F5F5` | Light-mode raised surface |
| `--grey-200` | `#E4E4E4` | Light-mode hairline borders |
| `--grey-400` | `#9A9A9A` | Secondary text (light mode) |
| `--grey-600` | `#5A5A5A` | Secondary text (dark mode) |
| `--grey-800` | `#1A1A1A` | Dark-mode raised surface |
| `--red` | `#D71921` | The interrupt. Nothing OS widget red |

**Colour is an event, not decoration.** There is no brand colour, no gradient,
no CTA highlight, no shadow-as-depth. The grey scale *is* the hierarchy.

**Red is an interrupt** — "look HERE, now." Reserved for exactly four states in
this dashboard: a service that is **down**, a round-trip that is **over budget**,
an approval **waiting on the owner**, and the **record/active** indicator. If nothing
is urgent, no red appears on the screen at all.

## 2. Typography — three faces, non-overlapping jobs

Nothing's real system (custom, not licensable): NDot55 dot-matrix for product
names, NType82 ultra-light for editorial headlines, Lettera Mono LL uppercase
for every label and button. Free substitutes, in the same spirit:

| Job | Real face | Use here | Rules |
|---|---|---|---|
| Display / dot-matrix | NDot55 | **Doto** (Google Fonts) | Product names, hero numbers, one word per screen. Uppercase. 20–64px. Never body text — dots cost legibility below 18px |
| Editorial | NType82 | **Space Grotesk**, weight 300 | Headlines 24–32px. Recedes so the data dominates |
| Utility / data | Lettera Mono LL | **Space Mono** | Every label, button, nav item, table cell, timestamp. Uppercase, 11–13px, letter-spacing 0.02em |

Community consensus (and Nothing OS 5's own retreat from dots in body text) is
that dot-matrix belongs in **accent** positions only. Follow that.

## 3. Hierarchy — exactly three layers per screen

1. **Primary** — the one thing the eye hits first: a number, a state, a name.
   Display size, 48–96px of breathing room around it.
2. **Secondary** — supporting context, grouped tight (8–16px) to the primary.
3. **Tertiary** — metadata, navigation, system info. Visible, never competing.

Never four. Never two. Three.

**Per screen, the ceiling is:** 2 font families · 3 font sizes · 2 font weights
(Regular + one other, rarely bold) · 4 grey levels.

## 4. Grid and spacing

- 4px base grid. Default gap 16px. Section spacing 24 or 32px.
- Hairlines: 1px, `--grey-200` in light / `--grey-800` in dark. No shadows.
- Radii: 0 for structure, 999px only for genuinely circular instrument parts.
- Big empty space is a deliberate material. Let the monotony do the work.

## 5. Components — industrial, instrument-like

- **Segmented progress bars** — discrete blocks, never a smooth gradient.
- **Mechanical toggles** — a state you can read at a glance, no animation chrome.
- **Instrument widgets** — a number with a unit and a label, like a hardware readout.
- **Spec-sheet tables** — mono, uppercase headers, hairlines, no zebra striping.
- **Dot-matrix numerals** for one hero figure per screen, never in a list.

## 6. The one rule that makes it Nothing

**Break the pattern in exactly ONE place per screen.** An oversized number. A
circular widget among rectangles. A single red dot among greys. One dot-matrix
headline in an otherwise mono screen. Restraint is what makes that one moment
powerful — if everything shouts, nothing does.

## 7. Both modes are first-class

Dark: OLED black, generous. Light: warm off-white, same rigour. Neither is
"derived" from the other. Produce both for the two key screens.

## 8. Interaction states (for mockups, show them, don't animate them)

- Hover: hairline brightens or the row inverts. No colour change.
- Active/selected: the red dot, or a filled 4px bar on the left edge.
- Disabled: secondary grey, never a faded black (opacity on black reads as mud).
- Focus: 1px solid `--ink` outline with 2px offset. Visible, not glowy.
