# The portable half — the design, without Hermes

The dashboard theme is a YAML file, and a YAML file only means something to the Hermes dashboard.
**This folder is the part that works anywhere.** Two files, plain CSS custom properties, no
framework, no build step, no JavaScript:

```
tokens.css     (one level up)   the palette, the type scale, the spacing, dark and light
nothing.css                     the components, and it imports the tokens
example.html                    one page built from them — open it in a browser
```

## Use it

```html
<link rel="stylesheet" href="nothing.css">
```

Then use the classes, or ignore them and use the variables:

```html
<section class="card">
  <span class="card__title">Queue</span>
  <div class="readout"><span class="v">3</span><span class="u">waiting</span></div>
</section>

<div style="border-top: 1px solid var(--rule); color: var(--fg-2)">anything you like</div>
```

Dark is the default. For light, put `data-mode="light"` on the `<html>` element — every token
switches, and nothing else in your page has to change.

## What is in the sheet

| class | what it is |
|---|---|
| `.app`, `.rail`, `.main`, `.header` | the page shell: a rail, a main column, a hairline header |
| `.hero`, `.figure`, `.display`, `.hero-num` | the one dot-matrix moment per screen |
| `.card`, `.card__title`, `.grid` | a hairline surface, and a grid that reflows on its own |
| `.readout`, `.kv`, `table.spec` | instrument figures, label/value rows, a spec-sheet table |
| `.btn`, `.btn--primary`, `.btn--quiet`, `.toggle` | controls, square and flat |
| `.status`, `.status--off`, `.status--down` | a word and a square — never a traffic light |
| `.banner` | the interrupt. **One per screen, and only when something is wrong** |
| `.seg`, `.dot`, `.rule`, `.mono`, `.muted`, `.empty` | the small parts |

## The three rules that make it look right

1. **Colour is an event, not decoration.** No brand colour, no gradient, no shadow-as-depth. The
   grey scale is the hierarchy. Red `#D71921` appears **once**, for something that is actually
   wrong — the `.banner` and `.status--down` are the only places it belongs.
2. **Three type sizes per screen, at most.** Doto (dot-matrix) for one hero figure, Space Mono for
   every label and table cell, and nothing in between. Never dot-matrix below about 18 px — dots
   cost legibility.
3. **Hairlines, not shadows.** Structure is square (`--radius: 0`) and separation is a 1 px rule.

The reasoning behind each of those, with the palette table and the type stack, is in
[../DESIGN-LANGUAGE.md](../DESIGN-LANGUAGE.md).

## Fonts

`tokens.css` names three faces: **Doto**, **Space Mono** and **Space Grotesk**, all free from Google
Fonts. The example loads them from the CDN:

```html
<link href="https://fonts.googleapis.com/css2?family=Doto:wght@700&family=Space+Grotesk:wght@300;400&family=Space+Mono:wght@400;700&display=swap" rel="stylesheet">
```

Self-host them if the machine has no internet — nothing else in the sheet depends on a network.
