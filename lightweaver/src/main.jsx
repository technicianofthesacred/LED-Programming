import { createRoot } from 'react-dom/client';
// Exact v3 design: the mockup's own verbatim CSS + its own component files
// (converted to ES modules, bodies unchanged). This IS the code that renders
// /v3-mock/, so the look is guaranteed identical. Real-data wiring is layered
// on top of these exact components, not a rebuild of them.
import './v3/v3-styles.css';
import './v3/v3-screens.css';
import App from './v3/app.jsx';

createRoot(document.getElementById('root')).render(<App />);
