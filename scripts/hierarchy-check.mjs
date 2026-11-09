import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { writeFile } from "node:fs/promises";
const base = "http://127.0.0.1:5173",
  headers = { "X-Kelvin-Client": "web", "X-Kelvin-Document-Schema": "1" },
  suffix = Date.now(),
  browser = await chromium.launch({ channel: "msedge", headless: true }),
  context = await browser.newContext({
    storageState: ".local/browser-state.json",
    viewport: { width: 1440, height: 1000 },
  }),
  page = await context.newPage(),
  errors = [];
page.on("pageerror", (e) => errors.push(e.message));
let workspace;
const consoleErrors = [];
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});
async function post(path, data) {
  const result = await context.request.post(base + "/api" + path, { headers, data });
  assert.equal(result.status(), 200, await result.text());
  return result.json();
}
const mutate = async (kind, title, data) =>
  (
    await post(`/workspaces/${workspace.id}/mutate`, {
      operationId: crypto.randomUUID(),
      id: crypto.randomUUID(),
      expectedVersion: 0,
      kind,
      title,
      data,
    })
  ).resource;
const snapshot = async () =>
  (await (await context.request.get(`${base}/api/workspaces/${workspace.id}/resources`)).json()).resources;
const list = () => page.getByRole("region", { name: "Todos los proyectos" });
const projectRow = (title) =>
  list()
    .locator(".project-row")
    .filter({ has: page.getByRole("button", { name: title, exact: true }) });
try {
  workspace = await post("/workspaces", { name: `Estructura verificada ${suffix}` });
  const a = await mutate("project", `Proyecto inicial ${suffix}`, {}),
    b = await mutate("project", `Proyecto receptor ${suffix}`, {}),
    folder = await mutate("folder", `Especificaciones ${suffix}`, { parentId: a.id, projectId: a.id }),
    doc = await mutate("document", `Arquitectura ${suffix}`, { parentId: folder.id, projectId: a.id }),
    sub = await mutate("project", `Cliente móvil ${suffix}`, { parentId: folder.id });

  // The projects page has a single view: the list, with subprojects nested across folders.
  await page.goto(`${base}/?view=projects&workspace=${workspace.id}`, { waitUntil: "domcontentloaded" });
  await projectRow(a.title).waitFor();
  await expect(page.getByRole("group", { name: "Vista de proyectos" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Estructura", exact: true })).toHaveCount(0);
  await expect(list().getByRole("button", { name: sub.title, exact: true })).toBeVisible();

  // Write content in the document; it must survive the move.
  await page.goto(`${base}/?resource=${doc.id}&workspace=${workspace.id}`, { waitUntil: "domcontentloaded" });
  await page.locator(".tiptap").waitFor();
  await page.locator(".tiptap").click();
  await page.keyboard.type("Contenido conservado al mover la carpeta.");
  await page.getByText("Guardado en el servidor", { exact: true }).waitFor();

  // Move the folder from its details: review, then lose the confirmation response and retry.
  await page.goto(`${base}/?resource=${folder.id}&workspace=${workspace.id}`, { waitUntil: "domcontentloaded" });
  await page.getByRole("dialog").getByRole("button", { name: "Organizar ubicación", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: `Mover ${folder.title}` });
  await dialog.getByLabel("Nueva ubicación", { exact: true }).selectOption(b.id);
  await dialog.getByRole("button", { name: "Revisar movimiento", exact: true }).click();
  await dialog.getByText(/elementos en la estructura;/).waitFor();
  await dialog.getByText(/Las revisiones del documento siguen los permisos del destino/).waitFor();
  const before = (await snapshot()).find((r) => r.id === folder.id);
  let intercepted = false;
  const pattern = `**/api/workspaces/${workspace.id}/hierarchy/move`;
  await page.route(pattern, async (route) => {
    if (intercepted) return route.continue();
    intercepted = true;
    const response = await route.fetch();
    assert.equal(response.status(), 200, await response.text());
    await route.abort("failed");
  });
  await dialog.getByRole("button", { name: "Confirmar movimiento", exact: true }).click();
  await expect.poll(async () => (await snapshot()).find((r) => r.id === folder.id)?.data.projectId).toBe(b.id);
  await dialog.getByRole("button", { name: "Reintentar comando pendiente", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.unroute(pattern);
  const moved = await snapshot();
  assert.equal(moved.find((r) => r.id === folder.id).version, before.version + 1);
  assert.equal(moved.find((r) => r.id === doc.id).data.projectId, b.id);
  assert.equal(moved.find((r) => r.id === sub.id).data.parentId, folder.id);
  await page.goto(`${base}/?resource=${doc.id}&workspace=${workspace.id}`, { waitUntil: "domcontentloaded" });
  await expect(page.locator(".tiptap")).toContainText("Contenido conservado al mover la carpeta.");

  // The subproject now hangs from the receiving project in the list.
  await page.goto(`${base}/?view=projects&workspace=${workspace.id}`, { waitUntil: "domcontentloaded" });
  await projectRow(b.title).waitFor();
  const branch = list().locator("li", { has: page.locator(".project-row", { hasText: b.title }) }).first();
  await expect(branch.getByRole("button", { name: sub.title, exact: true })).toBeVisible();

  // Without a connection a move cannot be reviewed.
  await context.setOffline(true);
  await projectRow(a.title).getByRole("button", { name: "Detalles del proyecto", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Organizar ubicación", exact: true }).click();
  const offline = page.getByRole("dialog", { name: `Mover ${a.title}` });
  await expect(offline.getByRole("button", { name: "Revisar movimiento", exact: true })).toBeDisabled();
  await offline.getByRole("button", { name: "Cancelar", exact: true }).click();
  await context.setOffline(false);
  if (await page.getByRole("dialog").count()) await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // Phone width: no sideways scroll.
  await page.setViewportSize({ width: 390, height: 844 });
  await projectRow(a.title).waitFor();
  await page.screenshot({ path: "docs/evidence/hierarchy-mobile.png", fullPage: false });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: "docs/evidence/hierarchy-desktop.png", fullPage: false });

  // Create a project and a subproject in place.
  await list().getByRole("button", { name: "Añadir proyecto", exact: true }).click();
  await page.getByLabel("Nombre del nuevo proyecto", { exact: true }).fill(`Lista ${suffix}`);
  await page.keyboard.press("Enter");
  await expect(list().getByRole("button", { name: `Lista ${suffix}`, exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await list().getByRole("button", { name: `Nuevo subproyecto en Lista ${suffix}`, exact: true }).click();
  await page.getByLabel(`Nombre del subproyecto en Lista ${suffix}`, { exact: true }).fill(`Hijo ${suffix}`);
  await page.keyboard.press("Enter");
  await expect(list().getByRole("button", { name: `Hijo ${suffix}`, exact: true })).toBeVisible();
  // The row appears optimistically; wait for the server to hold the new subproject.
  await expect
    .poll(async () => {
      const created = await snapshot();
      const parent = created.find((r) => r.title === `Lista ${suffix}`)?.id;
      return !!parent && created.find((r) => r.title === `Hijo ${suffix}`)?.data.parentId === parent;
    })
    .toBe(true);
  // Resumen tab: indicators and the subproject of the project just created.
  await list().getByRole("button", { name: `Lista ${suffix}`, exact: true }).click();
  await page.getByRole("navigation", { name: "Vistas del proyecto" }).getByRole("button", { name: "Resumen", exact: true }).click();
  await expect(page.getByRole("region", { name: "Indicadores del proyecto" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Subproyectos" }).getByRole("button", { name: `Hijo ${suffix}`, exact: true })).toBeVisible();
  // Documentos: create a document in place inside the project.
  await page.getByRole("navigation", { name: "Vistas del proyecto" }).getByRole("button", { name: "Documentos", exact: true }).click();
  await page.getByLabel(`Documento nuevo en Lista ${suffix}`, { exact: true }).fill(`Doc en línea ${suffix}`);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("region", { name: "Documentos" }).getByRole("button", { name: new RegExp(`Doc en línea ${suffix}`) })).toBeVisible();
  await expect
    .poll(async () => {
      const withDoc = await snapshot();
      const parent = withDoc.find((r) => r.title === `Lista ${suffix}`)?.id;
      return !!parent && withDoc.find((r) => r.title === `Doc en línea ${suffix}`)?.data.projectId === parent;
    })
    .toBe(true);
  assert.deepEqual(errors, []);
  await writeFile(
    "docs/evidence/hierarchy-check.json",
    JSON.stringify(
      {
        verifiedAt: new Date().toISOString(),
        syntheticData: true,
        singleListView: true,
        nestedProjectCreation: true,
        atomicScopeMove: true,
        canonicalDocumentPreserved: true,
        lostResponseRetry: true,
        noDuplicateVersions: true,
        moveRequiresConnectivity: true,
        mobileOverflow: false,
        pageErrors: errors,
      },
      null,
      2,
    ) + "\n",
  );
  console.info("Projects list, reviewed move with lost-response retry and in-place creation verified.");
} catch (error) {
  await page.screenshot({ path: ".local/hierarchy-failure.png", fullPage: false });
  console.error("Diagnostics", JSON.stringify({ errors, consoleErrors, url: page.url() }));
  console.error(await page.locator("body").innerText());
  throw error;
} finally {
  await context.setOffline(false);
  await browser.close();
}
