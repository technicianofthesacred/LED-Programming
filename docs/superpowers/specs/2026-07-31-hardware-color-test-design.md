# Hardware color test

## Goal

Make the controls for the physical Lightweaver controller easy to find and let an installer correct LED channel order without entering the full wiring-verification wizard.

## Navigation and language

- Rename the top-level **Card** section to **Hardware**.
- Use **card** only when copy specifically refers to the physical Lightweaver controller or an action performed on it, such as “Install on card.”
- Keep routes, stored project data, APIs, and compatibility identifiers unchanged; this is a UI label change, not a data migration.

## Hardware color test

Add a compact **Test LED colors** control to the Hardware section:

- Four live buttons: **Red**, **Green**, **Blue**, and **White**.
- A tap sends a dim, power-limited full-strip test to the connected physical LEDs.
- White is an equal RGB test for RGB/WS2815 strips; it does not imply a separate white channel.
- Show the active color order and allow all six RGB permutations: RGB, RBG, GRB, GBR, BRG, and BGR.
- Changing the order previews it immediately and reruns the currently selected color.
- **Confirm color order** remains disabled until the current order has completed a successful live test.
- Include **Stop lights** and clear connected, sending, success, and failure feedback.

Reuse the existing `StripColorOrderCheck` behavior so Hardware and Test & Install share one implementation and cannot drift.

## Existing installation flow

Retain the color-order check in **Layout → Test & Install**. The Hardware copy is the fast troubleshooting and commissioning entry point; the existing wizard remains the guided full-installation path.

## Verification

- Unit coverage for the renamed navigation label and the shared Hardware color-test entry.
- Existing color-order behavior tests must still pass.
- Browser test: Hardware is reachable directly, each color button sends its matching physical test, order changes preview live, and confirmation cannot occur before successful delivery.
- Build and launch checks must pass before deployment.
