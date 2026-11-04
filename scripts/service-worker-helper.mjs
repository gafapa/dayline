// Waits until the app's service worker controls the page (needed before offline steps).
// A fresh browser may finish activation after the first load, so reload once if needed.
export async function controlledByServiceWorker(page) {
  await page.evaluate(() => navigator.serviceWorker.ready);
  if (!(await page.evaluate(() => !!navigator.serviceWorker.controller)))
    await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 30000 });
}

// Restores the network. Some CI browsers keep navigator.onLine false on a worker-controlled
// page after offline emulation ends; a reload then picks up the real state and syncs.
export async function backOnline(context, page) {
  await context.setOffline(false);
  const online = await page.waitForFunction(() => navigator.onLine, null, { timeout: 5000 }).then(() => true, () => false);
  if (!online) {
    console.info('navigator.onLine stayed false after restoring the network; reloading.');
    await page.reload({ waitUntil: 'domcontentloaded' });
  }
}
