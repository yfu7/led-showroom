> **Superseded.** This records the first aesthetic direction, before the brief changed to
> 70 % veloxity.us / 30 % modern luxury in blue-and-black. Its colour values, theme names and
> token names no longer match the app. `src/app/styles/tokens.css` is the source of truth;
> keep this only for the reasoning behind the type scale and spacing.

# LED Showroom v2 — Design Language Spec

Codename: **ATELIER**. Version 1.0 — 2026-09-05.
Scope: the whole web app (TopBar / LeftDock / Viewport / RightDock / StatusBar shell, catalog, outliner, inspector, viewport chrome, Present mode). Stack assumptions: React 19, three.js 0.185, zustand, inches internal, Y-up, ground at y=0.

---

## 0. Concept statement

The showroom is a photograph and the interface is its frame. Every luxury house we studied (Minotti, Molteni, Cassina, Fendi Casa, RH, Vitra) makes the same move: chrome recedes to warm paper or charcoal, borders become hairlines, labels shrink to tracked uppercase, and the product supplies every drop of colour. In a 3D tool the "photograph" is the viewport — an emissive LED wall in a believable venue — so the UI must be achromatic, quiet and slow enough that the render carries the brand. We call the dark default **Studio** (charcoal, immersive, for building) and the light theme **Gallery** (warm off-white paper, for presenting to clients). Both are sharp-cornered edge-docked panels separated by 1px hairlines, with no drop shadows on anything that touches an edge, 10–11px tracked uppercase section labels, a light-weight grotesk for data, one display serif reserved for scene titles and empty-state lines, and 400–650ms decelerating motion for anything that moves the camera or a panel.

The Veloxity 30% shows up in four precise places, not as a general mood. (1) **Colour**: the single accent is a tuned cyan ("Glacier", `#5CC3EC` in Studio / `#1E9AD0` in Gallery) rather than the bronze of the furniture houses — cyan is the colour LED walls actually throw, it is Veloxity's brand, and it reads as state on both charcoal and paper. It is still used the luxury way: selection, focus, active tool, primary CTA, progress — nothing else. (2) **Silhouette**: anything that *floats over the viewport* (bottom control pill, tool strip, contextual action bar, toasts, chips, tabs, buttons) is a pill or a soft 8–12px rounded shape with a translucent blurred fill, borrowed from Veloxity's 40px/9999px device-like language, while everything *docked to an edge* stays sharp and hairlined. (3) **Behaviour**: buttons invert on hover (fill ↔ outline) instead of moving, carousels/progress use a 1px accent bar instead of dots, and scrollable rails dissolve with gradient masks. (4) **Voice**: sentence case for every sentence, button and hint ("Add to scene", "Drop a wall on the floor"), tight −0.01em tracking on headings, small 12–13px copy in generous space — while tracked uppercase is kept strictly for section labels and micro wayfinding. The result: 70% monograph, 30% product device, 100% a tool you can work in for eight hours.

---

## 1. Colour tokens

All colours are CSS custom properties on `:root`. Studio (dark) is the default; Gallery (light) is applied with `[data-theme="gallery"]` on `<html>`. Never hardcode a hex in a component — only tokens. Never use pure `#000` or pure `#fff` as a surface.

### 1.1 Studio (dark, default)

```css
:root {
  color-scheme: dark;

  /* Surfaces — 4 levels + viewport */
  --surface-0: #0F0F11;            /* app ground behind everything, status bar, deepest wells   */
  --surface-1: #151517;            /* dock panels, top bar                                       */
  --surface-2: #1C1C1F;            /* inputs, list rows on hover, catalog trays, cards          */
  --surface-3: #232327;            /* popovers, dropdown menus, modals, tooltips (with blur)     */
  --surface-4: #2A2A2F;            /* pressed / active row, segmented-control thumb             */
  --surface-glass: rgba(21, 21, 23, 0.72);   /* floating chrome over viewport, + backdrop blur  */
  --surface-stone: #232326;        /* product cutout tray in catalog cards                       */
  --surface-scrim: rgba(10, 10, 12, 0.55);   /* modal backdrop                                  */

  /* Borders */
  --border-hairline: rgba(255, 255, 255, 0.08);
  --border-strong:   rgba(255, 255, 255, 0.14);
  --border-input:    rgba(255, 255, 255, 0.10);
  --border-focus:    var(--accent);

  /* Text — warm, never pure white */
  --text-1: #E9E7E2;               /* primary: values, names, headings                          */
  --text-2: #9C9A94;               /* secondary: labels, spec lines, hints                       */
  --text-3: #61605B;               /* tertiary: disabled, placeholders, unit suffixes            */
  --text-on-accent: #0F0F11;
  --text-inverse: #1C1C1A;

  /* Accent — Glacier cyan (Veloxity #28ace3, lifted for charcoal) */
  --accent:        #5CC3EC;
  --accent-hover:  #7ED1F1;
  --accent-press:  #43B1DE;
  --accent-muted:  rgba(92, 195, 236, 0.14);   /* active row bg, active chip bg, focus halo   */
  --accent-ghost:  rgba(92, 195, 236, 0.06);   /* hover on accent-adjacent surfaces           */
  --accent-ink:    #0F0F11;                     /* text on accent fill                          */

  /* Selection (viewport) */
  --sel-outline:        #5CC3EC;                /* selected object edge outline                 */
  --sel-outline-active: #A6E1F7;                /* active object in a multi-selection           */
  --sel-outline-hover:  rgba(92, 195, 236, 0.40);
  --sel-bbox:           rgba(92, 195, 236, 0.28);
  --sel-marquee-fill:   rgba(92, 195, 236, 0.08);
  --sel-marquee-line:   rgba(92, 195, 236, 0.60);

  /* Semantic — tiny and rare */
  --success: #6CBA80;
  --warning: #D8A54A;
  --danger:  #D65A52;
  --danger-muted: rgba(214, 90, 82, 0.14);
  --info:    var(--accent);

  /* Viewport backdrop — studio gradient with vignette, never flat */
  --vp-bg-center: #26262A;
  --vp-bg-edge:   #111113;
  --vp-bg-gradient: radial-gradient(ellipse 120% 90% at 50% 40%, var(--vp-bg-center) 0%, var(--vp-bg-edge) 100%);
  --vp-vignette:  radial-gradient(ellipse at center, transparent 55%, rgba(0,0,0,0.35) 100%);
  --vp-fog:       #141416;                      /* three.js scene.fog colour                    */
  --vp-floor:     #1A1A1D;                      /* ground plane base under the grid             */
  --vp-contact-shadow: rgba(0, 0, 0, 0.45);

  /* Grid */
  --grid-minor: rgba(255, 255, 255, 0.09);      /* 1 ft                                          */
  --grid-major: rgba(255, 255, 255, 0.20);      /* 4 ft                                          */
  --grid-axis-x: #B65C58;                       /* world X line through origin, desaturated red  */
  --grid-axis-z: #5B7DB8;                       /* world Z line through origin, desaturated blue */

  /* Gizmo axes — X red, Y green, Z blue, desaturated ~18% for charcoal */
  --axis-x: #D9645F;
  --axis-y: #86BE73;
  --axis-z: #5F8FDD;
  --axis-x-dim: rgba(217, 100, 95, 0.45);
  --axis-y-dim: rgba(134, 190, 115, 0.45);
  --axis-z-dim: rgba(95, 143, 221, 0.45);
  --axis-hover: #F4F2EC;                        /* hovered handle goes near-white               */
  --gizmo-free: rgba(244, 242, 236, 0.85);      /* centre free-move circle / screen ring        */
  --gizmo-plane-fill: rgba(255, 255, 255, 0.10);

  /* Snap / inference badges (SketchUp vocabulary, muted) */
  --snap-endpoint: #86BE73;
  --snap-midpoint: #5CC3EC;
  --snap-edge:     #D9645F;
  --snap-face:     #9A8BD8;
  --snap-lock:     #D07AC0;

  /* Measurement */
  --measure-active: var(--accent);
  --measure-committed: #E9E7E2;
  --measure-pill-bg: rgba(15, 15, 17, 0.85);
  --measure-pill-fg: #E9E7E2;

  /* ViewCube */
  --cube-face:       #2C2C31;
  --cube-face-top:   #35353B;
  --cube-face-side:  #26262B;
  --cube-edge:       rgba(255, 255, 255, 0.12);
  --cube-label:      #B8B6B0;
  --cube-hover:      var(--accent-muted);
  --cube-nearest:    rgba(92, 195, 236, 0.22);
  --cube-shadow:     rgba(0, 0, 0, 0.45);

  /* Shadows (only for floating chrome) */
  --shadow-pop:   0 16px 40px rgba(0, 0, 0, 0.45), 0 0 0 1px rgba(255,255,255,0.06);
  --shadow-float: 0 8px 24px rgba(0, 0, 0, 0.35);
  --shadow-ring:  0 0 0 1px rgba(255, 255, 255, 0.06);
}
```

### 1.2 Gallery (light)

```css
[data-theme="gallery"] {
  color-scheme: light;

  --surface-0: #EFECE6;            /* app ground, status bar (stone)                             */
  --surface-1: #F8F6F2;            /* dock panels, top bar (paper — RH/Molteni)                  */
  --surface-2: #FDFCFA;            /* inputs, cards, hover rows                                  */
  --surface-3: #FFFFFF;            /* popovers, menus, modals                                    */
  --surface-4: #EDE9E2;            /* pressed / active, segmented thumb                          */
  --surface-glass: rgba(248, 246, 242, 0.78);
  --surface-stone: #EDE9E2;        /* cutout tray (Fendi #ede7df / Veloxity #f2f4f7 warmed)      */
  --surface-scrim: rgba(28, 28, 26, 0.40);

  --border-hairline: rgba(28, 28, 26, 0.10);
  --border-strong:   rgba(28, 28, 26, 0.18);
  --border-input:    rgba(28, 28, 26, 0.14);

  --text-1: #1C1C1A;
  --text-2: #6B6963;
  --text-3: #A5A29A;
  --text-on-accent: #FFFFFF;
  --text-inverse: #E9E7E2;

  --accent:        #1E9AD0;
  --accent-hover:  #1787B8;
  --accent-press:  #13739E;
  --accent-muted:  rgba(30, 154, 208, 0.12);
  --accent-ghost:  rgba(30, 154, 208, 0.05);
  --accent-ink:    #FFFFFF;

  --sel-outline:        #1E9AD0;
  --sel-outline-active: #0F6F9C;
  --sel-outline-hover:  rgba(30, 154, 208, 0.40);
  --sel-bbox:           rgba(30, 154, 208, 0.30);
  --sel-marquee-fill:   rgba(30, 154, 208, 0.08);
  --sel-marquee-line:   rgba(30, 154, 208, 0.60);

  --success: #3E8F55;
  --warning: #B7842A;
  --danger:  #BF3F38;
  --danger-muted: rgba(191, 63, 56, 0.12);

  --vp-bg-center: #F3F0EA;
  --vp-bg-edge:   #DEDAD1;
  --vp-bg-gradient: radial-gradient(ellipse 120% 90% at 50% 40%, var(--vp-bg-center) 0%, var(--vp-bg-edge) 100%);
  --vp-vignette:  radial-gradient(ellipse at center, transparent 60%, rgba(28,28,26,0.10) 100%);
  --vp-fog:       #E6E2DA;
  --vp-floor:     #ECE8E1;
  --vp-contact-shadow: rgba(28, 28, 26, 0.22);

  --grid-minor: rgba(28, 28, 26, 0.08);
  --grid-major: rgba(28, 28, 26, 0.18);
  --grid-axis-x: #B4534E;
  --grid-axis-z: #4A6FAE;

  --axis-x: #C9524D;
  --axis-y: #5F9C4E;
  --axis-z: #3F73C7;
  --axis-x-dim: rgba(201, 82, 77, 0.45);
  --axis-y-dim: rgba(95, 156, 78, 0.45);
  --axis-z-dim: rgba(63, 115, 199, 0.45);
  --axis-hover: #1C1C1A;
  --gizmo-free: rgba(28, 28, 26, 0.75);
  --gizmo-plane-fill: rgba(28, 28, 26, 0.08);

  --snap-endpoint: #5F9C4E;
  --snap-midpoint: #1E9AD0;
  --snap-edge:     #C9524D;
  --snap-face:     #7A67C4;
  --snap-lock:     #B4559F;

  --measure-committed: #1C1C1A;
  --measure-pill-bg: rgba(255, 255, 255, 0.92);
  --measure-pill-fg: #1C1C1A;

  --cube-face:       #F3F0EA;
  --cube-face-top:   #FAF8F4;
  --cube-face-side:  #E6E2DA;
  --cube-edge:       rgba(28, 28, 26, 0.16);
  --cube-label:      #6B6963;
  --cube-nearest:    rgba(30, 154, 208, 0.18);
  --cube-shadow:     rgba(28, 28, 26, 0.18);

  --shadow-pop:   0 16px 40px rgba(28, 28, 26, 0.10), 0 0 0 1px rgba(28,28,26,0.06);
  --shadow-float: 0 8px 24px rgba(28, 28, 26, 0.10);
  --shadow-ring:  0 0 0 1px rgba(28, 28, 26, 0.06);
}
```

### 1.3 Colour rules

- Accent budget per screen: selection outline, focus ring, active tool button, active chip/tab, one primary button, progress bar, in-progress measurement. If a screen shows more than ~5 accent elements at once, something is wrong.
- Semantic colours appear only as: a 6px dot, a 1px underline on an invalid field, a toast stripe, a danger button on confirm dialogs. Never as a panel or row background.
- LED emissive content is rendered, not painted with UI colour. Do not tint UI to match content.
- Viewport contrast: `--text-1` on `--surface-1` is ≥ 12:1 in both themes; `--text-2` ≥ 4.6:1; `--text-3` is decorative only (units, placeholders) and may fall below AA.

---

## 2. Typography

### 2.1 Families (Google Fonts)

```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Inter:wght@300;400;500;600&family=DM+Mono:wght@300;400;500&display=swap" rel="stylesheet">
```

```css
:root {
  --font-display: "Instrument Serif", "Iowan Old Style", Georgia, serif;     /* scene titles, empty-state line, designer attribution (italic) */
  --font-ui:      "Inter", "Helvetica Neue", Helvetica, Arial, sans-serif;   /* everything else                                               */
  --font-mono:    "DM Mono", "SF Mono", ui-monospace, Menlo, monospace;       /* numeric fields, readouts, HUD, key caps, grid step             */
  font-feature-settings: "tnum" 1, "cv11" 1, "ss01" 0;  /* Inter: tabular numerals on, single-storey a off */
}
```

Why: Inter at 300/400 is the free stand-in for the Söhne / Neue Haas class the furniture houses use, and it has proper `tnum`. Instrument Serif is a single-weight Ogg/Tabac-class display face — cheap to load and impossible to over-use. DM Mono is a light, geometric mono that does not read as code. Manrope (Veloxity) was considered and rejected: its geometric roundness pulls toward "tech startup"; Veloxity's voice is carried instead by tight heading tracking and sentence case.

### 2.2 Scale (px / line-height / weight / tracking)

| Token | Size | LH | Weight | Tracking | Family | Use |
|---|---|---|---|---|---|---|
| `--t-micro` | 10 | 12 | 500 | +0.10em, uppercase | ui | ViewCube faces, key caps, status bar chips, count badges |
| `--t-label` | 11 | 14 | 500 | +0.08em, uppercase | ui | Section headers ("TRANSFORM"), tab labels, column heads, catalog card category |
| `--t-caption` | 11 | 14 | 400 | 0 | ui | Spec lines under card names, hint bar, tooltip secondary |
| `--t-body` | 12 | 16 | 400 | 0 | ui | Default UI text: rows, buttons, menu items, inputs' labels |
| `--t-value` | 13 | 16 | 400 | 0 | mono | Numeric field values, HUD readouts, measurement pills |
| `--t-body-lg` | 14 | 20 | 400 | −0.005em | ui | Prose in modals, empty-state sentence, toasts |
| `--t-title` | 16 | 20 | 500 | −0.01em | ui | Panel titles, modal titles, catalog item name on hover card |
| `--t-heading` | 20 | 24 | 400 | −0.015em | ui | Top bar scene name (editable), dialog headline |
| `--t-display-sm` | 28 | 32 | 400 | −0.01em | display | Empty-state line, Present-mode scene title |
| `--t-display` | 40 | 44 | 400 | −0.015em | display | Onboarding / welcome, Present-mode intro card |
| `--t-display-lg` | 64 | 64 | 400 | −0.02em | display | Marketing/landing only; never inside the tool shell |

Rules:
- Weights: only 300, 400, 500, 600 for Inter. 600 only for primary button labels and the active object name. 300 for display-adjacent grotesk (e.g. the number on a big HUD readout, Present-mode captions). Never 700+.
- Headings are never bold. Emphasis is done by size, colour (`--text-1` vs `--text-2`) or the serif, not by weight.
- Uppercase tracking rule: uppercase text ≤ 11px gets +0.08em; 10px gets +0.10em; uppercase is never used above 12px. Anything uppercase uses weight 500 and `--text-2`, turning `--text-1` when active/hovered.
- Sentence case for every sentence, button, hint, menu item and tooltip ("Frame selection", "Add to scene", "Drop a wall on the floor"). Title Case only for proper product names ("Absen PL 1.9").
- Designer/vendor attribution uses the display serif italic at 13px, `--text-2`: *Absen, 2025 — PL series*. This is the ritual from Molteni/B&B/Fendi.
- Numbers: every numeric value in the UI (fields, readouts, HUD, dimensions, catalog spec lines like "1.9 mm · 500 × 500 mm · 7.2 kg") is set in `--font-mono` with `tnum`. Prose numbers in sentences stay in Inter.
- Units render inside the field as a suffix in `--text-3`, `--font-mono`, 12px: `96 in`, `12′ 6″`, `1.5 m`. Use the real prime marks ′ ″ (U+2032/U+2033), not apostrophes/quotes.
- Minimum size anywhere in the tool: 10px. Nothing smaller, including in the viewport (measurement labels are ≥ 11px screen-space).

---

## 3. Spacing, radii, shadows, glass, borders

```css
:root {
  --sp-0: 0; --sp-1: 2px; --sp-2: 4px; --sp-3: 6px; --sp-4: 8px; --sp-5: 12px;
  --sp-6: 16px; --sp-7: 20px; --sp-8: 24px; --sp-9: 32px; --sp-10: 48px; --sp-11: 64px;

  --radius-0: 0;        /* docked panels, section headers, list rows (full-bleed rows)         */
  --radius-1: 2px;      /* inputs, key caps, swatches, checkbox                                 */
  --radius-2: 4px;      /* row highlight inset, chips inside inputs, thumbnail corner in lists  */
  --radius-3: 8px;      /* popovers, dropdown menus, tooltips, catalog cards, toasts            */
  --radius-4: 12px;     /* cutout trays, contextual action bar, modals, Present intro card      */
  --radius-pill: 9999px;/* bottom control pill, tool strip, chips, segmented controls, buttons  */

  --blur-glass: 18px;   /* Molteni header value — floating chrome over the viewport             */
  --blur-scrim: 2px;    /* modal scrim                                                          */

  --hairline: 1px solid var(--border-hairline);
  --hairline-strong: 1px solid var(--border-strong);
}
```

Rules:
- **Sharp vs soft**: anything docked to a screen edge (top bar, docks, status bar, section headers, rows) has `--radius-0` and separates with hairlines only — no shadow, no rounded corner. Anything floating over the viewport or over a panel (menus, popovers, tooltips, bottom pill, tool strip, action bar, toasts, modals, cards) is rounded (`--radius-3` / `-4` / `-pill`) and may carry `--shadow-pop` or `--shadow-float`.
- **Glass**: floating chrome over the viewport uses `background: var(--surface-glass); backdrop-filter: blur(var(--blur-glass)) saturate(1.1); border: var(--hairline-strong);`. Panels do not use glass — they are opaque so the render stays crisp beside them.
- **Shadows**: exactly three tokens. `--shadow-pop` for menus/popovers/modals, `--shadow-float` for the bottom pill / action bar / toasts, `--shadow-ring` alone for the top bar when the viewport scrolls under it in Present mode. Nothing else has a shadow. Cards in the catalog have none at rest.
- **Borders**: hairline `rgba` borders, never opaque grey lines; 1px always (no 2px except the Veloxity-style outline buttons and the focus ring). Dividers between sections are full-bleed hairlines; dividers between rows are none (rows separate by spacing and hover tint).
- **Focus**: `outline: none; box-shadow: 0 0 0 1px var(--surface-1), 0 0 0 2px var(--accent);` on `:focus-visible` only.
- **Density**: panel content padding 12px horizontal; row height 28px in outliner, 24px in inspector fields; section header height 32px; gap between fields 4px; between groups 12px; between sections a hairline plus 8px.
- **Gradient masks**: any horizontally scrollable rail (view thumbnails, category chips, Present highlight reel) fades its edges with a 48px mask (`mask-image: linear-gradient(90deg, transparent, #000 48px, #000 calc(100% - 48px), transparent)`) — the Veloxity marquee move at tool scale. Vertical lists in docks fade the bottom 24px only when overflowing.

---

## 4. Layout — app shell

```
┌──────────────────────────────────────────────────────────────────────────┐
│ TopBar 44px                                                              │
├──────────────┬───────────────────────────────────────────┬───────────────┤
│ LeftDock     │ Viewport (flex 1)                          │ RightDock     │
│ 280px        │  ┌ tool strip (left, floating pill)        │ 300px         │
│ Catalog /    │  ┌ ViewCube 96px (top-right, 20px margin)  │ Inspector /   │
│ Outliner     │  ┌ HUD readouts (top-left, under top bar)  │ Environment   │
│ tabs         │  ┌ bottom control pill (centre, 16px up)   │               │
├──────────────┴───────────────────────────────────────────┴───────────────┤
│ StatusBar 28px                                                           │
└──────────────────────────────────────────────────────────────────────────┘
```

### 4.1 Regions

| Region | Size | Surface | Notes |
|---|---|---|---|
| TopBar | 44px tall, full width | `--surface-1`, bottom hairline | Left: wordmark (16px serif "Showroom" or client logo, max-h 20px) + scene name (`--t-heading`, editable on click, 400) + autosave tick. Centre: mode segmented control **Edit · Present** (pill, 28px). Right: Undo/Redo icon buttons, Units dropdown, theme toggle, Share (secondary button), one primary button ("Export"). Every item is 28px tall, 8px gaps, 16px side padding. |
| LeftDock | default 280, min 220, max 400, resizable by a 4px hairline drag handle | `--surface-1`, right hairline | Tabs at top (uppercase `--t-label`, 36px row, active tab gets a 1px accent underline): **Catalog · Objects**. Collapse button in tab row right edge. Collapsed state = 40px rail with two vertical icon tabs. |
| Viewport | flex 1, min 480 | `--vp-bg-gradient` behind the WebGL canvas, `--vp-vignette` as a CSS overlay | All chrome inside is floating glass (§7). |
| RightDock | default 300, min 260, max 440, resizable | `--surface-1`, left hairline | Inspector when something is selected; Environment when nothing is (Spline/Vectary pattern). Header row 36px with the entity name / "Environment". Collapsed = 40px rail. |
| StatusBar | 28px, full width | `--surface-0`, top hairline | Left: tool hint text (`--t-caption`, `--text-2`) with key caps. Centre: snap state chips. Right: grid step (mono), units, zoom %, FPS/perf, transient numeric entry field during drags (SketchUp Measurements box, 120px, right-aligned). |

### 4.2 Collapsible behaviour

- `Ctrl/Cmd + \` toggles both docks + status bar (viewport chrome stays). `Shift + P` toggles the RightDock only. Double-clicking a dock's drag handle resets it to default width.
- Collapse animates width 200ms `--ease-standard`; content fades out at 120ms first so text never squashes. Collapsed rails show tab icons with tooltips; clicking a rail icon expands the dock to that tab.
- Panels never float and never overlap the viewport on desktop (Figma UI3 lesson). Dock widths persist in localStorage.
- Present mode (TopBar segmented control or `Ctrl/Cmd + Shift + P`): docks and status bar slide out (350ms `--ease-out-slow`), top bar becomes glass with only wordmark, scene title, view thumbnails strip (bottom-right), Share and Exit. Bottom pill shrinks to Views · Fit · Fullscreen.

### 4.3 Responsive

| Width | Behaviour |
|---|---|
| ≥ 1600 | Defaults above; RightDock may open to 340 on first run. |
| 1280–1599 | LeftDock 240, RightDock 280. |
| 1024–1279 | LeftDock collapsed to rail by default; RightDock 280; ViewCube 80px. |
| 768–1023 (tablet) | Both docks are overlay sheets (`--surface-3`, glass edge, `--shadow-pop`) toggled from the top bar; ViewCube 64px; bottom pill gains on-screen **Orbit · Pan · Fly** toggles when a touch pointer is detected; status bar hidden, hints move into a transient pill above the bottom pill. |
| < 768 (phone) | Present/view-only: viewport + bottom pill (Views · Fit · Share) + top glass bar. Editing tools hidden with a one-line note: "Open on a larger screen to edit." |

Minimum supported edit resolution: 1024 × 640.

---

## 5. Components

Common: all interactive controls are 28px tall (compact 24px inside inspector rows), 12px `--t-body`, transitions per §8. Disabled = `opacity: .45; pointer-events: none` (never grey-out by recolouring). Every control has a `:focus-visible` ring per §3.

### 5.1 Buttons

| Variant | Rest | Hover | Press | Notes |
|---|---|---|---|---|
| **Primary** | bg `--accent`, text `--accent-ink`, 600, pill, 1px border `--accent`, padding 0 14px, h 28 | **Inverts**: bg transparent, text `--accent`, border `--accent` | scale(.97), bg `--accent-press` (if filled) | One per surface. Optional trailing 16px `arrow-up-right` icon on "go somewhere" actions (Export, Open, Share) — the Veloxity glyph. |
| **Secondary** | bg transparent, text `--text-1`, 500, pill, 1px border `--border-strong` | bg `--surface-2`, border `--text-3` | scale(.97) | Default for dialogs' non-primary actions, Share, Swap. |
| **Ghost** | bg transparent, text `--text-2`, 400, radius `--radius-2`, no border | text `--text-1`, bg `--surface-2` | scale(.97) | Menu-like in-panel actions ("Reset", "Clear all"). |
| **Danger** | like Secondary but text `--danger`, border `--danger` at 40% | bg `--danger-muted` | — | Only inside confirm dialogs / destructive rows. |
| **Icon** | 28×28 (24×24 compact), radius `--radius-2`, icon 20px `--text-2` | icon `--text-1`, bg `--surface-2` | bg `--surface-4` | Active/toggled: icon `--accent`, bg `--accent-muted`. Always has a tooltip with key cap. |
| **Icon on glass** (viewport) | 32×32 circle, icon 20px `--text-1` at 85% | bg `rgba(255,255,255,.08)` (gallery: `rgba(28,28,26,.06)`) | — | Used in tool strip, bottom pill, action bar, Present chrome. Active: icon `--accent`, bg `--accent-muted`. |

Button labels: sentence case, verbs first ("Add to scene", "Frame selection", "Export PDF"). No ellipsis on labels; a chevron icon indicates a menu.

### 5.2 Segmented control

Pill track `--surface-2`, 1px hairline border, 28px tall, 2px inner padding; items padding 0 12px, `--t-body` 500 `--text-2`; the active item is a sliding thumb `--surface-4` (Studio) / `--surface-3` + `--shadow-ring` (Gallery) with text `--text-1`; the thumb slides 180ms `--ease-standard`. Icon-only variant is 28px per item. Used for Edit/Present, Perspective/Ortho, Local/World, Realistic/Clay/Wire/Pixel, unit systems. Max 5 items; beyond that use a dropdown.

### 5.3 Toggle (switch)

Track 28×16, radius pill, `--surface-4` with hairline; knob 12px, `--text-2` at rest; on: track `--accent`, knob `--accent-ink`. 150ms. Label to the left in `--t-body`, `--text-1`; helper text `--t-caption` `--text-2` beneath if needed. Checkbox variant: 14px square, `--radius-1`, hairline, checked = `--accent` fill with 1.25px check.

### 5.4 Numeric field (NumberField)

```
┌ label ┐┌──────────────────────┐
│  X    ││            96.00  in │   ← 24px tall in inspector, 28px elsewhere
└───────┘└──────────────────────┘
```

- Container: `--surface-2`, 1px `--border-input`, `--radius-1`, height 24, padding 0 6px. Value `--t-value` mono, right-aligned, `--text-1`; unit suffix `--text-3` mono 11px with 4px gap. Focus: border `--accent`, value selected on focus.
- Label (X/Y/Z, W/H, °): 24px wide, `--t-label` without uppercase transform for single letters — 11px 500 `--text-2`; on hover the label shows an `ew-resize` cursor and becomes the **scrub handle** (Figma label scrub): drag horizontally to change; vertical pointer position while dragging selects speed zones — top quarter 4×, upper-mid 1×, lower-mid ¼, bottom 1/16 of the snap increment; the label text turns `--accent` while scrubbing; the value updates live with the drag; a thin 1px accent line under the field shows the scrub direction.
- Triplet layout for X/Y/Z: three fields in a row, 4px gaps, each label colour-coded by a 2px left bar in `--axis-x/y/z` at 60% (not text colour — keeps it quiet). `Tab` moves X→Y→Z, `Enter` commits, `Esc` reverts, `↑/↓` nudge by the snap increment, `Shift+↑/↓` ×10, `Alt+↑/↓` ÷10.
- Input contract: accepts bare numbers in the current unit, `12'6"`, `12′ 6″`, `12ft 6in`, `1.5m`, `450mm`, `30cm`, arithmetic `+ − * / ^ ( )` and relative edits like `+12` or `*2`; echoes the canonical formatted string on blur.
- Mixed multi-selection shows `—` in `--text-3`; typing applies to all.
- Proportion lock: a 20px icon button between W and H, `link` icon; active = `--accent`.
- Invalid: 1px `--danger` underline (not a red border), tooltip with the reason.

### 5.5 Slider

Track 2px `--border-strong`, filled portion `--accent`, thumb 12px circle `--text-1` with `--shadow-ring`; hover thumb 14px; a mono value field (56px) sits to the right and stays editable; double-click the thumb to reset. Used for brightness, opacity, fog, sun angle. No tick marks except at 0 / default (a 1px hairline notch).

### 5.6 Dropdown / select / menu

Trigger: like a Secondary button but `--radius-1`, left-aligned text, trailing 16px `chevron-down` `--text-3`. Menu: `--surface-3`, `--radius-3`, `--shadow-pop`, 4px padding, items 28px tall `--t-body`, radius `--radius-2`, hover `--surface-2`, selected item shows a 14px check in `--accent`; group labels `--t-label` `--text-3` with 8px top padding; separators hairline with 4px margin; key caps right-aligned in mono `--t-micro`. Opens 140ms fade + 4px translateY, closes 100ms. Max-height 320 with fade masks.

### 5.7 Tabs

Dock tabs: uppercase `--t-label`, 36px row, 16px horizontal padding, `--text-2`; active `--text-1` with a 1px `--accent` underline that slides 180ms; hover `--text-1`. Inspector sub-tabs use the segmented control instead. Never more than 4 tabs.

### 5.8 Section header (inspector / outliner groups)

32px row, `--t-label` uppercase `--text-2`, 12px padding, 12px `chevron-right` that rotates 90° when open (150ms); right side: optional `plus` / `eye` / `more-horizontal` icon buttons (compact 24px) that appear at 60% and go to 100% on row hover. Top hairline above every section except the first. Content padding 8px 12px 12px.

### 5.9 Cards (catalog items)

```
┌───────────────────────────┐
│ ┌───────────────────────┐ │
│ │  cutout on stone tray │ │  1:1 tray, --surface-stone, --radius-4 inside
│ │      (4:3 → 1:1)      │ │
│ └───────────────────────┘ │
│  Absen PL 1.9              │  --t-body 500 --text-1
│  1.9 mm · 500×500 · 7.2 kg │  --t-caption mono --text-2
│  LED WALL  · Absen         │  --t-label uppercase --text-3 + serif italic vendor
└───────────────────────────┘
```

- Card: no border, no shadow, `--radius-3`, padding 4px; grid 2-up at 280px dock (gap 8px), 3-up above 360px. Thumbnail: product cutout render on `--surface-stone` tray with 12% padding (Veloxity tray / Fendi stone panel), `--radius-4`.
- Hover (600ms `--ease-out-expo`): thumbnail image `scale(1.03)`; a `rgba(15,15,17,.65)` overlay (Gallery: `rgba(28,28,26,.55)`) fades in with a centred glass pill "**Add to scene ↗**" and a top-right 24px `heart` icon button; card name goes `--text-1`. Drag start: the card lifts (`--shadow-float`, scale .98) and a 96px ghost thumbnail follows the cursor into the viewport.
- Selected-in-scene state (product already used): a 6px `--accent` dot before the name. Loading: tray shows a shimmer (`--surface-2` → `--surface-4`, 1.4s), text greyed; not clickable (IKEA).
- Catalog header: search field (28px, `search` icon, `Ctrl+K` key cap), then a horizontally scrolling row of category chips with fade masks; chips = pill, 24px, `--t-caption`, hairline border, active = `--accent-muted` bg + `--accent` text + `--accent` border at 40%.
- Contextual section when an entity is selected: "Swap with similar" and "Goes with" as two collapsible sections above the grid (IKEA).

### 5.10 List rows (outliner)

28px tall, full-bleed, `--radius-0`; indent 16px per level with 1px hairline guides; 20px type icon `--text-2`; name `--t-body` `--text-1` (500 when active object); right side toggles `eye` and `lock` (20px, `--text-3`, 100% on row hover or when toggled off — a toggled-off eye stays visible in `--text-2`). Hover: `--surface-2`. Selected: `--accent-muted` bg; active object additionally gets a 2px `--accent` left bar. Drag-to-reparent shows a 1px accent insertion line or an accent-muted target row. Double-click to rename (inline input, same row). Right-click menu per §5.6. Row count in the header as `--t-micro` mono.

### 5.11 Tooltips

`--surface-3` glass, `--radius-2`, `--shadow-float`, padding 6px 8px, `--t-caption` `--text-1`, no arrow; key caps right-aligned: mono `--t-micro` in a 18px-tall `--surface-4` box with hairline and `--radius-1`, uppercase, platform-aware glyphs (⌘ ⌥ ⇧ ⌃ on macOS; Ctrl Alt Shift on Windows/Linux). 150ms delay, 120ms fade; follows keyboard focus too. Catalog thumbnail hover tooltips show the spec triplet.

### 5.12 Modals / dialogs

Scrim `--surface-scrim` + `blur(2px)`; panel `--surface-3`, `--radius-4`, `--shadow-pop`, width 420 (small) / 640 (medium) / 960 (export preview); padding 24px; title `--t-title`, body `--t-body-lg` `--text-2`; actions right-aligned: Ghost (Cancel) + Primary; destructive confirms use Danger. Enter 200ms fade + scale(.98→1) `--ease-out-expo`; exit 120ms. Focus trapped; `Esc` closes. Editorial dialogs (welcome, onboarding) may use `--t-display-sm` serif for the headline.

### 5.13 Toasts

Bottom-centre, 24px above the bottom pill; glass pill, `--shadow-float`, 36px tall, `--t-body`, icon 16px left (`check` in `--success`, `alert-triangle` in `--warning`, `x-circle` in `--danger`), optional Ghost action ("Undo") right; 3.5s auto-dismiss, 5s with action; slides up 200ms `--ease-out-expo`, fades out 150ms. Max 3 stacked with 8px gaps. Undo toasts read "Deleted LED Wall 2 — Undo".

### 5.14 Empty states

Centred in the region; 32px `--text-3` icon on top (thin line, no illustration), then a serif line `--t-display-sm` `--text-1` (e.g. *A blank stage.*), then one grotesk sentence `--t-body-lg` `--text-2` ("Drop a wall from the catalog, or press N to add one."), then one Secondary button. Viewport empty state additionally shows numbered steps in `--t-label`: `( 1 ) Choose a wall   ( 2 ) Set pitch   ( 3 ) Place it in the room`. Never a dashed box.

### 5.15 Loading

- Panel/list skeletons: shimmer bars `--surface-2` → `--surface-4`, 1.4s linear, radius `--radius-1`.
- Global progress (export, heavy load, scene open): a 1px `--accent` bar under the top bar edge spanning full width (Veloxity progress bar), track `--border-hairline`; indeterminate = a 30% segment sweeping 1.2s.
- Viewport asset loading: entity placeholder is a wireframe bbox in `--sel-outline-hover` with a centred mono `--t-micro` "LOADING" label; fades to the model in 300ms.
- Spinners: 16px ring, 1.25px stroke, `--text-3`, only inside buttons ("Exporting…").

---

## 6. Viewport chrome

All viewport chrome is glass (§3) and sits inside 16px insets. It hides during camera drags only when explicitly noted.

### 6.1 Tool strip (left, vertical)

Floating pill, 40px wide, vertically centred on the viewport's left edge (16px inset); 32px icon-on-glass buttons stacked with 4px gaps and a hairline separator between groups: **Select/Move (V) · Transform (W/E/R cycles, long-press for a popover) · Measure (M) · Calibrate (C) · Content (T) · Shape paint (B)**. Active tool: icon `--accent` + `--accent-muted` bg. Tooltips right.

### 6.2 Bottom control pill (centre)

Glass pill 40px tall, 16px above the status bar (above the bottom edge in Present mode), items 32px with 4px gaps, hairline separators between groups:

`[Persp | Ortho] · [Views ▾] · Fit (Shift+F) · Home (H) · | · Grid (G) · Snap ▾ (S) · | · [Realistic | Clay | Wire | Pixel] · | · Units ▾ · Ruler ▾ · | · Present`

- Views menu: Top / Front / Right / Iso + saved views with 64×36 thumbnails and `Tab` cycles.
- Snap popover: magnet button with per-type chips Grid · Object · Face · Angle · View; active chips `--accent`. Magnet shows a 4px `--accent` dot when any snap is on.
- Ruler menu (IKEA): toggles Object dimensions · Spacing · Room dimensions.
- On touch devices the pill grows a left group Orbit · Pan · Fly.
- Pill fades to 40% opacity during orbit/pan drags and returns on release (150ms).

### 6.3 ViewCube (top-right)

96px cube (80 at 1024–1279, 64 tablet), 20px inset from viewport top-right, rendered in perspective in its own overlay canvas:
- Faces `--cube-face` with `--cube-face-top` on the +Y face and `--cube-face-side` on ±Z for permanent orientation legibility (the Autodesk gradation cue); edges `--cube-edge`; face labels `--t-micro` uppercase `--cube-label` (FRONT, BACK, LEFT, RIGHT, TOP, BOTTOM); a soft `--cube-shadow` ellipse beneath as if lit from above.
- Outline dashed (1px, 3/3) when off-axis; solid when at one of the 26 fixed views. Piece nearest the current view is tinted `--cube-nearest`; hovered piece `--cube-hover` with the label going `--text-1`.
- Click = 450ms `--ease-out-expo` transition + fit to selection/scene; drag = arcball with 10° snap-and-go; edge/corner hit areas expanded 2×; orthogonal-face arrows and roll arrows (thin 1.25px line icons in `--text-2`) appear only at face views; `home` icon button (24px, glass) top-left of the cube; small **Persp/Ortho** text toggle (`--t-micro` mono) beneath. Auto-ortho on face views; back to perspective on next free orbit, projection blended during the transition.
- Axis-ball helper (three coloured discs X/Y/Z with letters, hollow for negatives) appears inside the cube area on hover for users who prefer Blender's widget.

### 6.4 Grid and ground plane

- Ground plane `--vp-floor`, extends 600 ft so ortho Top never shows an edge; shader grid: 1 ft minor lines `--grid-minor` 1px, 4 ft major `--grid-major` 1.5px; adaptive at far zoom (4 ft / 16 ft) with the current step printed in the status bar (mono: `GRID 1 FT`); fades to zero by ~200 ft from the camera. World X and Z lines through the origin in `--grid-axis-x` / `--grid-axis-z`, 1.5px, with the negative halves at 50% (SketchUp dashed convention approximated by opacity). Metric mode: 0.25 m / 1 m.
- Contact shadow: soft radial `--vp-contact-shadow` disc under every entity (blur radius ≈ 6 in), plus the renderer's real shadow from the key light at low opacity.
- Backdrop: `--vp-bg-gradient` behind the transparent canvas, `--vp-vignette` overlay div on top of the canvas with `pointer-events: none`; scene fog `--vp-fog` starting at 150 ft.

### 6.5 Selection

- Selected: 1.5px screen-space edge outline `--sel-outline` (post-process), plus a thin 1px bbox in `--sel-bbox` only while transforming. Active object in a multi-select: `--sel-outline-active` (lighter). Hover: 1px `--sel-outline-hover`. Marquee: `--sel-marquee-fill` with 1px `--sel-marquee-line` border, `--radius-1`.
- Contextual action bar: glass pill 32px, appears 8px above the selection's screen bbox (clamped to viewport) 200ms after selection; buttons: Rotate 90° · Duplicate · Swap · Lock · Delete · Add to quote · ⋯. Hidden during camera or gizmo drags and in Present mode.

### 6.6 Transform gizmo

- Screen-constant size (≈ 96px), drawn on top. Arrows 1.5px shaft + small cone in `--axis-x/y/z`; plane tiles `--gizmo-plane-fill` with axis-coloured 1px edges; centre free-move circle and outer screen ring `--gizmo-free`; rotation rings 1.5px axis colours; scale handles 6px cubes.
- Hover: handle → `--axis-hover`, others stay. Drag: non-active handles drop to `--axis-*-dim`; a mono `--t-value` delta label in a `--measure-pill-bg` pill follows the active handle ("+24.00 in", "15°", "×1.25") and is clickable to type an exact value; a dotted axis-coloured guide line extends along the active axis.
- Local/World shown as `L`/`W` `--t-micro` mono badge at the gizmo centre-top; pivot presets Bottom/Centre/Top in the inspector Transform section; `Ctrl`-drag moves the pivot with a floating numeric panel.

### 6.7 HUD readouts (top-left of viewport)

Stack of mono `--t-micro` uppercase lines in `--text-2` at 80%, 12px from the top-left inset, no background: `PERSP · 50 MM`, `SELECTION 2`, `12′ 6″ × 8′ 0″` (selected wall size), `1.9 MM · 3 840 × 2 160` (pixel pitch and resolution of the active wall). Present mode hides them. Zoom % and FPS live in the status bar, not the HUD.

### 6.8 Hint bar (status bar left)

`--t-caption` `--text-2`: verb-first sentence with key caps: "Drag to move · **Shift** vertical · **Ctrl** invert snap · **Esc** cancel". Updates per tool and per drag phase. In tablet mode it becomes a transient glass pill above the bottom pill.

### 6.9 Measurement overlay

- Points: 8px filled circles (`--measure-active` in progress, `--measure-committed` when saved) with a 1px `--surface-0` halo; 24px hit area; draggable after placement with live recompute.
- Lines 1px; committed dimensions get 1px extension lines and 4px slash end caps; label pill `--measure-pill-bg` / `--measure-pill-fg`, mono `--t-value` 11–13px screen-space, 4px 8px padding, `--radius-pill`, always screen-aligned by default.
- Inference badges: 6px dots in `--snap-*` with a `--t-micro` word tooltip (ENDPOINT, MIDPOINT, ON EDGE, ON FACE, LOCKED) 8px right of the cursor; dotted guide line in the axis colour while locked.
- Spacing/room dimension classes are distinguished by end-cap style (slash = object, dot = spacing, arrow = room), not by colour.

### 6.10 Fly mode

Floor teleport marker: 24px ring 1.25px `--accent` with a 4px centre dot, fades in on hover over the floor; click → 350ms glide. A glass pill top-centre reads "Fly · WASD move · Q/E height · Esc exit".

---

## 7. Motion

```css
:root {
  --dur-instant: 0ms;      /* gizmo drags, scrubbing, marquee — never animate direct manipulation */
  --dur-micro:   120ms;    /* hover tints, icon colour, focus ring                                 */
  --dur-fast:    180ms;    /* segmented thumb, chevron rotate, tab underline, menu open            */
  --dur-base:    220ms;    /* panel collapse, section expand, action bar appear                    */
  --dur-view:    450ms;    /* camera view changes (ViewCube click, F/H, presets)                   */
  --dur-slow:    650ms;    /* card image zoom, catalog cascade, Present-mode dock slide            */
  --dur-glide:   350ms;    /* fly-mode teleport                                                    */

  --ease-standard: cubic-bezier(.4, 0, .2, 1);        /* Veloxity / material — UI micro           */
  --ease-out-expo: cubic-bezier(.22, 1, .36, 1);      /* Molteni — panels, cards, camera          */
  --ease-out-slow: cubic-bezier(.19, 1, .22, 1);      /* Vitra — Present-mode reveals             */
  --ease-in-out-cine: cubic-bezier(.7, 0, .3, 1);     /* Minotti — scene swaps, projection blend  */
}
```

- Hover: colour/opacity changes only (`--dur-micro`); buttons **invert** rather than move; cards zoom 1.03 over `--dur-slow`. No hover shadows, no hover lifts except the catalog card being dragged.
- Press: `transform: scale(.97)` for `--dur-micro`, return on release.
- Panel reveal: docks slide + width over `--dur-base` `--ease-out-expo`; content opacity 0→1 delayed 60ms. Sections expand with height auto via grid-rows trick, `--dur-base`.
- Catalog rail: cards fade+rise 8px with `--animation-order` stagger of 30ms, capped at 12 items, only on first mount and on filter change.
- Viewport: view changes `--dur-view` `--ease-out-expo` with fit-to-view; ortho↔perspective blends the projection matrix over the same duration; scene load fades the vignette layer from opaque `--vp-bg-edge` to transparent over `--dur-slow` `--ease-in-out-cine`; Present mode transitions the whole shell over `--dur-slow` `--ease-out-slow`.
- Never: springs, bounces, overshoot, parallax, cursor trails, scroll-triggered reveals inside the tool, or any animation longer than 650ms except explicit camera tours.
- `prefers-reduced-motion`: all durations → 0 except camera view changes, which drop to 200ms linear.

---

## 8. Iconography

- Style: thin line, **1.25px stroke** on a **20px grid** (24px viewBox scaled), round caps and joins, no fills except tiny state dots; optical size 20px in panels, 16px inside inputs/chips, 24px only in empty states and Present chrome.
- Set: **Lucide** (`lucide-react`, inline SVG, tree-shaken) rendered through a single `<Icon name size={20} strokeWidth={1.25} />` wrapper so stroke and colour are enforced centrally; `currentColor` always. Do not mix in Material/Font Awesome.
- Domain icons drawn in-house on the same grid (stored as inline SVG in `src/ui/icons/`): `led-wall`, `led-poster`, `stage-deck`, `truss`, `content-window`, `pixel-grid`, `view-cube`, `measure-chain`, `calibrate`, `fly`, `teleport`. Match Lucide's 1.25px/round style exactly.
- The up-right arrow (`arrow-up-right`) is the universal "go" glyph on Primary buttons that leave the current context (Veloxity).
- Colour: `--text-2` at rest, `--text-1` on hover, `--accent` when active. Never coloured icons otherwise; axis letters X/Y/Z inside icons use the axis tokens at 60%.

---

## 9. Copywriting tone

- Short, declarative, sentence case. Verb first for actions: "Add to scene", "Frame selection", "Export for print".
- Labels are nouns in tracked uppercase, one or two words: TRANSFORM, PIXEL PITCH, CONTENT, ENVIRONMENT, ROOM.
- Hints teach the gesture, not the concept: "Drag the wall to move it. Hold Shift to lift it."
- Empty states are a serif line + one plain sentence + one action: *Nothing selected.* "Click an object, or press A to select everything."
- Errors say what happened and what to do, never blame: "That file isn't a supported image. Try PNG, JPG or MP4."
- Undo tooltips are built from command labels: "Undo Move LED Wall", "Redo Set pixel pitch".
- Numbers always carry units; feet-inches use prime marks: 12′ 6″. Metric: 3.81 m. Pixel counts use thin-space thousands: 3 840 × 2 160.
- Editorial framing where the client sees it (Present mode, welcome): numbered steps "( 1 ) ( 2 ) ( 3 )", vendor attribution in serif italic, "Discover" over "Buy", "Add to quote" over "Add to cart".
- No exclamation marks, no emoji, no "Oops".

---

## 10. Do's and don'ts

**Do**
- Keep the viewport the brightest, most saturated thing on screen; UI stays achromatic except the accent.
- Use hairlines for structure and whitespace for grouping; reserve shadows for things that float.
- Put every number in the mono face with tabular figures and a muted unit suffix.
- Keep controls at 28px (24px in dense inspector rows) with visible input backgrounds and borders — minimal, not invisible (Figma UI3).
- Animate camera and panels slowly and decelerated; animate direct manipulation not at all.
- Show the shortcut in every tooltip and the tool hint in the status bar.
- Give every destructive action an undo and a toast.
- Sharp edges docked, soft pills floating.

**Don't**
- Don't introduce a second accent, a coloured panel background, or a gradient on any control.
- Don't use bold headings, uppercase above 12px, or type below 10px.
- Don't round the corners of docked panels or rows; don't add borders around thumbnails.
- Don't float panels over the viewport on desktop; don't auto-hide docks on hover.
- Don't use pure black or pure white surfaces; don't render the viewport on a flat colour.
- Don't recolour the axis convention — X red, Y green, Z blue, always.
- Don't use springs, bounces, hover lifts, scroll reveals or skeleton pulses that blink.
- Don't write in Title Case, use exclamation marks, or address the user as "you" in labels.
- Don't hardcode hex values in components — tokens only, and both themes must be checked for every new component.
