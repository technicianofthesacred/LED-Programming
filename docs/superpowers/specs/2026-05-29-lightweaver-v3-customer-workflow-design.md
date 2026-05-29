# Lightweaver V3 Customer Workflow Design

## Goal

Lightweaver V3 should open as a customer-ready tool for choosing visual patterns, changing colors and motion, assigning those choices to sections, saving complete Looks, and loading the result onto the card.

## Core Model

- A **Pattern** is one chip-ready lighting effect, such as Aurora, Fire, Ocean, Scanner, or Warm White.
- A **Section** is one controllable physical or visual area, such as Outer circle, Inner circle, an imported SVG layer, or a chopped patch.
- A **Look** is the customer-saveable unit. It captures the global default plus per-section pattern, color, brightness, speed, hue shift, breathe, and drift settings.
- **Load** is the final hardware/export screen. It should not be the main place where customers design colors or section assignments.

## Screen Responsibilities

### Patterns

Patterns becomes the primary design workspace.

It must expose:

- visual pattern cards from the chip-ready bank
- live preview before save
- target selector for All sections and each section
- color swatches, hue, saturation, brightness, speed, hue shift, breathe, and drift controls
- saved Looks list
- knob cycle controls
- card host, preview, copy, download, and save actions

Selecting a section scopes changes to that section. Selecting All applies the same visual settings across every section.

### Layout

Layout owns physical structure:

- default rings
- SVG import
- section count
- section LED counts
- imported sections
- chopped physical zones

Any section created in Layout must appear automatically in Patterns and Load.

### Load

Load becomes a final review and export surface:

- copy/download/push config
- hardware LED count
- output/pin setup
- brightness/color-order limits
- read-only summary of saved Looks, startup Look, knob cycle, and sections

Load may keep hardware editing because those values are needed at install time. It should link users back to Patterns or Layout for design changes.

## Data Flow

The app uses one section/look model:

1. Layout creates strips and patch board patches.
2. The section/look model derives selectable targets from the patch board.
3. Patterns edits the selected target's visual Look.
4. Saving writes the Look to `standaloneController` and the target playback values to the patch board.
5. Export serializes the current saved Look and zones through `buildCardRuntimePackageFromProject()`.

## Limits

Chip-ready V3 supports up to eight sections because the firmware runtime currently clamps zones to eight. The UI must make that visible instead of silently implying unlimited card sections.

## Verification

The workflow is considered working when:

- a new project starts with Outer circle and Inner circle sections
- adding sections to the default layout makes them appear in Patterns and Load
- choosing a section in Patterns scopes pattern/color/tuning changes to that section
- saving creates a named Look
- export writes the per-section settings into `config.zones[]`
- Load shows the result as review/export, not a second pattern editor
