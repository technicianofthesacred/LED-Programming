import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const appRoot = fileURLToPath(new URL('..', import.meta.url));
let server;
let browser;
let page;

test.before(async () => {
  server = await createServer({
    root: appRoot,
    logLevel: 'silent',
    server: { host: '127.0.0.1', port: 0, strictPort: false },
  });
  await server.listen();
  const address = server.httpServer.address();
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${address.port}/`);
});

test.after(async () => {
  await browser?.close();
  await server?.close();
});

async function inspectSelection(runInteraction) {
  return page.evaluate(async shouldRunInteraction => {
    const { CanvasManager } = await import('/src/canvas.js');
    document.body.innerHTML = `<div style="width:400px;height:240px">
      <svg id="test-canvas" viewBox="0 0 400 240" width="400" height="240">
        <g id="imported-svg"></g>
        <g id="layer-hits"></g>
        <g id="selection-overlay"></g>
        <g id="strips-layer"></g>
        <g id="connections-layer"></g>
      </svg>
    </div>`;

    const manager = new CanvasManager(document.querySelector('#test-canvas'), {
      onStripCreated() {},
      onStripSelected() {},
      onStripDeleted() {},
    });
    manager.addStrip({
      id: 'section-a',
      name: 'Section A',
      pathData: 'M20 120 L380 120',
      color: '#ff6b6b',
    });
    manager.setStripDots(
      'section-a',
      Array.from({ length: 12 }, (_, index) => ({ x: 20 + index * 30, y: 120 })),
    );
    manager.selectStrip('section-a');

    const entry = manager._strips.get('section-a');
    const selected = {
      hasOverlay: Boolean(entry.selectionG),
      display: entry.selectionG?.style.display ?? null,
      index: entry.selectionIndex?.textContent ?? null,
      count: entry.selectionCount?.textContent ?? null,
      cursor: entry.hitPath.style.cursor,
      pointerEvents: entry.selectionG?.getAttribute('pointer-events') ?? null,
    };

    if (!shouldRunInteraction || typeof manager.setZoom !== 'function') {
      return { selected, supportsZoom: typeof manager.setZoom === 'function' };
    }

    manager.setZoom(0.25);
    const far = {
      halo: entry.selectionHalo.getAttribute('stroke-width'),
      transform: entry.selectionBadge.getAttribute('transform'),
    };

    manager.setZoom(4);
    const near = {
      halo: entry.selectionHalo.getAttribute('stroke-width'),
      transform: entry.selectionBadge.getAttribute('transform'),
    };

    entry.hitPath.dispatchEvent(new MouseEvent('mousedown', {
      bubbles: true,
      button: 0,
      clientX: 20,
      clientY: 120,
    }));
    document.dispatchEvent(new MouseEvent('mousemove', {
      bubbles: true,
      clientX: 50,
      clientY: 120,
    }));
    const draggingCursor = document.body.style.cursor;
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
    const releasedCursor = document.body.style.cursor;

    manager.deselectAll();
    const deselected = {
      display: entry.selectionG.style.display,
      cursor: entry.hitPath.style.cursor,
    };

    return {
      selected,
      supportsZoom: true,
      far,
      near,
      draggingCursor,
      releasedCursor,
      deselected,
    };
  }, runInteraction);
}

test('selected LED section exposes a visible non-interactive locator', async () => {
  const result = await inspectSelection(false);

  assert.deepEqual(result.selected, {
    hasOverlay: true,
    display: '',
    index: '1',
    count: '12 LEDs',
    cursor: 'grab',
    pointerEvents: 'none',
  });
});

test('selection appearance and cursors remain stable across zoom and dragging', async () => {
  const result = await inspectSelection(true);

  assert.equal(result.supportsZoom, true);
  assert.equal(result.far.halo, '32');
  assert.match(result.far.transform, /scale\(4\)/);
  assert.equal(result.near.halo, '2');
  assert.match(result.near.transform, /scale\(0\.25\)/);
  assert.equal(result.draggingCursor, 'grabbing');
  assert.equal(result.releasedCursor, '');
  assert.deepEqual(result.deselected, { display: 'none', cursor: 'pointer' });
});

test('mapper zoom controls report the applied zoom to CanvasManager', async () => {
  await page.reload();
  const canvasOverflow = await page.evaluate(() => (
    getComputedStyle(document.querySelector('#drawing-canvas')).overflow
  ));
  await page.evaluate(async () => {
    const { CanvasManager } = await import('/src/canvas.js');
    const originalSetZoom = CanvasManager.prototype.setZoom;
    window.__selectionZoomCalls = [];
    CanvasManager.prototype.setZoom = function setZoomWithObservation(zoom) {
      window.__selectionZoomCalls.push(zoom);
      return originalSetZoom.call(this, zoom);
    };
  });

  await page.dispatchEvent('#btn-zoom-in', 'click');
  const calls = await page.evaluate(() => window.__selectionZoomCalls);

  assert.equal(canvasOverflow, 'visible');
  assert.equal(calls.length, 1);
  assert.ok(calls[0] > 1);
});
