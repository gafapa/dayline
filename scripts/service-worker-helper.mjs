// Waits until the app's service worker controls the page (needed before offline steps).
// A fresh browser may finish activation after the first load, so reload once if needed.
export async function controlledByServiceWorker(page) {
  await page.evaluate(() => navigator.serviceWorker.ready);
  if (!(await page.evaluate(() => !!navigator.serviceWorker.controller)))
    await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 30000 });
}
