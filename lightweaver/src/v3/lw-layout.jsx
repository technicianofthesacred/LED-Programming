/* Light Weaver v3 — Layout screen (full SVG → strip workflow)
 *
 * This screen is the one place where the v3 mockup and the live app converge on
 * the SAME visual component. The mockup's LayoutScreen (hardcoded sample layers,
 * local-only state, a sample-path Canvas) was ported into the real engine at
 * src/components/LayoutScreen.jsx WITHOUT changing its look: identical class
 * names (.la / .toolbar / .tb-btn / .la-compass / .la-overlay / .side /
 * .inspector / .la-pathsel / .la-strip-row / .la-wire), the same warm strand
 * rendering, the same dotgrid + stage, the same Compass dial, and the same clay
 * corner-tick selection frame. It declares the three SVG filters the warm canvas
 * uses (lw-led-bloom, lw-light-glow, heat-grad) and carries the orphan decisions
 * (Light disclosure for glow-mode + directed-glow, per-strip expander, wire-path
 * read-only list PLUS the interactive PatchBoard editor in a disclosure).
 *
 * So the real data + real handlers (SVG import + drag-drop, layers / sub-paths /
 * groups, path selection merge/separate/strip-group/layer-group, strip
 * resample, density change, emit/angle compass, add/update/remove/reverse/
 * duplicate/hide strip, draw/chop/link, lasso, pan/zoom, undo/redo, wire route)
 * already live behind that exact visual frame, sourced from useProject(). The v3
 * shell (src/v3/app.jsx) wraps everything in ProjectProvider, so useProject() is
 * available here.
 *
 * We re-export that real, wired component as the v3 LayoutScreen rather than
 * keep a second divergent copy of the markup. The look stays pixel-exact (it is
 * the mockup's own JSX) and the screen is now the user's real layout with real
 * import / strips / editing. The live-only controls are styled by
 * styles/v3-layout-extra.css (imported in main.jsx) in the v3 token idiom.
 */
export { LayoutScreen } from '../components/LayoutScreen.jsx';
