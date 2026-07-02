# zstack — spin your DOM in z-space

**See the invisible stacking layers of any web page.** zstack is a Chrome/Brave
extension that explodes the page you're looking at into its **z-index / stacking
layers** and floats them in 3D — so you can finally *see* which thing is on top
of what, and why.

It's a forensic tool for the stacking bugs you can't catch in flat DevTools: the
menu that hides behind a banner, the modal that won't come to the front, the
`z-index: 999999` arms race in someone else's CSS.

---

## Install (2 minutes, no build step)

1. Download this repo (green **Code → Download ZIP**, then unzip) or clone it.
2. Open **`chrome://extensions`** (or `brave://extensions`).
3. Turn on **Developer mode** (top-right).
4. Click **Load unpacked** and select the **`extension/`** folder.
5. Pin the **zstack** icon to your toolbar.

Now open any web page and click the zstack icon. Click it again (or press `esc`)
to close.

> Works in Chrome and Brave (any Chromium browser with Manifest V3). It can't run
> on browser pages like `chrome://…`, the extension store, or the built-in PDF viewer.

---

## What you'll see

The page is taken apart into stacked planes, front-to-back, one per stacking
layer. Each plane shows what actually lives on that layer — real backgrounds,
images, SVGs and text in **paint** mode, or glowing labelled outlines in
**wire** mode.

- **Two ways to view it:**
  - **3D** — the layers float in depth; fly the camera through them, rack focus,
    and orbit to see the gaps between layers.
  - **2D** — the same layers laid out as a flat, scrollable grid. Easier to scan
    at a glance. Flip between them with the **3D / 2D** pill (or press `V`).
- **A report panel** on the right lists every layer and every element on it, plus
  any problems it found. **Click any item** to log the live element to the
  console (inspectable in DevTools) *and* light it up in the stack. Toggle the
  panel with the **☰ report** button or `L`.

## What it catches

zstack flags the stacking mistakes that cause real bugs:

- 🚨 **Absurd z-index values** — anything with `|z-index| ≥ 100,000` is called out
  as a red "felony" layer. (That `z-index: 2147483647` you've seen? Yeah.)
- 🗜️ **Silently clamped values** — browsers cap z-index at ~2.1 billion, so
  `z-index: 1600000000000000000` quietly becomes `2147483647`. zstack reads your
  original CSS and shows you the clamp.
- 🔇 **z-index that does nothing** — a `z-index` on a `position: static` element is
  ignored by the browser; zstack points it out.
- 🧬 **Why a layer exists** — explains what created each stacking context
  (`transform`, `opacity`, `filter`, `will-change`, `position`, …).

## Controls

| Key / action | What it does |
|---|---|
| `↑` `↓` / scroll | rack focus through the layers |
| drag | orbit the stack (3D) |
| `V` | switch **2D / 3D** view |
| `L` | show / hide the **report panel** |
| `P` | toggle **paint** / **wire** rendering |
| `D` | re-print the report to the DevTools console |
| `R` | snap to a 45° angle |
| `0` | reset the camera |
| `esc` | close (or click the toolbar icon again) |

Everything runs locally in your browser. zstack only reads the page you're on when
you click it — it uses just the `activeTab` and `scripting` permissions, sends
nothing anywhere, and has no servers or tracking.

## Good to know

- **Paint mode is a fast approximation, not a screenshot.** It draws each
  element's background, borders, images, SVG and text — but not box-shadows,
  pseudo-elements or complex gradients.
- Images and SVGs are backed with the page's background color so transparent art
  (decorative PNGs, icons) stays visible against the dark planes.
- Clamp/authored-value detection reads **same-origin** stylesheets. CSS loaded
  cross-origin (many third-party widgets) can't be read back, so those won't show
  their original values.

## What's in the box

```
extension/
  manifest.json   the extension manifest (activeTab + scripting only)
  background.js    toolbar click → inject / toggle the overlay
  overlay.js       the engine: DOM analysis, 3D/2D rack, paint, diagnostics
index.html         a standalone browser prototype (no install needed)
```

Want to poke at it without installing? Open `index.html` in a browser for a
self-contained demo.

## License

MIT — do whatever you like.
