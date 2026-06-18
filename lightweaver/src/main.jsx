import { createRoot } from 'react-dom/client';
// Exact v3 design: the mockup's own verbatim CSS + its own component files
// (converted to ES modules, bodies unchanged). This IS the code that renders
// /v3-mock/, so the look is guaranteed identical. Real-data wiring is layered
// on top of these exact components, not a rebuild of them.
import './v3/v3-styles.css';
import './v3/v3-screens.css';
// Live-only Layout controls (Light disclosure, per-strip expander, wire editor,
// canvas wire overlay, marching-ants) in the v3 token idiom. The real-engine
// Layout screen renders the exact mockup markup + these classes.
import './styles/v3-layout-extra.css';
// Live-only Settings widgets (card connection actions + status banner, ring
// hardware summary, project library rows, hardware layout editor lists,
// advanced JSON disclosure) in the v3 token idiom. The six mockup cards still
// use the mockup's own .set-* classes; these only style genuinely live-only UI.
import './styles/v3-settings-extra.css';
// Live-only Patterns controls (connection/repair status strip, multi-section
// target tabs, Advanced disclosure, live card summary, load-more / empty state)
// — the .pmx-*/.tc-* classes lw-pattern.jsx emits that the static mockup has no
// slot for. Without this import those controls render unstyled.
import './styles/v3-patterns-extra.css';
// Live-only Playlist controls (.pl-* status / row extras) in the v3 token idiom.
import './styles/v3-playlist-extra.css';
import App from './v3/app.jsx';

// Version switch. The 3.3 redesign is the default. The previous interface
// (version 3) is preserved verbatim under ./src-v3 and stays reachable at
// ?v=3 (or #v3) so nothing is lost — it loads on demand, so it adds nothing
// to the default bundle.
const params = new URLSearchParams(window.location.search);
const wantsV3 = params.get('v') === '3' || window.location.hash === '#v3';

const root = createRoot(document.getElementById('root'));

if (wantsV3) {
  // Frozen previous interface — its own self-contained tree, untouched by 3.3.
  // Pull its stylesheet in the same on-demand chunk so it renders styled.
  Promise.all([
    import('../src-v3/main.css'),
    import('../src-v3/App.jsx'),
  ]).then(([, m]) => {
    root.render(<m.default />);
  });
} else {
  root.render(<App />);
}
