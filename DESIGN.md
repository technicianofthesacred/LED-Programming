---
version: alpha
name: Lightweaver
description: >-
  LED installation controller for laser-cut art. A pro creative tool that gets
  out of the way — cool-tinted dark minimalism, dense but legible, one accent
  used sparingly. The preview is the hero; the chrome is invisible.
colors:
  primary: "oklch(74% 0.13 210)"      # cyan / bright blue — the accent
  primary-alt: "oklch(80% 0.13 70)"   # yellow-green secondary
  background: "oklch(16% 0.008 260)"  # very dark cool neutral
  surface: "oklch(20% 0.010 260)"
  surface-2: "oklch(24% 0.012 260)"
  surface-3: "oklch(28% 0.014 260)"
  border: "oklch(30% 0.012 260)"
  border-strong: "oklch(36% 0.014 260)"
  on-background: "oklch(96% 0.004 260)" # near-white cool
  on-surface-secondary: "oklch(78% 0.006 260)"
  on-surface-dim: "oklch(66% 0.008 260)"
  on-surface-faint: "oklch(54% 0.008 260)"
  preview-bg: "oklch(8% 0.006 260)"   # ultra-dark preview stage
  danger: "oklch(64% 0.20 25)"        # red-orange
  mint: "oklch(78% 0.15 155)"         # bright mint
typography:
  display:
    fontFamily: Geist
    fontSize: 1.75rem
    fontWeight: 500
    lineHeight: 1.2
  xl:
    fontFamily: Geist
    fontSize: 1.25rem
    fontWeight: 500
  lg:
    fontFamily: Geist
    fontSize: 1rem
    fontWeight: 400
  body:
    fontFamily: Geist
    fontSize: 0.8125rem
    fontWeight: 400
    lineHeight: 1.5
  sm:
    fontFamily: Geist
    fontSize: 0.6875rem
    fontWeight: 400
  data:
    fontFamily: Geist Mono
    fontSize: 0.8125rem
    fontWeight: 400
  micro:
    fontFamily: Geist Mono
    fontSize: 0.625rem
    fontWeight: 400
rounded:
  sm: 3px
  md: 5px
  lg: 8px
spacing:
  "1": 2px
  "2": 4px
  "3": 6px
  "4": 8px
  "5": 12px
  "6": 16px
  "7": 20px
  "8": 24px
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.background}"
    rounded: "{rounded.md}"
    padding: 8px
  panel:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.lg}"
    padding: 16px
---

## Overview

Lightweaver is a custom LED lighting control platform for laser-cut art
installations. The brand is **artistic, refined, high-tech — and intentionally
invisible.** It is a working artist's tool, not a consumer product: the
interface is a lens to the LED artwork, dense with state, easy to read, and it
gets out of the way so the work is the focus. Reference points are pro creative
tools — the restraint of Figma, the information density of Ableton, the dark
chrome of DaVinci Resolve. Dark is the default (eye comfort beside bright LED
output); a light mode exists for daytime. A separate, warmer captive-portal page
greets installation visitors — that surface is deliberately distinct from this
pro studio chrome.

## Colors

Cool-tinted near-neutrals (hue ~260) with one bright accent.

- **Cyan/blue (primary):** The single accent — active state, selection, the live
  signal. Used sparingly; one accent in a frame.
- **Yellow-green (secondary):** A second functional signal when one accent isn't
  enough. Still restrained.
- **Dark cool grounds (background to surface-3):** Layered near-black neutrals
  that build depth without ornament.
- **Cool whites and grays (text steps):** Four steps from near-white down to
  faint, so dense data stays legible.
- **Preview ground (#ultra-dark):** The darkest stage, reserved for the LED
  preview so the rendered light reads true.
- **Mint / red-orange (mint, danger):** Functional status only — running / fault.

Accent is signal, never decoration. If a color isn't carrying meaning, it
shouldn't be there.

## Typography

One family, two cuts — sans for chrome, mono for data.

- **Geist** — all interface text, labels, headings. Neo-grotesque with strong
  numerals and tight metrics; chosen over reflexive defaults for pro-tool
  character.
- **Geist Mono** — numeric data, channel values, codes, fine technical readouts.

The type scale runs small and dense (down to 9px micro) because this is a
data-dense control surface, not a reading experience. Hierarchy comes from size
and weight, never from cramming large display type.

## Layout

Dense but legible. A tight spacing scale (2px to 24px) multiplied by a density
factor. The LED preview is the hero and gets the most space; controls pack
efficiently around it. Information density over whitespace — but every value
stays readable.

## Elevation & Depth

Sparing, cool shadows (`oklch(0% 0 0 / 0.4)` resting, 0.6 for strong) and
layered surface steps build depth. Used minimally — the tool is flat and
functional, not glossy.

## Shapes

Tight corners: 3px small chrome, 5px controls, 8px panels. Sharp and precise,
matching a professional instrument.

## Components

- **Primary button:** Cyan fill, dark text, 5px corners, compact 8px padding.
- **Panel:** Surface fill, 8px corners, 16px padding.

## Do's and Don'ts

- **Do** let the LED preview be the hero and keep chrome quiet around it.
- **Do** use one accent at a time, only to carry meaning (active, live, fault).
- **Do** keep the interface dense, legible, and out of the way.
- **Do** use Geist Mono for all numeric/technical data.
- **Don't** go cyberpunk, neon, or theatrical — refined, not flashy.
- **Don't** add ornament, glassmorphism, or decorative color.
- **Don't** confuse this pro studio look with the warmer visitor captive-portal
  page — they are intentionally different surfaces.
