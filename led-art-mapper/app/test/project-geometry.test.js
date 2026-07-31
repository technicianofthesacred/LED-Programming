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
    server: { host: '127.0.0.1', port: 0 },
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

test('Chromium geometry preflight rejects unusable SVG paths before project load', async () => {
  const results = await page.evaluate(async () => {
    const {
      MAPPER_PROJECT_FORMAT,
      MAPPER_PROJECT_SCHEMA_VERSION,
      preflightMapperProjectGeometry,
      validateMapperProject,
    } = await import('/src/project-format.js');
    const candidate = {
      format: MAPPER_PROJECT_FORMAT,
      schemaVersion: MAPPER_PROJECT_SCHEMA_VERSION,
      strips: [{ id: 'broken', pathData: 'not SVG', pixelCount: 12 }],
    };
    const structural = validateMapperProject(candidate);
    const geometry = preflightMapperProjectGeometry(structural.project, document);
    const valid = preflightMapperProjectGeometry({
      ...structural.project,
      strips: [{ id: 'valid', pathData: 'M0 0 L100 0', pixelCount: 12 }],
    }, document);
    return { structural, geometry, valid };
  });

  assert.equal(results.structural.ok, true, 'Node-safe validation remains structural');
  assert.equal(results.geometry.ok, false);
  assert.match(results.geometry.reason, /section 1.*usable SVG path/i);
  assert.equal(results.valid.ok, true);
});

test('project load strips executable SVG and renders imported labels as text', async () => {
  const stripName = '<img src=x onerror="window.__mapperImportExecuted += 10"> Strip';
  const patternName = '<img src=x onerror="window.__mapperImportExecuted += 100"> Pattern';
  const candidate = {
    format: 'lightweaver.mapper-project',
    schemaVersion: 3,
    svgSource: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"
      onload="window.__mapperImportExecuted += 1">
      <script>window.__mapperImportExecuted += 1000</script>
      <foreignObject><div xmlns="http://www.w3.org/1999/xhtml">
        <img src="x" onerror="window.__mapperImportExecuted += 10000" />
      </div></foreignObject>
      <g id="art" data-name="Artwork" onclick="window.__mapperImportExecuted += 100000">
        <path d="M0 0 L100 0" style="fill:url(javascript:alert(1))" />
        <use href="javascript:window.__mapperImportExecuted += 1000000" />
      </g>
    </svg>`,
    strips: [{
      id: 'outer',
      name: stripName,
      pathData: 'M0 0 L100 0',
      pixelCount: 12,
      color: '#06d6a0',
    }],
    patterns: [{
      id: 'safe-pattern',
      name: patternName,
      code: 'return { r: 0, g: 0, b: 0 };',
    }],
    activePatternId: 'safe-pattern',
  };

  await page.evaluate(() => {
    window.__mapperImportExecuted = 0;
  });
  const chooserPromise = page.waitForEvent('filechooser');
  await page.click('#btn-load');
  const chooser = await chooserPromise;
  await chooser.setFiles({
    name: 'hostile-project.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(candidate)),
  });
  await page.waitForSelector('#confirm-overlay:not(.hidden)');
  await page.click('#confirm-ok');
  await page.waitForTimeout(150);

  const result = await page.evaluate(() => {
    const imported = document.querySelector('#imported-svg');
    const dangerousAttribute = imported
      ? [...imported.querySelectorAll('*')].some(element => (
          [...element.attributes].some(attribute => (
            attribute.name.toLowerCase().startsWith('on')
            || /(?:javascript:|https?:|url\((?!#))/i.test(attribute.value)
          ))
        ))
      : true;
    return {
      executions: window.__mapperImportExecuted,
      hasImportedPath: Boolean(imported?.querySelector('path')),
      hasDangerousElement: Boolean(imported?.querySelector('script, foreignObject')),
      dangerousAttribute,
      injectedHtmlNode: Boolean(document.querySelector('#strips-list img, #pattern-cards img')),
      stripName: document.querySelector('#strips-list .strip-name')?.textContent,
      patternName: document.querySelector('#pattern-cards .pc-name')?.textContent,
    };
  });

  assert.equal(result.executions, 0);
  assert.equal(result.hasImportedPath, true);
  assert.equal(result.hasDangerousElement, false);
  assert.equal(result.dangerousAttribute, false);
  assert.equal(result.injectedHtmlNode, false);
  assert.equal(result.stripName, stripName);
  assert.equal(result.patternName, patternName);
});

test('direct SVG picker uses the same detached sanitizer before artwork reaches the canvas', async () => {
  const hostileSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"
    onload="window.__directSvgExecuted += 1">
    <script>window.__directSvgExecuted += 10</script>
    <foreignObject><div xmlns="http://www.w3.org/1999/xhtml">
      <img src="x" onerror="window.__directSvgExecuted += 100" />
    </div></foreignObject>
    <g id="direct-art" data-name="Direct artwork" onclick="window.__directSvgExecuted += 1000">
      <path d="M0 0 L100 100" />
    </g>
  </svg>`;
  await page.evaluate(() => {
    window.__directSvgExecuted = 0;
  });
  await page.setInputFiles('#file-input', {
    name: 'hostile-direct.svg',
    mimeType: 'image/svg+xml',
    buffer: Buffer.from(hostileSvg),
  });
  await page.waitForTimeout(150);

  const result = await page.evaluate(() => {
    const imported = document.querySelector('#imported-svg');
    return {
      executions: window.__directSvgExecuted,
      hasPath: Boolean(imported?.querySelector('path')),
      hasDangerousElement: Boolean(imported?.querySelector('script, foreignObject')),
      hasEventAttribute: imported
        ? [...imported.querySelectorAll('*')].some(element => (
            [...element.attributes].some(attribute => attribute.name.toLowerCase().startsWith('on'))
          ))
        : true,
    };
  });
  assert.equal(result.executions, 0);
  assert.equal(result.hasPath, true);
  assert.equal(result.hasDangerousElement, false);
  assert.equal(result.hasEventAttribute, false);
});

test('oversized SVG, pattern, and project files are rejected by size before parsing', async () => {
  const importedBefore = await page.locator('#imported-svg').innerHTML();
  await page.setInputFiles('#file-input', {
    name: 'oversized.svg',
    mimeType: 'image/svg+xml',
    buffer: Buffer.alloc(2 * 1024 * 1024 + 1, 0x20),
  });
  await page.waitForTimeout(50);
  assert.match(await page.locator('#toast').textContent(), /SVG.*2 MB.*limit/i);
  assert.equal(await page.locator('#imported-svg').innerHTML(), importedBefore);

  const patternCountBefore = await page.locator('#pattern-cards .pattern-card').count();
  await page.locator('.mode-btn[data-mode="pattern"]').click();
  let chooserPromise = page.waitForEvent('filechooser');
  await page.locator('#btn-import-pattern').click();
  let chooser = await chooserPromise;
  await chooser.setFiles({
    name: 'oversized-pattern.json',
    mimeType: 'application/json',
    buffer: Buffer.alloc(64 * 1024 + 1, 0x20),
  });
  await page.waitForTimeout(50);
  assert.match(await page.locator('#toast').textContent(), /Pattern.*64 KB.*limit/i);
  assert.equal(await page.locator('#pattern-cards .pattern-card').count(), patternCountBefore);

  chooserPromise = page.waitForEvent('filechooser');
  await page.locator('#btn-load').click();
  chooser = await chooserPromise;
  await chooser.setFiles({
    name: 'oversized-project.json',
    mimeType: 'application/json',
    buffer: Buffer.alloc(5 * 1024 * 1024 + 1, 0x20),
  });
  await page.waitForTimeout(50);
  assert.match(await page.locator('#toast').textContent(), /Project.*5 MB.*limit/i);
  assert.equal(await page.locator('#confirm-overlay').getAttribute('class'), 'confirm-overlay hidden');
});
