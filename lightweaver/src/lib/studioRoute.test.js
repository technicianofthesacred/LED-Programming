import test from 'node:test';
import assert from 'node:assert/strict';

import {
  canonicalStudioHash,
  cardRouteFromHash,
  createStudioRouteStore,
  DEFAULT_CARD_SECTION,
  isBridgeCallbackHash,
  normalizeStudioView,
  STUDIO_ROUTE_EVENT,
  studioViewFromHash,
} from './studioRoute.js';

const SCREEN_KEYS = ['card', 'layout', 'pattern', 'pattern-lab', 'playlist', 'show', 'discovery'];
const options = { screenKeys: SCREEN_KEYS, fallbackView: 'layout' };

function reconcile(hash) {
  // Exactly what the shell does: the screen is read out of the hash, and the
  // hash is then canonicalized against that same screen. Nothing else is
  // consulted, so there is no stored state that can be stale.
  return canonicalStudioHash(hash, studioViewFromHash(hash, options));
}

function fakeWindow(initialHash = '') {
  const target = new EventTarget();
  const win = {
    location: { pathname: '/', search: '', hash: initialHash },
    history: {
      replaceState(_state, _title, url) {
        const index = String(url).indexOf('#');
        win.location.hash = index === -1 ? '' : String(url).slice(index);
      },
    },
    addEventListener: (type, listener) => target.addEventListener(type, listener),
    removeEventListener: (type, listener) => target.removeEventListener(type, listener),
    dispatchEvent: event => target.dispatchEvent(event),
    // A direct `window.location.hash = …` assignment, which is how twenty-odd
    // screens navigate. The browser delivers hashchange a task later.
    assignHash(next) {
      win.location.hash = next;
      queueMicrotask(() => target.dispatchEvent(new Event('hashchange')));
    },
  };
  return win;
}

test('a screen that navigates by writing the hash keeps the destination it asked for', () => {
  // The regression. A card handoff finishes and writes #screen=pattern while
  // the card workspace is still on screen. Reconciliation must agree with the
  // URL, not overwrite it — whatever was showing a moment ago.
  assert.equal(reconcile('#screen=pattern'), '#screen=pattern');
  assert.equal(studioViewFromHash('#screen=pattern', options), 'pattern');
  assert.equal(reconcile('#screen=layout&mode=wire'), '#screen=layout&mode=wire');
  assert.equal(reconcile('#screen=discovery'), '#screen=discovery');
});

test('reconciling a route is idempotent, so repeating it can never move the owner', () => {
  // The old effect could run any number of times for reasons unrelated to
  // navigation. Under this contract every extra run is a no-op.
  for (const hash of [
    '#screen=pattern',
    '#screen=card&section=setup',
    '#screen=layout&mode=draw',
    '#screen=flash&mode=install',
    '#screen=card&section=nonsense',
    '#screen=pattern&section=install&mode=wire',
    '',
    '#v3',
  ]) {
    const once = reconcile(hash);
    assert.equal(reconcile(once), once, `not idempotent for ${hash || '(empty)'}`);
  }
});

test('the card workspace keeps its section, and defaults only when the hash names none', () => {
  assert.equal(reconcile('#screen=card&section=setup'), '#screen=card&section=setup');
  assert.equal(reconcile('#screen=card&section=install'), '#screen=card&section=install');
  assert.equal(reconcile('#screen=card'), `#screen=card&section=${DEFAULT_CARD_SECTION}`);
  assert.equal(reconcile('#screen=card&section=nonsense'), `#screen=card&section=${DEFAULT_CARD_SECTION}`);
  // A section is meaningless off the card workspace and must not follow the
  // owner onto another screen.
  assert.equal(reconcile('#screen=pattern&section=install'), '#screen=pattern');
});

test('layout keeps its mode deep link and no other screen does', () => {
  assert.equal(reconcile('#screen=layout&mode=wire'), '#screen=layout&mode=wire');
  assert.equal(reconcile('#screen=layout&mode=draw'), '#screen=layout&mode=draw');
  // `install` is not one of the two Layout modes.
  assert.equal(reconcile('#screen=layout&mode=install'), '#screen=layout');
  assert.equal(reconcile('#screen=pattern&mode=wire'), '#screen=pattern');
});

test('legacy card entrances still resolve and are left in the URL as written', () => {
  assert.equal(studioViewFromHash('#screen=flash&mode=install', options), 'card');
  assert.equal(studioViewFromHash('#screen=setup', options), 'card');
  assert.equal(studioViewFromHash('#screen=installer', options), 'card');
  assert.equal(reconcile('#screen=flash&mode=install'), '#screen=flash&mode=install');
  assert.equal(reconcile('#screen=setup'), '#screen=setup');
  assert.deepEqual(cardRouteFromHash('#screen=flash&mode=install'), { section: 'install', supportTool: '' });
  assert.deepEqual(cardRouteFromHash('#screen=setup'), { section: 'setup', supportTool: '' });
  assert.deepEqual(cardRouteFromHash('#screen=installer'), { section: 'support', supportTool: 'guide' });
  assert.deepEqual(cardRouteFromHash('#screen=pattern'), { section: DEFAULT_CARD_SECTION, supportTool: '' });
});

test('a fragment that is not a route does not invent a screen', () => {
  assert.equal(studioViewFromHash('#v3', options), 'layout');
  assert.equal(studioViewFromHash('', options), 'layout');
  assert.equal(studioViewFromHash('#screen=nonsense', options), 'layout');
  assert.equal(studioViewFromHash('#screen=nonsense', { ...options, fallbackView: 'card' }), 'card');
  assert.equal(normalizeStudioView('patterns', options), 'pattern');
});

test('a bridge callback resolves to Layout without naming a screen', () => {
  assert.ok(isBridgeCallbackHash('#bridge-result?operation=install'));
  assert.equal(studioViewFromHash('#bridge-result?operation=install', options), 'layout');
});

test('in-app navigation notifies subscribers synchronously, because replaceState does not', () => {
  // Without this the derived screen would freeze: history.replaceState fires
  // no hashchange, so a rail click would move the URL and nothing else.
  const win = fakeWindow('#screen=layout');
  const store = createStudioRouteStore(win);
  const seen = [];
  const unsubscribe = store.subscribe(() => seen.push(store.read()));

  assert.equal(store.replace('#screen=pattern'), true);
  assert.deepEqual(seen, ['#screen=pattern']);
  assert.equal(store.read(), '#screen=pattern');

  // Navigating to where you already are is not a navigation. It must not
  // notify, and — the leak that made the previous fix unsafe — it must not
  // leave anything armed behind it either.
  assert.equal(store.replace('#screen=pattern'), false);
  assert.deepEqual(seen, ['#screen=pattern']);
  assert.equal(store.replace('#screen=layout'), true);
  assert.deepEqual(seen, ['#screen=pattern', '#screen=layout']);

  unsubscribe();
  store.replace('#screen=show');
  assert.deepEqual(seen, ['#screen=pattern', '#screen=layout']);
});

test('a direct hash assignment reaches subscribers, one task later, with the URL already moved', async () => {
  const win = fakeWindow('#screen=card&section=overview');
  const store = createStudioRouteStore(win);
  const seen = [];
  store.subscribe(() => seen.push(store.read()));

  win.assignHash('#screen=pattern');
  // The window in which the old shell overwrote the destination: the URL has
  // moved, the listener has not run yet. Reconciling here must still agree
  // with the URL.
  assert.equal(store.read(), '#screen=pattern');
  assert.equal(reconcile(store.read()), '#screen=pattern');
  assert.deepEqual(seen, []);

  await new Promise(resolve => queueMicrotask(resolve));
  assert.deepEqual(seen, ['#screen=pattern']);
});
