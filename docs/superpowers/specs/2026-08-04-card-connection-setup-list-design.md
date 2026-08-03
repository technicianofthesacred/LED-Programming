# Card connection setup list layout

## Problem

The connection popup uses `card-setup-steps` for its three setup instructions. The Card workspace uses that same class for a separate five-stage progress tracker. The workspace grid styles leak into the popup, forcing short instructions into narrow columns and leaving unused grid tracks.

## Design

Give the popup list its own component-specific class. Render its three ordered instructions as one vertical column at every popup width.

Each instruction will:

- occupy the full available width;
- preserve its ordered step number;
- use the existing compact connection-popup typography and spacing tokens;
- wrap normally without splitting words or creating horizontal overflow.

The list will not use the workspace tracker's bordered grid, state styling, or responsive breakpoints. The primary Continue action remains directly below the instructions.

## Scope

Change only the connection popup markup, its scoped styles, and focused browser coverage. The Card workspace five-stage tracker and the connection recovery behavior remain unchanged.

## Responsive contract

- At 320px and 390px viewports, all three instructions stack vertically and remain within the popup.
- At desktop widths, the popup keeps the same vertical instruction order instead of changing to columns.
- The popup, list, and list items must not create horizontal document overflow.
- Existing touch targets and action order remain unchanged.

## Verification

Add a browser regression test that opens setup-network recovery and checks the rendered geometry at phone and desktop widths. It will prove that each list item spans the same usable width, later items begin below earlier items, and the document does not overflow horizontally. Run the focused connection-center suite and production build afterward.
