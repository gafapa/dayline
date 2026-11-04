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
const day = (offset) => { const d = new Date(); d.setDate(d.getDate() + offset); return d.toLocaleDateString('en-CA'); };

/** Drags with real pointer moves so dnd-kit's pointer sensor activates. */
async function drag(source, target, { position } = {}) {
  await source.scrollIntoViewIfNeeded();
  const from = await source.boundingBox();
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 12, from.y + from.height / 2 + 12, { steps: 4 });
  await target.scrollIntoViewIfNeeded().catch(() => {});
  const to = await target.boundingBox();
  const x = to.x + (position?.x ?? to.width / 2), y = to.y + (position?.y ?? to.height / 2);
  await page.mouse.move(x, y, { steps: 12 });
  await page.waitForTimeout(150);
  await page.mouse.up();
}
const snapshot = async (ws) => (await (await context.request.get(`${base}/api/workspaces/${ws}/resources`)).json()).resources;
const find = async (ws, id) => (await snapshot(ws)).find((r) => r.id === id);

try {
  const me = await (await context.request.get(base + '/api/me')).json();
  const ws = (await post('/workspaces', { name: `Arrastrar ${suffix}` })).id;
  const mutate = async (kind, title, data) => (await post(`/workspaces/${ws}/mutate`, { operationId: crypto.randomUUID(), id: crypto.randomUUID(), expectedVersion: 0, kind, title, data })).resource;
  const alpha = await mutate('project', `Alfa ${suffix}`, { color: '#0f9f8f' }), beta = await mutate('project', `Beta ${suffix}`, { color: '#2f7de1' });
  const t1 = await mutate('task', `Uno ${suffix}`, { status: 'todo', projectId: alpha.id, assigneeId: me.user.id });
  const t2 = await mutate('task', `Dos ${suffix}`, { status: 'todo', projectId: alpha.id, assigneeId: me.user.id });
  const t3 = await mutate('task', `Tres ${suffix}`, { status: 'todo', projectId: alpha.id, assigneeId: me.user.id });
  const loose = await mutate('task', `Sin fecha ${suffix}`, { status: 'todo', assigneeId: me.user.id });
  await context.request.put(base + '/api/preferences', { headers, data: { favorites: [alpha.id, beta.id] } });
  await page.goto(`${base}/?view=tasks&workspace=${ws}`, { waitUntil: 'domcontentloaded' });
  await page.getByText('Sincronizado', { exact: true }).waitFor();

  phase = 'board is the default view';
  await expect(page.getByRole('button', { name: 'Tablero', exact: true })).toHaveAttribute('aria-pressed', 'true');
  const card = (task) => page.locator('.board-task').filter({ hasText: task.title });
  phase = 'board: move between columns';
  await drag(card(t1), page.getByRole('region', { name: 'En curso', exact: true }));
  await expect.poll(async () => (await find(ws, t1.id)).data.status).toBe('in_progress');
  await expect(page.getByRole('region', { name: 'En curso', exact: true }).locator('.board-task').filter({ hasText: t1.title })).toHaveCount(1);
  await page.screenshot({ path: 'docs/evidence/dnd-board-1440.png' });

  phase = 'board: reorder within a column';
  await drag(card(t3), card(t2), { position: { y: 8 } });
  await expect.poll(async () => { const a = await find(ws, t3.id), b = await find(ws, t2.id); return typeof a.data.order === 'number' && typeof b.data.order === 'number' && a.data.order < b.data.order; }).toBe(true);

  phase = 'sidebar: drop a task on a project';
  await drag(card(t2), page.getByRole('navigation', { name: 'Principal' }).locator('xpath=..').locator('.project-nav .nav-item').filter({ hasText: beta.title }));
  await expect.poll(async () => (await find(ws, t2.id)).data.projectId).toBe(beta.id);
  await expect(page.getByRole('status').or(page.locator('.toast')).filter({ hasText: 'movida a' }).first()).toBeVisible();

  phase = 'sidebar: reorder favorites';
  const favs = page.locator('.project-nav .nav-item');
  await drag(favs.filter({ hasText: beta.title }), favs.filter({ hasText: alpha.title }));
  await expect.poll(async () => (await (await context.request.get(base + '/api/me')).json()).preferences.favorites.slice(0, 2)).toEqual([beta.id, alpha.id]);

  phase = 'list: reorder with the grip';
  await expect(async () => {
    await page.getByRole('button', { name: 'Lista', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Lista', exact: true })).toHaveAttribute('aria-pressed', 'true', { timeout: 2000 });
  }).toPass({ timeout: 15000 });
  const row = (task) => page.locator('.task-row').filter({ hasText: task.title });
  await drag(row(t1).getByRole('button', { name: `Arrastrar ${t1.title}`, exact: true }), row(t3), { position: { y: 6 } });
  await expect.poll(async () => { const a = await find(ws, t1.id), b = await find(ws, t3.id); return typeof a.data.order === 'number' && typeof b.data.order === 'number' && a.data.order < b.data.order; }).toBe(true);

  phase = 'typed filter';
  const search = page.getByLabel('Buscar tareas', { exact: true });
  await search.fill('estado:en-curso');
  await expect(page.locator('.task-row')).toHaveCount(1);
  await expect(page.locator('.task-row')).toContainText(t1.title);
  await search.fill(`@yo ${suffix}`);
  await expect(page.locator('.task-row')).toHaveCount(4);
  await page.screenshot({ path: 'docs/evidence/typed-filter-1440.png' });
  await search.fill('');
  phase = 'calendar: give a date and move it';
  await page.setViewportSize({ width: 1440, height: 1400 });
  await openSection(page, 'Calendario');
  const tray = page.getByLabel('Tareas sin fecha', { exact: true });
  const today = page.locator('.calendar-day.today');
  await drag(tray.getByRole('button', { name: loose.title, exact: true }), today);
  await expect.poll(async () => (await find(ws, loose.id)).data.dueDate).toBe(day(0));
  await drag(today.getByRole('button', { name: loose.title, exact: true }), tray);
  await expect.poll(async () => (await find(ws, loose.id)).data.dueDate ?? null).toBe(null);
  await page.screenshot({ path: 'docs/evidence/dnd-calendar-1440.png' });

  phase = 'sprint: plan by dragging';
  await page.setViewportSize({ width: 1440, height: 1000 });
  const sprint = await mutate('sprint', `Sprint arrastre ${suffix}`, { status: 'planned', startDate: day(0), endDate: day(10) });
  await openSection(page, 'Sprints');
  
  const backlog = page.getByLabel('Trabajo pendiente', { exact: true });
  await backlog.waitFor();
  await drag(backlog.locator('.backlog-chip').filter({ hasText: t3.title }), page.locator('.sprint-plan-end'));
  await expect(page.locator('.sprint-plan-task').filter({ hasText: t3.title })).toHaveCount(1);
  await drag(backlog.locator('.backlog-chip').filter({ hasText: t1.title }), page.locator('.sprint-plan-task').filter({ hasText: t3.title }), { position: { y: 6 } });
  await expect(page.locator('.sprint-plan-task').first()).toContainText(t1.title);
  await page.screenshot({ path: 'docs/evidence/dnd-sprint-1440.png' });

  phase = 'structure: drop a document on a folder';
  // Team documents always live in a project: put both inside Alfa and open its structure.
  const folder = await mutate('folder', `Carpeta ${suffix}`, { parentId: alpha.id, projectId: alpha.id });
  const doc = await mutate('document', `Documento ${suffix}`, { parentId: alpha.id, projectId: alpha.id });
  await openSection(page, 'Proyectos');
  await page.getByRole('button', { name: 'Estructura', exact: true }).click();
  const item = (r) => page.locator('.structure-item').filter({ hasText: r.title });
  await item(alpha).getByRole('button', { name: 'Contenido', exact: true }).click();
  await item(doc).waitFor();
  await drag(item(doc).getByRole('button', { name: `Arrastrar ${doc.title}`, exact: true }), item(folder));
  const dialog = page.getByRole('dialog', { name: `Mover ${doc.title}` });
  await expect(dialog.getByRole('status')).toContainText(folder.title);
  await dialog.getByRole('button', { name: 'Confirmar movimiento', exact: true }).click();
  await expect.poll(async () => (await find(ws, doc.id)).data.parentId).toBe(folder.id);

  phase = 'attachments: drop files';
  await page.goto(`${base}/?resource=${t2.id}&workspace=${ws}`, { waitUntil: 'domcontentloaded' });
  const zone = page.locator('.attachments');
  await zone.waitFor();
  await zone.evaluate((node) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(['hola'], 'nota-arrastrada.txt', { type: 'text/plain' }));
    for (const type of ['dragover', 'drop']) node.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer }));
  });
  await expect(zone).toContainText('nota-arrastrada.txt');

  phase = 'document: move a block with its handle';
  await page.goto(`${base}/?resource=${doc.id}&workspace=${ws}`, { waitUntil: 'domcontentloaded' });
  const editor = page.locator('.ProseMirror[contenteditable="true"]');
  await editor.waitFor();
  await editor.click();
  await page.keyboard.type('Primer bloque');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Segundo bloque');
  const blocks = editor.locator(':scope > p');
  await expect(blocks).toHaveCount(2);
  await blocks.nth(1).hover();
  const handle = page.locator('.block-handle');
  await expect(handle).toBeVisible();
  const h = await handle.boundingBox(), first = await blocks.nth(0).boundingBox();
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  await page.mouse.move(first.x + 20, first.y + 4, { steps: 10 });
  await page.mouse.move(first.x + 22, first.y + 2, { steps: 2 });
  await page.mouse.up();
  await expect(blocks.nth(0)).toHaveText('Segundo bloque');
  await page.screenshot({ path: 'docs/evidence/dnd-document-1440.png' });

  phase = 'document: drop an image inside';
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  await editor.evaluate((node, data) => {
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], 'punto.png', { type: 'image/png' }));
    const box = node.getBoundingClientRect();
    const options = { bubbles: true, cancelable: true, dataTransfer: transfer, clientX: box.left + 20, clientY: box.bottom - 6 };
    node.dispatchEvent(new DragEvent('dragover', options));
    node.dispatchEvent(new DragEvent('drop', options));
  }, png);
  await expect(editor.locator('img[alt="punto.png"]')).toHaveCount(1, { timeout: 20000 });

  phase = 'mobile layout';
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${base}/?view=tasks&workspace=${ws}`, { waitUntil: 'domcontentloaded' });
  await page.locator('.board-task').first().waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: 'docs/evidence/dnd-board-390.png' });

  assert.equal(errors.length, 0, errors.join('\n'));
  await writeFile('docs/evidence/dnd-check.json', JSON.stringify({ verifiedAt: new Date().toISOString(), syntheticData: true, checks: { boardDefault: true, boardColumnMove: true, boardReorder: true, sidebarProjectDrop: true, favoritesReorder: true, listReorder: true, calendarDate: true, calendarUndate: true, sprintPlanDrag: true, structureMoveReview: true, attachmentFileDrop: true, typedFilter: true, documentBlockMove: true, documentImageDrop: true }, pageErrors: errors }, null, 2));
  console.info('Drag and drop verified on the board, list, sidebar, calendar, sprint plan, structure, attachments and documents.');
} catch (error) {
  console.error('Failed phase:', phase);
  await page.screenshot({ path: '.local/dnd-failure.png', fullPage: true }).catch(() => {});
  throw error;
} finally {
  // Leave the shared synthetic account as other checks expect it.
  await context.request.put(base + '/api/preferences', { headers, data: { projectLayout: 'cards' } }).catch(() => {});
  await browser.close();
}
