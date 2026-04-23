import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: true });
const page = await (await browser.newContext()).newPage();
console.log('browser launched');
await page.goto('about:blank');
console.log('page loaded');
await browser.close();
console.log('done');
