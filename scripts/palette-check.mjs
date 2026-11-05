import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { postFixture } from './browser-fixture-request.mjs';

const base = 'http://127.0.0.1:5173', headers = { 'X-Kelvin-Client': 'web', 'X-Kelvin-Document-Schema': '1' }, suffix = Date.now();
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({ storageState: process.env.BROWSER_STATE || '.local/browser-state.json', viewport: { width: 1440, height: 1000 } });
context.setDefaultTimeout(15000);
const page = await context.newPage(), errors = [];
page.on('pageerror', (e) => { errors.push(e.message); console.error('PAGEERROR', e.message); });
page.on('console', (m) => { if (m.type() === 'error') console.error('CONSOLE', m.text().slice(0, 300)); });
let phase = 'setup';
const post = (path, data) => postFixture(context.request, base + '/api' + path, headers, data);
try {
  const ws = (await post('/workspaces', { name: `Paleta ${suffix}` })).id;
  const mutate = async (kind, title, data) => (await post(`/workspaces/${ws}/mutate`, { operationId: crypto.randomUUID(), id: crypto.randomUUID(), expectedVersion: 0, kind, title, data })).resource;
  const project = await mutate('project', `Proyecto paleta ${suffix}`, {});
  const task = await mutate('task', `Tarea paleta ${suffix}`, { status: 'todo', projectId: project.id });
  await mutate('document', `Acta ${suffix}`, { projectId: project.id, content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: `Decidimos usar la palabra clave zafiro${suffix} para el piloto.` }] }] } });
  await page.goto(`${base}/?view=overview&workspace=${ws}`, { waitUntil: 'domcontentloaded' });
  await page.getByText('Sincronizado', { exact: true }).waitFor();
  const palette = page.getByRole('dialog', { name: 'Buscar en tu espacio', exact: true });
  const input = palette.getByRole('combobox');

  phase = 'find a task and open it with Enter';
  await page.keyboard.press('Control+k');
  await palette.waitFor();
  await input.fill(`paleta ${suffix}`);
  await expect(palette.getByText('Tareas', { exact: true })).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowUp');
  await expect(palette.getByRole('option').first()).toHaveAttribute('aria-selected', 'true');
  await palette.getByRole('option', { name: new RegExp(`Tarea paleta ${suffix}`) }).hover();
  await page.keyboard.press('Enter');
  await expect(page.locator('.resource-dialog .resource-title')).toHaveValue(task.title);
  await page.locator('.resource-dialog').getByRole('button', { name: 'Cerrar', exact: true }).first().click();

  phase = 'document text with excerpt';
  await page.keyboard.press('Control+k');
  await input.fill(`zafiro${suffix}`);
  await expect(palette.getByText('Documentos', { exact: true })).toBeVisible();
  await expect(palette.getByRole('option', { name: new RegExp(`Acta ${suffix}`) })).toContainText('palabra clave');
  await page.screenshot({ path: 'docs/evidence/palette-1440.png' });

  phase = 'actions only and go to a project';
  await input.fill('> nuevo');
  await expect(palette.getByText('Acciones', { exact: true })).toBeVisible();
  await expect(palette.getByText('Tareas', { exact: true })).toHaveCount(0);
  await input.fill(`Proyecto paleta ${suffix}`);
  await palette.getByRole('option', { name: new RegExp(`Proyecto paleta ${suffix}`) }).click();
  await expect(page.getByRole('navigation', { name: 'Vistas del proyecto' })).toBeVisible();
  await expect(page.locator('h1')).toContainText(project.title);

  assert.equal(errors.length, 0, errors.join('\n'));
  await writeFile('docs/evidence/palette-check.json', JSON.stringify({ verifiedAt: new Date().toISOString(), syntheticData: true, checks: { taskSearchEnter: true, keyboardSelection: true, documentExcerpt: true, actionsOnly: true, goToProject: true }, pageErrors: errors }, null, 2));
  console.info('Command palette verified: search, keyboard, document excerpts, actions and navigation.');
} catch (error) {
  console.error('Failed phase:', phase);
  await page.screenshot({ path: '.local/palette-failure.png', fullPage: true }).catch(() => {});
  throw error;
} finally {
  await browser.close();
}
