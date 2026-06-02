import { Suspense, lazy, useCallback, useEffect, useState } from 'react';
import { ProjectProvider } from './state/ProjectContext.jsx';
import { TopBar, LeftRail, StatusBar } from './components/Chrome.jsx';
import { KeyboardHelp } from './components/KeyboardHelp.jsx';
import { CommandPalette } from './components/CommandPalette.jsx';
import { useTweaks, TweaksPanel } from './components/Tweaks.jsx';

const LoadingPane = () => <div className="lw-loading-pane">Loading...</div>;

const ChipScreen = lazy(() => import('./components/ChipScreen.jsx').then(m => ({ default: m.ChipScreen })));
const LayoutScreen = lazy(() => import('./components/LayoutScreen.jsx').then(m => ({ default: m.LayoutScreen })));
const PatternsScreen = lazy(() => import('./components/PatternsScreen.jsx').then(m => ({ default: m.PatternsScreen })));
const PlaylistScreen = lazy(() => import('./components/PlaylistScreen.jsx').then(m => ({ default: m.PlaylistScreen })));
const FlashScreen = lazy(() => import('./components/OtherScreens.jsx').then(m => ({ default: m.FlashScreen })));
const InstallerScreen = lazy(() => import('./components/InstallerScreen.jsx').then(m => ({ default: m.InstallerScreen })));

function normalizeScreen(requested = '') {
  const screen = String(requested || '').trim().toLowerCase();
  if (screen === 'layout' || screen === 'patch') return 'layout';
  if (screen === 'installer' || screen === 'install' || screen === 'directions' || screen === 'setup') return 'installer';
  if (screen === 'flash') return 'flash';
  if (screen === 'chip' || screen === 'load' || screen === 'export' || screen === 'devices' || screen === 'settings') return 'settings';
  if (screen === 'playlist' || screen === 'knob' || screen === 'cycle') return 'playlist';
  if (screen === 'pattern' || screen === 'patterns' || screen === 'look' || screen === 'looks') return 'patterns';
  return 'patterns';
}

function screenFromHash() {
  const hash = window.location.hash.slice(1);
  const params = new URLSearchParams(hash.includes('=') ? hash : '');
  return normalizeScreen(params.get('screen') || 'patterns');
}

function replaceScreenHash(screen) {
  const nextHash = `#screen=${screen}`;
  if (window.location.hash === nextHash) return;
  window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}${nextHash}`);
}

function isEditableNumberInput(target) {
  return target instanceof HTMLInputElement
    && target.type === 'number'
    && !target.disabled
    && !target.readOnly;
}

function selectNumberInputValue(input) {
  try {
    input.select();
  } catch {
    // Some browsers can refuse selection APIs on specialized inputs.
  }
}

export default function App() {
  const [screen, setScreen] = useState(screenFromHash);
  const [kbdOpen, setKbdOpen] = useState(false);
  const [cmdOpen, setCmdOpen] = useState(false);
  const { tweaks, visible, set } = useTweaks();

  const navigate = useCallback((nextScreen) => {
    const normalized = normalizeScreen(nextScreen);
    setScreen(normalized);
    setKbdOpen(false);
    setCmdOpen(false);
  }, []);

  useEffect(() => {
    replaceScreenHash(screen);
  }, [screen]);

  useEffect(() => {
    const handleHashChange = () => {
      const nextScreen = screenFromHash();
      setScreen(nextScreen);
      replaceScreenHash(nextScreen);
    };
    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, []);

  useEffect(() => {
    const handler = (event) => {
      const target = event.target;
      if (target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable) return;

      if (event.key === '?') {
        setKbdOpen(open => !open);
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setCmdOpen(open => !open);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [navigate]);

  useEffect(() => {
    const handleNumberFocus = (event) => {
      if (!isEditableNumberInput(event.target)) return;
      window.setTimeout(() => selectNumberInputValue(event.target), 0);
    };
    const handleNumberClick = (event) => {
      if (!isEditableNumberInput(event.target)) return;
      selectNumberInputValue(event.target);
    };
    const handleNumberMouseUp = (event) => {
      if (!isEditableNumberInput(event.target)) return;
      event.preventDefault();
      selectNumberInputValue(event.target);
    };

    document.addEventListener('focusin', handleNumberFocus, true);
    document.addEventListener('mouseup', handleNumberMouseUp, true);
    document.addEventListener('click', handleNumberClick, true);
    return () => {
      document.removeEventListener('focusin', handleNumberFocus, true);
      document.removeEventListener('mouseup', handleNumberMouseUp, true);
      document.removeEventListener('click', handleNumberClick, true);
    };
  }, []);

  return (
    <ProjectProvider>
      <div className="lw-app">
        <TopBar/>
        <div className="lw-main">
          <LeftRail screen={screen} onScreen={navigate}/>
          <Suspense fallback={<LoadingPane/>}>
            {screen === 'patterns' && <PatternsScreen/>}
            {screen === 'playlist' && <PlaylistScreen/>}
            {screen === 'layout' && <LayoutScreen/>}
            {screen === 'settings' && <ChipScreen/>}
            {screen === 'flash' && <FlashScreen/>}
            {screen === 'installer' && <InstallerScreen/>}
          </Suspense>
        </div>
        <StatusBar screen={screen}/>
        <TweaksPanel tweaks={tweaks} visible={visible} set={set}/>
        <KeyboardHelp open={kbdOpen} onClose={() => setKbdOpen(false)}/>
        <CommandPalette open={cmdOpen} onClose={() => setCmdOpen(false)}/>
      </div>
    </ProjectProvider>
  );
}
