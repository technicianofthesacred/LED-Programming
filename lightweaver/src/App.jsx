import { Suspense, lazy, useCallback, useEffect, useState } from 'react';
import { ProjectProvider } from './state/ProjectContext.jsx';
import { TopBar, LeftRail, StatusBar } from './components/Chrome.jsx';
import { KeyboardHelp } from './components/KeyboardHelp.jsx';
import { CommandPalette } from './components/CommandPalette.jsx';
import { useTweaks, TweaksPanel } from './components/Tweaks.jsx';

const LoadingPane = () => <div className="lw-loading-pane">Loading...</div>;

const ChipScreen = lazy(() => import('./components/ChipScreen.jsx').then(m => ({ default: m.ChipScreen })));
const LayoutScreen = lazy(() => import('./components/LayoutScreen.jsx').then(m => ({ default: m.LayoutScreen })));

function screenFromHash() {
  const hash = window.location.hash.slice(1);
  const params = new URLSearchParams(hash.includes('=') ? hash : '');
  const requested = params.get('screen') || 'chip';
  return requested === 'patch' || requested === 'layout' ? 'layout' : 'chip';
}

function replaceScreenHash(screen) {
  const nextHash = `#screen=${screen}`;
  if (window.location.hash === nextHash) return;
  window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}${nextHash}`);
}

export default function App() {
  const [screen, setScreen] = useState(screenFromHash);
  const [kbdOpen, setKbdOpen] = useState(false);
  const [cmdOpen, setCmdOpen] = useState(false);
  const { tweaks, visible, set } = useTweaks();

  const navigate = useCallback((nextScreen) => {
    const normalized = nextScreen === 'layout' || nextScreen === 'patch' ? 'layout' : 'chip';
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
        return;
      }
      if (!event.metaKey && !event.ctrlKey && !event.altKey) {
        if (event.key === '1') navigate('chip');
        if (event.key === '2') navigate('layout');
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [navigate]);

  return (
    <ProjectProvider>
      <div className="lw-app">
        <TopBar/>
        <div className="lw-main">
          <LeftRail screen={screen} onScreen={navigate}/>
          <Suspense fallback={<LoadingPane/>}>
            {screen === 'chip' && <ChipScreen/>}
            {screen === 'layout' && <LayoutScreen/>}
          </Suspense>
        </div>
        <StatusBar/>
        <TweaksPanel tweaks={tweaks} visible={visible} set={set}/>
        <KeyboardHelp open={kbdOpen} onClose={() => setKbdOpen(false)}/>
        <CommandPalette open={cmdOpen} onClose={() => setCmdOpen(false)} navigate={navigate}/>
      </div>
    </ProjectProvider>
  );
}
