# Lightweaver — design context

## Design Context

### Users
Artist/operator (the maker of the installation) using a desktop computer to design LED patterns and drive a gallery installation via WLED / Art-Net. Sessions happen in a daytime studio and occasionally at night next to the hardware. Later, a separate visitor UI will live inside the installation — that is a different surface with a different brief and is out of scope here.

### Brand Personality
**Artistic. Refined. High-tech.** The reference is "software that works really well, easy to read, easy to use — doesn't stand out." Function-first. Clean and polished, but the tool itself gets out of the way so the *work* (the LED art) is the focus. Think pro creative tooling (DaVinci Resolve's UI chrome, Ableton's info-density, Figma's restraint) — not marketing-site flair.

### Aesthetic Direction
- **Dark theme is the default** — operator tool sitting next to vivid LED output; neutral dark surroundings let the preview pop and avoid eye fatigue in dim installation spaces. Offer a light mode for daytime studio use.
- **Cool-tinted neutrals** (hue ~260) already in place — keep this; it subconsciously cohered the UI to the LED/tech context without being "cyberpunk."
- **Restrained accent use** — one accent color doing real work (selection, active state, destructive confirms), not sprinkled decoratively.
- **Information density over whitespace** — this is a professional tool, not a landing page. Compact rows, tight line-heights in panels, generous space only where hierarchy demands it.
- **No ornament** — no gradient text, no stripe borders, no glassmorphism as decoration, no icon-above-every-heading. If it doesn't serve function or hierarchy, it shouldn't ship.

### Anti-references
- Marketing-site aesthetics (hero gradients, oversized type, centered everything).
- "Designy" creative tools that sacrifice legibility for vibe.
- The AI-generated-dashboard look: cyan-on-dark, neon purple→blue gradients, glowing cards.
- Inter + Instrument Serif reflex pairing (too common — see font choice below).

### Design Principles
1. **Function first, ornament never.** Every visual decision must earn its place by improving legibility, scannability, or state awareness.
2. **The preview is the hero.** UI chrome exists to frame the LED preview and pattern editors; it should never compete for attention.
3. **Dense but legible.** Prefer more information visible at once over generous padding. Use weight, color, and spacing contrast — not whitespace — to create hierarchy.
4. **One accent, used sparingly.** Accents signal state (selected, active, destructive), not decoration. If everything is emphasized, nothing is.
5. **Consistent tokens end-to-end.** No hard-coded `#fff` / `#000` / `rgba()` values — everything flows through the OKLCH palette so themes and tweaks stay coherent.

### Typography direction
Current pairing (Inter + Instrument Serif + JetBrains Mono) sits on the reflex-reject list. Replace with a distinctive trio that fits a pro creative tool:
- **UI/body**: a neo-grotesque with strong numerals and tight metrics — candidates: **Söhne**, **ABC Diatype**, **Neue Haas Grotesk**, or free alternatives **General Sans**, **Geist Sans**, **Manrope**. Avoid Inter/DM Sans/Plus Jakarta/Outfit.
- **Mono**: something with character for the code editor — **Berkeley Mono**, **Commit Mono**, **Geist Mono**, or **Monaspace Neon**. Avoid JetBrains Mono / IBM Plex Mono / Space Mono.
- **Display** (sparingly, for branded surfaces only): optional; prefer no display face in the tool itself — keep it single-family for operator mode.

### Theme
Dark default, light mode available. Both use the same cool-tinted (h≈260) neutral palette; only lightness flips.
