import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { postFixture } from './browser-fixture-request.mjs';
import { openSection } from './navigation-helper.mjs';

const base = 'http://127.0.0.1:5173', headers = { 'X-Kelvin-Client': 'web', 'X-Kelvin-Document-Schema': '1' }, suffix = Date.now();
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({ storageState: process.env.BROWSER_STATE || '.local/browser-state.json', viewport: { width: 1440, height: 1000 } });
context.setDefaultTimeout(15000);
const page = await context.newPage(), errors = [];
page.on('pageerror', (e) => errors.push(e.message));
let phase = 'setup';
const post = (path, data) => postFixture(context.request, base + '/api' + path, headers, data);
const today = new Date().toLocaleDateString('en-CA');
try {
  const me = await (await context.request.get(base + '/api/me')).json();
  const ws = (await post('/workspaces', { name: `Bandeja ${suffix}` })).id;
  const mutate = async (kind, title, data) => (await post(`/workspaces/${ws}/mutate`, { operationId: crypto.randomUUID(), id: crypto.randomUUID(), expectedVersion: 0, kind, title, data })).resource;
  const find = async (id) => (await (await context.request.get(`${base}/api/workspaces/${ws}/resources`)).json()).resources.find((r) => r.id === id);
  const task = await mutate('task', `Tarea asignada ${suffix}`, { status: 'todo', assigneeId: me.user.id });
  const note = (title, data = {}) => mutate('notification', title, { assigneeId: me.user.id, ...data });
  const plan = await note(`Te asignaron la tarea ${suffix}`, { targetId: task.id });
  const later = await note(`Revisión pedida ${suffix}`);
  const done = await note(`Aviso informativo ${suffix}`);
  await page.goto(`${base}/?view=inbox&workspace=${ws}`, { waitUntil: 'domcontentloaded' });
  await page.getByText('Sincronizado', { exact: true }).waitFor();
  const item = (title) => page.locator('.triage-item').filter({ hasText: title });
  await expect(page.getByRole('heading', { name: /Por decidir/ })).toContainText('3');

  phase = 'plan for today';
  await item(plan.title).getByRole('button', { name: 'Planificar para hoy', exact: true }).click();
  await expect.poll(async () => (await find(task.id)).data.dueDate).toBe(today);
  await expect.poll(async () => (await find(plan.id)).data.read).toBe(true);

  phase = 'snooze';
  await item(later.title).getByRole('button', { name: 'Posponer a mañana', exact: true }).click();
  await expect(page.getByRole('heading', { name: /Pospuestos/ })).toContainText('1');
  await expect.poll(async () => Date.parse((await find(later.id)).data.snoozedUntil) > Date.now()).toBe(true);

  phase = 'archive';
  await item(done.title).getByRole('button', { name: 'Archivar', exact: true }).click();
  await expect(page.getByText('Nada pendiente. Bien hecho.', { exact: true })).toBeVisible();
  await page.screenshot({ path: 'docs/evidence/inbox-1440.png' });

  phase = 'earlier and open';
  await page.getByRole('button', { name: /Ver anteriores/ }).click();
  await item(plan.title).getByRole('button', { name: 'Abrir', exact: true }).click();
  await expect(page.locator('.resource-dialog .resource-title')).toHaveValue(task.title);
  await page.locator('.resource-dialog').getByRole('button', { name: 'Cerrar', exact: true }).first().click();

  phase = 'today shows the planned task';
  await openSection(page, 'Hoy');
  await expect(page.locator('.today-task').filter({ hasText: task.title })).toHaveCount(1);

  phase = 'mobile';
  await openSection(page, 'Bandeja');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: 'docs/evidence/inbox-390.png' });
  assert.equal(errors.length, 0, errors.join('\n'));
  await writeFile('docs/evidence/inbox-check.json', JSON.stringify({ verifiedAt: new Date().toISOString(), syntheticData: true, checks: { planForToday: true, snooze: true, archive: true, openInPanel: true, todayShowsPlanned: true, mobile: true }, pageErrors: errors }, null, 2));
  console.info('Inbox triage verified: plan for today, snooze, archive, open and Today.');
} catch (error) {
  console.error('Failed phase:', phase);
  await page.screenshot({ path: '.local/inbox-failure.png', fullPage: true }).catch(() => {});
  throw error;
} finally {
  await browser.close();
}
