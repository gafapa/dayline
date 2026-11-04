import assert from "node:assert/strict";
import { openSection } from './navigation-helper.mjs';
import { chromium, expect } from "@playwright/test";
import { writeFile } from "node:fs/promises";
const base = "http://127.0.0.1:5173",
  browser = await chromium.launch({ channel: "msedge", headless: true }),
  context = await browser.newContext({
    ...(process.env.BROWSER_STATE
      ? { storageState: process.env.BROWSER_STATE }
      : {}),
    viewport: { width: 1440, height: 1000 },
  }),
  page = await context.newPage(),
  errors = [],
  suffix = Date.now();
page.on("pageerror", (e) => errors.push(e.message));
const nav = async (name) => {
  if (
    await page
      .getByRole("button", { name: "Abrir navegación", exact: true })
      .isVisible()
  )
    await page
      .getByRole("button", { name: "Abrir navegación", exact: true })
      .click();
  await openSection(page, name);
};
let workspaceId;
const request = async (path, data) => {
  const response = await page.request.post(
    `${base}/api/workspaces/${workspaceId}${path}`,
    { headers: { "X-Kelvin-Client": "web", "X-Kelvin-Document-Schema": "1" }, data },
  );
  assert.equal(response.status(), 200, await response.text());
  return response.json();
};
const mutate = async (kind, title, data = {}, existing) => {
  return (
    await request("/mutate", {
      operationId: crypto.randomUUID(),
      id: existing?.id || crypto.randomUUID(),
      expectedVersion: existing?.version || 0,
      kind,
      title,
      data,
    })
  ).resource;
};
const snapshot = async () => {
  const response = await page.request.get(
    `${base}/api/workspaces/${workspaceId}/resources`,
  );
  assert.equal(response.status(), 200);
  return (await response.json()).resources;
};
try {
  await page.goto(base, { waitUntil: "domcontentloaded" });
  if (!(await page.request.get(base + "/api/me")).ok()) {
    await page
      .getByLabel("Correo electrónico", { exact: true })
      .fill("browser@example.test");
    await page
      .getByLabel("Contraseña", { exact: true })
      .fill("browser-test-password-long");
    await page.getByRole("button", { name: "Entrar", exact: true }).click();
  }
  await page
    .getByRole("heading", { name: "Hoy", exact: true })
    .waitFor();
  const profile = await (await page.request.get(`${base}/api/me`)).json();
  workspaceId = profile.workspaces[0].id;
  const project = await mutate("project", `Plantilla de entrega ${suffix}`, {
      description: "Synthetic collection qualification",
    }),
    task = await mutate("task", `Revisar colección ${suffix}`, {
      projectId: project.id,
      status: "done",
      assigneeId: profile.user.id,
      estimate: 3,
      checklist: [{ id: crypto.randomUUID(), text: "Check reset", done: true }],
      dueDate: "2026-11-10",
    }),
    other = await mutate("task", `Otra colección ${suffix}`, {
      projectId: project.id,
      status: "todo",
    }),
    doc = await mutate("document", `Guía de colección ${suffix}`, {
      projectId: project.id,
      content: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "text",
                text: "Metadata source before collaborative editing",
              },
            ],
          },
        ],
      },
    });
  const file = await request(`/resources/${doc.id}/attachments`, {
    name: "pixel.png",
    mime: "image/png",
    base64:
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZWoAAAAASUVORK5CYII=",
  });
  await mutate(
    "document",
    doc.title,
    {
      ...doc.data,
      content: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "text",
                text: "Metadata source before collaborative editing",
              },
              {
                type: "text",
                text: " Linked task",
                marks: [
                  { type: "link", attrs: { href: `/?resource=${task.id}` } },
                ],
              },
            ],
          },
          { type: "image", attrs: { src: file.attachment.url } },
          { type: "paragraph" },
        ],
      },
    },
    doc,
  );
  await page.reload({ waitUntil: "domcontentloaded" });
  await page
    .getByRole("heading", { name: "Hoy", exact: true })
    .waitFor();
  await nav("Documentos");
  await page
    .getByRole("button", { name: doc.title, exact: false })
    .first()
    .click();
  await page.locator(".tiptap").waitFor();
  await page.locator(".tiptap").click();
  await page.locator(".tiptap").press("Control+End");
  await page.keyboard.type(`Canonical collaborative collection ${suffix}`);
  await page
    .getByText("Guardado en el servidor", { exact: true })
    .waitFor({ timeout: 25000 });
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Cerrar", exact: true })
    .click();
  await nav("Todas las tareas");
  await page.getByLabel("Buscar tareas", { exact: true }).fill(String(suffix));
  await page.getByText("Más filtros y ordenación", { exact: true }).click();
  await page
    .getByLabel("Proyecto de la vista", { exact: true })
    .selectOption(project.id);
  await page.getByLabel("Ordenar por", { exact: true }).selectOption("title");
  await page.getByLabel("Agrupar por", { exact: true }).selectOption("status");
  await page
    .getByRole("button", { name: "Guardar vista", exact: true })
    .click();
  let dialog = page.getByRole("dialog");
  await dialog
    .getByLabel("Nombre de la vista", { exact: true })
    .fill(`Vista de colección ${suffix}`);
  await dialog
    .getByRole("button", { name: "Guardar vista", exact: true })
    .click();
  await page
    .getByRole("status")
    .filter({ hasText: "Vista guardada" })
    .waitFor();
  await page.getByLabel(`Seleccionar ${task.title}`, { exact: true }).check();
  await page.getByLabel(`Seleccionar ${other.title}`, { exact: true }).check();
  await page
    .getByLabel("Campo del lote", { exact: true })
    .selectOption("priority");
  await page
    .getByLabel("Valor del lote", { exact: true })
    .selectOption("urgent");
  await page
    .getByRole("button", { name: "Aplicar a la selección", exact: true })
    .click();
  await page
    .getByText("2 tareas actualizadas. Confirmado por el servidor.", {
      exact: true,
    })
    .waitFor();
  let stored = await snapshot();
  assert.equal(stored.find((r) => r.id === task.id).data.priority, "urgent");
  assert.equal(stored.find((r) => r.id === other.id).data.priority, "urgent");
  await page.getByLabel(`Seleccionar ${task.title}`, { exact: true }).check();
  const current = stored.find((r) => r.id === task.id);
  await mutate(
    "task",
    current.title,
    { ...current.data, description: "Concurrent change" },
    current,
  );
  await page
    .getByRole("alert")
    .filter({ hasText: "La selección contiene cambios posteriores" })
    .waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "Aplicar a la selección", exact: true })
      .isDisabled(),
    true,
  );
  assert.equal(
    (await snapshot()).find((r) => r.id === task.id).version,
    current.version + 1,
  );
  await page
    .getByRole("button", { name: "Limpiar selección", exact: true })
    .click();
  await page.reload({ waitUntil: "domcontentloaded" });
  await page
    .getByRole("heading", { name: "Todas las tareas", exact: true })
    .waitFor();
  await nav("Todas las tareas");
  const view = (await snapshot()).find(
    (r) => r.kind === "view" && r.title === `Vista de colección ${suffix}`,
  );
  assert.ok(view);
  await page
    .getByLabel("Vista guardada", { exact: true })
    .selectOption(view.id);
  assert.equal(
    await page.getByLabel("Buscar tareas", { exact: true }).inputValue(),
    String(suffix),
  );
  await page.getByLabel(`Seleccionar ${other.title}`, { exact: true }).check();
  await page
    .getByRole("button", { name: "Enviar selección a papelera", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Deshacer envío a papelera", exact: true })
    .click();
  await page
    .getByText("1 tareas restauradas. Confirmado por el servidor.", {
      exact: true,
    })
    .waitFor();
  assert.equal(
    (await snapshot()).find((r) => r.id === other.id).deleted_at,
    null,
  );
  await page.screenshot({
    path: "docs/evidence/collections-desktop.png",
    fullPage: true,
  });
  await nav("Plantillas");
  await page
    .getByRole("button", { name: "Capturar proyecto o documento", exact: true })
    .click();
  dialog = page.getByRole("dialog");
  await dialog
    .getByLabel("Origen de la plantilla", { exact: true })
    .selectOption(project.id);
  await dialog
    .getByLabel("Nombre de la plantilla", { exact: true })
    .fill(`Captura de colección ${suffix}`);
  await dialog
    .getByLabel("Fecha de referencia", { exact: true })
    .fill("2026-11-03");
  await dialog
    .getByRole("button", { name: "Capturar plantilla", exact: true })
    .click();
  await page
    .getByText(
      "Plantilla confirmada por el servidor: 4 elementos y 1 adjuntos copiados.",
      { exact: true },
    )
    .waitFor();
  const row = page.locator(".template-row").filter({
    has: page.getByRole("heading", {
      name: `Captura de colección ${suffix}`,
      exact: true,
    }),
  });
  await row
    .getByRole("button", { name: "Editar plantilla", exact: true })
    .click();
  dialog = page.getByRole("dialog");
  await dialog
    .getByLabel("Descripción de la plantilla", { exact: true })
    .fill("Reusable delivery structure");
  await dialog
    .getByRole("button", { name: "Guardar plantilla", exact: true })
    .click();
  await page
    .getByRole("status")
    .filter({ hasText: "Plantilla guardada" })
    .waitFor();
  await page.reload({ waitUntil: "domcontentloaded" });
  await page
    .getByRole("heading", { name: "Plantillas", exact: true })
    .waitFor();
  await nav("Plantillas");
  await row
    .getByRole("button", { name: "Usar plantilla", exact: true })
    .click();
  dialog = page.getByRole("dialog");
  await dialog
    .getByLabel("Título de la nueva raíz", { exact: true })
    .fill(`Copia de colección ${suffix}`);
  await dialog
    .getByLabel("Fecha base de la copia", { exact: true })
    .fill("2027-05-01");
  const beforeCount = (await snapshot()).length;
  let committed;
  const applyPattern = "**/api/workspaces/*/templates/*/apply";
  await page.route(applyPattern, async (route) => {
    const response = await route.fetch();
    assert.equal(response.status(), 200);
    committed = await response.json();
    await route.abort("failed");
  });
  await dialog
    .getByRole("button", { name: "Crear desde plantilla", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Reintentar comando pendiente", exact: true })
    .waitFor();
  await expect.poll(() => !!committed).toBe(true);
  await page.unroute(applyPattern);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page
    .getByRole("heading", { name: "Plantillas", exact: true })
    .waitFor();
  await nav("Plantillas");
  await page
    .getByRole("button", { name: "Reintentar comando pendiente", exact: true })
    .click();
  await page
    .getByText("Comando confirmado: 4 elementos y 1 adjuntos.", { exact: true })
    .waitFor();
  stored = await snapshot();
  assert.equal(stored.length, beforeCount + 4);
  const root = stored.find((r) => r.id === committed.rootId),
    clones = stored.filter((r) => committed.ids.includes(r.id));
  assert.equal(root.data.private, true);
  assert.equal(
    clones.find((r) => r.kind === "task" && r.title === task.title).data
      .dueDate,
    "2027-05-08",
  );
  for (const task of clones.filter((r) => r.kind === "task")) {
    assert.equal(task.data.status, "backlog");
    assert.ok(!task.data.assigneeId);
    assert.ok((task.data.checklist || []).every((c) => !c.done));
  }
  const copiedDoc = clones.find((r) => r.kind === "document");
  assert.ok(
    JSON.stringify(copiedDoc.data.content).includes(
      `Canonical collaborative collection ${suffix}`,
    ),
  );
  assert.ok(
    !JSON.stringify(copiedDoc.data.content).includes(`resource=${task.id}`),
  );
  const image = copiedDoc.data.content.content.find((n) => n.type === "image");
  assert.ok(image);
  assert.notEqual(image.attrs.src, file.attachment.url);
  assert.equal((await page.request.get(base + image.attrs.src)).status(), 200);
  await page
    .getByRole("button", { name: "Nueva plantilla", exact: true })
    .click();
  dialog = page.getByRole("dialog");
  await dialog
    .getByLabel("Nombre de la plantilla", { exact: true })
    .fill(`Borrador de colección ${suffix}`);
  await dialog
    .getByLabel("Tipo de plantilla", { exact: true })
    .selectOption("document");
  await dialog.locator(".tiptap").fill("Unsaved reusable draft");
  await dialog
    .getByText("Borrador conservado en este dispositivo", { exact: true })
    .waitFor();
  await page.reload({ waitUntil: "domcontentloaded" });
  await page
    .getByRole("heading", { name: "Plantillas", exact: true })
    .waitFor();
  await nav("Plantillas");
  await page
    .getByRole("button", { name: "Nueva plantilla", exact: true })
    .click();
  dialog = page.getByRole("dialog");
  await dialog
    .locator(".tiptap")
    .getByText("Unsaved reusable draft", { exact: true })
    .waitFor();
  assert.equal(
    await dialog
      .getByLabel("Nombre de la plantilla", { exact: true })
      .inputValue(),
    `Borrador de colección ${suffix}`,
  );
  await dialog
    .getByRole("button", { name: "Guardar plantilla", exact: true })
    .click();
  await page
    .getByRole("status")
    .filter({ hasText: "Plantilla guardada" })
    .waitFor();
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  await context.setOffline(true);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page
    .getByRole("heading", { name: "Plantillas", exact: true })
    .waitFor();
  await nav("Todas las tareas");
  await page
    .getByLabel("Vista guardada", { exact: true })
    .selectOption(view.id);
  await page.getByLabel(`Seleccionar ${task.title}`, { exact: true }).waitFor();
  await nav("Plantillas");
  await page
    .getByRole("heading", {
      name: `Captura de colección ${suffix}`,
      exact: true,
    })
    .waitFor();
  await context.setOffline(false);
  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await nav("Plantillas");
    await page
      .getByLabel("Buscar plantillas", { exact: true })
      .fill(String(suffix));
    await page.screenshot({
      path: `docs/evidence/templates-${width}.png`,
      fullPage: true,
    });
    assert.ok(
      !(await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      )),
    );
    await nav("Todas las tareas");
    await page
      .getByLabel("Vista guardada", { exact: true })
      .selectOption(view.id);
    await page.screenshot({
      path: `docs/evidence/collections-${width}.png`,
      fullPage: true,
    });
    assert.ok(
      !(await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      )),
    );
  }
  assert.deepEqual(errors, []);
  await context.storageState({ path: ".local/browser-state.json" });
  await writeFile(
    "docs/evidence/collections-check.json",
    JSON.stringify(
      {
        verifiedAt: new Date().toISOString(),
        syntheticData: true,
        savedViews: true,
        versionedBulk: true,
        staleBulkRejected: true,
        trashUndo: true,
        canonicalTemplateCapture: true,
        copiedImages: true,
        templateEditor: true,
        durableDraftRestore: true,
        lostResponseReloadRetrySingleCopy: true,
        offlineViewsAndLibrary: true,
        responsiveWidths: [1440, 768, 390],
        pageErrors: errors,
      },
      null,
      2,
    ),
  );
  console.info(
    "Collections, atomic bulk editing, template copies, durable command retry and offline drafts verified.",
  );
} catch (e) {
  await page.screenshot({
    path: "docs/evidence/collections-failure.png",
    fullPage: true,
  });
  throw e;
} finally {
  await browser.close();
}
