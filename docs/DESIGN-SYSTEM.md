# Design system

The canonical reference is **`docs/reference/portal-mockup.html`** — the mockup the
owner designed and approved before any code was written. Open it in a browser.
When this document and that file disagree, **the mockup wins**, and this document
is what needs fixing.

What shipped in Phases 2–8 borrowed the mockup's *palette* and almost none of its
*composition*. The owner's verdict on seeing it: "super klunky, it looks NOTHING
like what I presented." That is a fair reading and this document exists to close it.

---

## 1. What actually went wrong

The colors were right. Everything about how the page is built was not.

| | Mockup | What shipped |
|---|---|---|
| Shell | Fixed 54 px bar, full-height views, page never scrolls | Browser-scrolled document |
| Width | Full bleed to 1280 px | `max-w-5xl` centered column |
| Base size | 13.5 px, dense | ~16 px, airy |
| Nav | Tab pills in the bar, gradient when active | Text links |
| KPI | Colored left rail, gradient wash, 23 px mono value, breakdown line, inline badge | Plain bordered box, small text |
| Cards | `.hd` / `.bd` / `.note` with a dashed footer rule | One undifferentiated box |
| Headline | A written finding with the numbers in the sentence | Nothing |
| Chrome | Live status dot, alert pill, clock, toasts, blurred drawers | None |

The single biggest difference is **density and hierarchy**. The mockup is an
instrument panel a manager leaves open on a wall all day. What shipped reads like
a settings page.

---

## 2. Tokens

Copied exactly from the mockup's `:root`. `apps/web/app/globals.css` already carries
most of these; the ones it is missing are marked **NEW**.

```css
--bg:#0b0e12;  --bg2:#0f1319;  --panel:rgba(23,28,35,.92);  /* NEW: translucent, for blurred overlays */
--panel-solid:#171c23;  --card:#151a21;                     /* NEW: card is DARKER than panel */
--line:rgba(255,255,255,.07);  --line2:rgba(255,255,255,.13);
--ink:#eaeef2;  --ink2:#9aa5b0;  --ink3:#5d6873;            /* three ink levels, not two */
--ok:#2dd4a7;  --warn:#f5a623;  --crit:#ff5c38;  --off:#8b939b;
--sel:#4da3ff;  --hay:#e8b64c;  --water:#4fb3d9;  --truck:#ffc24d;   /* sel/off/truck NEW */
```

Semantic rule (CLAUDE.md #4) is unchanged and still binding: `ok` is live data and
positive state, `crit` only when something is actually wrong, `hay` only for
projections, `water` only for liquid measurement, `sel` only for the current
selection. None of them are decorative.

### Type

The mockup uses **Instrument Sans** (400–800) and **IBM Plex Mono** (400–600).
What shipped uses Inter Tight, Archivo, and JetBrains Mono. **Switch to the
mockup's pair.** Load them the Next.js way via `next/font/google`, not the
mockup's `<link>` — self-hosting avoids a render-blocking third-party request
and there is no CDN allowance in this stack.

Base is `13.5px`. Numbers are mono with `tabular-nums`. Micro-labels are
`10.5px`, `letter-spacing:.08em`, `text-transform:uppercase`, `font-weight:700`,
in `--ink3`.

---

## 3. The primitives to build

These live in `packages/ui`. Every screen composes from them; no screen
hand-rolls a card.

**AppShell** — `display:grid; grid-template-rows:54px 1fr; height:100vh` with
`body{overflow:hidden}`. Views scroll inside, the page does not. The bar holds:
brand mark (28 px rounded square, `linear-gradient(135deg,#2dd4a7,#178f70)`, dark
glyph, teal glow), tab pills, then right-aligned: alert pill, a live status stat
with a glowing dot, and a clock.

**TabPills** — a container with `background:rgba(255,255,255,.05)`, 1 px line,
`border-radius:10px`, `padding:3px`. Active pill gets the teal gradient, dark
text, and a soft glow. This replaces the current text-link nav.

**Kpi** — the signature element. Left rail `::before` 3 px wide, inset 12 px top
and bottom, colored by an `--acc` custom property set per instance. Background is
`linear-gradient(180deg,rgba(255,255,255,.03),transparent 55%)` over `--card`.
Hover lifts 2 px and brightens the border. Contents: uppercase micro-label
(optionally with a `Badge` pushed right), a 23 px mono value with an optional
small unit, and an `--ink2` sub-line carrying the breakdown.

**Card** — `.hd` (title + optional sub or legend, bottom rule), `.bd` (16 px pad),
and an optional `.note` footer separated by a **dashed** rule for the caveat or
the model-accuracy line. The dashed rule is the tell that distinguishes a fact
from a footnote; keep it.

**Callout** — horizontal gradient wash in the severity color, 32 px glowing icon
chip, and body text in full sentences with the numbers bolded inline. Used for
the one finding that matters most on a screen.

**Badge** — `9.5px`, weight 800, pill, 14–16% tint of its semantic color.

**DataTable** — uppercase micro-headers, 8.5 px row padding, hairline rules, row
hover at 2.5% white, `.mono` and `.r` column modifiers.

**ActivityRow** — colored status dot, entity code in bold, mono timestamp pushed
right. Dense: 8–9 px vertical padding.

**Tile** — for trough/sensor grids. `minmax(96px,1fr)` auto-fill, mono id, 16 px
mono value, a 4 px fill bar, and state-colored border and tint for crit / warn /
overflow / offline.

**Drawer, Toast, Modal** — `--panel` with `backdrop-filter:blur(10–14px)`, 1 px
`--line2`, deep shadow. Drawer animates on
`cubic-bezier(.2,.9,.3,1)` from `translateY(-8px) scale(.98)`.

**Button** — `.btn` outlined by default; `.btn.pri` takes the teal gradient with
dark text.

---

## 4. Voice on screen

The mockup opens with **"Good morning — here's the tally"** and a one-line
situation summary: facility, location, head count, what the crew is doing right
now, gate state. Then it leads with a written finding, not a chart:

> **Forecast flag — hay runs out ~9 weeks before first cutting.** Flat math says
> your 805 bales (≈604 tons) last to **Mar 18**. The model knows winter burn runs
> higher (last winter: +19% Dec–Feb) and projects empty on **Feb 24** … Gap ≈
> **250 bales**. **Secure a winter hay contract by mid-January.**

That is the product having a point of view: it states the number, states the
better number, explains the difference, and says what to do about it. Screens
should open with the answer, not with a grid of metrics the reader has to
interpret.

This does **not** override CLAUDE.md #5 (rancher vocabulary, banned words) or #8
(honest numbers). It sharpens them.

---

## 5. Order of work

1. Fonts and the missing tokens — cheapest, changes the feel immediately.
2. `AppShell` + `TabPills`, applied in `app/(app)/layout.tsx`. Kills the
   centered-column look in one move.
3. `Kpi`, `Card`, `Badge`, `Callout` in `packages/ui`; convert the farm overview.
4. `DataTable`, `ActivityRow`, `Tile`; convert feed, water, movement, alerts.
5. Map view chrome: layer rail with toggle switches, zoom control, HUD scale bar,
   device drawer.
6. Toasts and the live status/clock in the bar.

Do **not** change what a number means while re-skinning it. Presentation and
correctness are separate passes on purpose — the numbers are being fixed
concurrently, and a re-skin that also edits a calculation makes both
unreviewable.
