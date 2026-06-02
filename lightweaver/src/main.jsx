import { createRoot } from 'react-dom/client';
import './main.css';
// Verbatim v3 design CSS (the mockup's own stylesheets, unmodified) — the source
// of truth for the v3 look. Screens are rebuilt to the mockup's exact class names
// so they inherit this styling directly, not a paraphrase of it.
import './styles/v3-mock-styles.css';
import './styles/v3-mock-screens.css';
// Live-only Layout controls (Light disclosure, per-strip expander) in the mock idiom.
import './styles/v3-layout-extra.css';
// Live-only Playlist bits (status bar, combo thumbs, drag feedback) in the mock idiom.
import './styles/v3-playlist-extra.css';
// Live-only Patterns controls (status strip, target tabs, Advanced disclosure) in the mock idiom.
import './styles/v3-patterns-extra.css';
import App from './App.jsx';

createRoot(document.getElementById('root')).render(<App />);
