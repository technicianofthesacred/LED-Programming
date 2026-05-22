# Smooth Motion Implementation Plan

## Goal
Make very slow Lightweaver pattern changes and crossfades feel continuous in the browser preview and in frames sent to WLED.

## Scope
- Add a shared frame smoothing helper with `off`, `soft`, and `silk` modes.
- Persist the smoothing mode in `.lwproj` project data and migrate legacy projects safely.
- Apply smoothing once in `LEDPreview` so canvas preview and `onFrame` hardware output use the same softened frame.
- Extend Live controls with longer crossfade durations, a numeric crossfade input, finer speed control, and a smoothing segmented control.
- Apply eased transition curves from timeline playback without double-easing in timeline preview.

## Verification
- Add core audit tests for smoothing, crossfade easing, formatting, and persistence.
- Run `npm run test:core`.
- Run `npm run build`.
- Run the Chromium screen smoke tests and inspect the local UI controls.
