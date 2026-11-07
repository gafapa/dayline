import assert from "node:assert/strict";
import { controlledByServiceWorker } from './service-worker-helper.mjs';
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
let workspace, gate;
const consoleErrors = [];
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});
async function post(path, data) {
  const result = await context.request.post(base + "/api" + path, {
    headers,
    data,
  });
  assert.equal(result.status(), 200, await result.text());
  return result.json();
}
const content = () => page.locator(".structure-content");
const row = (title) =>
  content()
    .locator(".structure-item")
    .filter({ has: page.getByRole("button", { name: title, exact: true }) });
const enter = (title) =>
  row(title).getByRole("button", { name: title, exact: true }).click();
const root = () =>
  page
    .getByRole("navigation", { name: "Ruta de la estructura" })
    .getByRole("button", { name: "Raíz", exact: true })
    .click();
async function create(button, title) {
  await content().getByRole("button", { name: button, exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByRole("textbox", { name: "Título", exact: true })
    .fill(title);
  await dialog.getByRole("button", { name: /^Crear / }).click();
  await expect(dialog).toHaveCount(0);
  await expect(row(title)).toBeVisible();
}
const snapshot = async () =>
  (
    await (
      await context.request.get(
        `${base}/api/workspaces/${workspace.id}/resources`,
      )
    ).json()
  ).resources;
try {
  workspace = await post("/workspaces", {
    name: `Estructura verificada ${suffix}`,
  });
  await page.goto(`${base}/?view=projects&workspace=${workspace.id}`, {
    waitUntil: "domcontentloaded",
  });
  await page.getByRole("button", { name: "Estructura", exact: true }).click();
  const projectA = `Proyecto inicial ${suffix}`,
    projectB = `Proyecto receptor ${suffix}`,
    folder = `Especificaciones ${suffix}`,
    document = `Arquitectura ${suffix}`,
    subproject = `Cliente móvil ${suffix}`;
  await create("Nuevo proyecto", projectA);
  await create("Nuevo proyecto", projectB);
  await enter(projectA);
  await create("Nueva carpeta", folder);
  await enter(folder);
  await create("Nuevo documento", document);
  await create("Nuevo subproyecto", subproject);
  await enter(document);
  await page.locator(".tiptap").waitFor();
  await page.locator(".tiptap").click();
  await page.keyboard.type("Contenido conservado al mover la carpeta.");
  await page.getByText("Guardado en el servidor", { exact: true }).waitFor();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Organizar ubicación", exact: true })
    .click();
  const data = await snapshot(),
    folderRecord = data.find((r) => r.title === folder),
    docRecord = data.find((r) => r.title === document),
    a = data.find((r) => r.title === projectA),
    b = data.find((r) => r.title === projectB),
    sub = data.find((r) => r.title === subproject);
  assert.equal(
    new URL(page.url()).searchParams.get("location"),
    folderRecord.id,
  );
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(row(document)).toBeVisible();
  await root();
  await enter(projectA);
  await row(folder).getByRole("button", { name: "Mover", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByLabel("Nueva ubicación", { exact: true })
    .selectOption(b.id);
  await dialog
    .getByRole("button", { name: "Revisar movimiento", exact: true })
    .click();
  await dialog.getByText(/elementos en la estructura;/).waitFor();
  await dialog.getByText(/Las revisiones del documento siguen los permisos del destino/).waitFor();
  let intercepted = false;
  const pattern = `**/api/workspaces/${workspace.id}/hierarchy/move`;
  await page.route(pattern, async (route) => {
    if (intercepted) {
      await route.continue();
      return;
    }
    intercepted = true;
    const response = await route.fetch();
    assert.equal(response.status(), 200, await response.text());
    await route.abort("failed");
  });
  await dialog
    .getByRole("button", { name: "Confirmar movimiento", exact: true })
    .click();
  await expect
    .poll(
      async () =>
        (await snapshot()).find((r) => r.id === folderRecord.id)?.data
          .projectId,
    )
    .toBe(b.id);
  if (await page.getByRole("dialog").count()) await page.keyboard.press("Escape");
  await page
    .getByRole("button", { name: "Reintentar comando pendiente", exact: true })
    .click();
  await expect(
    page.getByRole("button", {
      name: "Reintentar comando pendiente",
      exact: true,
    }),
  ).toHaveCount(0);
  await page.unroute(pattern);
  const moved = await snapshot();
  assert.equal(
    moved.find((r) => r.id === folderRecord.id).version,
    folderRecord.version + 1,
  );
  assert.equal(moved.find((r) => r.id === docRecord.id).data.projectId, b.id);
  assert.equal(
    moved.find((r) => r.id === sub.id).data.parentId,
    folderRecord.id,
  );
  await root();
  await enter(projectB);
  await enter(folder);
  await enter(document);
  await expect(page.locator(".tiptap")).toContainText(
    "Contenido conservado al mover la carpeta.",
  );
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Cerrar", exact: true })
    .click();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await content().getByRole("button",{name:"Nueva carpeta",exact:true}).evaluate(button=>button.getBoundingClientRect().height>=44),true);
  await page.screenshot({
    path: "docs/evidence/hierarchy-mobile.png",
    fullPage: false,
  });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  await controlledByServiceWorker(page);
  await controlledByServiceWorker(page);
  await context.setOffline(true);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(row(document)).toBeVisible();
  const offlineFolder = `Carpeta sin conexión ${suffix}`;
  await create("Nueva carpeta", offlineFolder);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(row(offlineFolder)).toBeVisible();
  await row(document)
    .getByRole("button", { name: "Mover", exact: true })
    .click();
  await expect(
    page
      .getByRole("dialog")
      .getByRole("button", { name: "Revisar movimiento", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Cancelar", exact: true })
    .click();
  await context.setOffline(false);
  await expect
    .poll(async () => (await snapshot()).some((r) => r.title === offlineFolder))
    .toBe(true);
  await row(offlineFolder)
    .getByRole("button", { name: "Archivar", exact: true })
    .click();
  await expect(row(offlineFolder)).toHaveCount(0);
  await content().getByLabel("Mostrar archivados", { exact: true }).check();
  await expect(row(offlineFolder)).toBeVisible();
  await row(offlineFolder)
    .getByRole("button", { name: "Desarchivar", exact: true })
    .click();
  await expect
    .poll(
      async () =>
        (await snapshot()).find((r) => r.title === offlineFolder)?.data
          .archived,
    )
    .toBe(false);
  await page.getByText("Sincronizado", { exact: true }).waitFor();
  await page.goto(`${base}/?resource=${folderRecord.id}`, {
    waitUntil: "domcontentloaded",
  });
  await expect(row(document)).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({
    path: "docs/evidence/hierarchy-desktop.png",
    fullPage: false,
  });
  // Projects list: create a project and a subproject in place, then leave the list layout selected.
  await page.getByRole("button", { name: "Lista", exact: true }).click();
  const list = page.getByRole("region", { name: "Todos los proyectos" });
  await list.getByRole("button", { name: "Añadir proyecto", exact: true }).click();
  await page.getByLabel("Nombre del nuevo proyecto", { exact: true }).fill(`Lista ${suffix}`);
  await page.keyboard.press("Enter");
  await expect(list.getByRole("button", { name: `Lista ${suffix}`, exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await list.getByRole("button", { name: `Nuevo subproyecto en Lista ${suffix}`, exact: true }).click();
  await page.getByLabel(`Nombre del subproyecto en Lista ${suffix}`, { exact: true }).fill(`Hijo ${suffix}`);
  await page.keyboard.press("Enter");
  await expect(list.getByRole("button", { name: `Hijo ${suffix}`, exact: true })).toBeVisible();
  // The row appears optimistically; wait for the server to hold the new subproject.
  await expect.poll(async () => {
    const created = await snapshot();
    const parent = created.find((r) => r.title === `Lista ${suffix}`)?.id;
    return !!parent && created.find((r) => r.title === `Hijo ${suffix}`)?.data.parentId === parent;
  }).toBe(true);
  // Resumen tab: indicators and the subproject of the project just created.
  await list.getByRole("button", { name: `Lista ${suffix}`, exact: true }).click();
  await page.getByRole("navigation", { name: "Vistas del proyecto" }).getByRole("button", { name: "Resumen", exact: true }).click();
  await expect(page.getByRole("region", { name: "Indicadores del proyecto" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Subproyectos" }).getByRole("button", { name: `Hijo ${suffix}`, exact: true })).toBeVisible();
  // Documentos: choose the project in the tree and create a document in place.
  await page.getByRole("navigation", { name: "Vistas del proyecto" }).getByRole("button", { name: "Documentos", exact: true }).click();
  await page.getByLabel(`Documento nuevo en Lista ${suffix}`, { exact: true }).fill(`Doc en línea ${suffix}`);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("region", { name: "Documentos" }).getByRole("button", { name: new RegExp(`Doc en línea ${suffix}`) })).toBeVisible();
  await expect.poll(async () => {
    const withDoc = await snapshot();
    const parent = withDoc.find((r) => r.title === `Lista ${suffix}`)?.id;
    return !!parent && withDoc.find((r) => r.title === `Doc en línea ${suffix}`)?.data.projectId === parent;
  }).toBe(true);
  assert.deepEqual(errors, []);
  await writeFile(
    "docs/evidence/hierarchy-check.json",
    JSON.stringify(
      {
        verifiedAt: new Date().toISOString(),
        syntheticData: true,
        folderProjectDocumentCreation: true,
        nestedProjectCreation: true,
        atomicScopeMove: true,
        canonicalDocumentPreserved: true,
        lostResponseReloadRetry: true,
        noDuplicateVersions: true,
        directoryReloadAndPermalinks: true,
        offlineDirectoryAndCreation: true,
        moveRequiresConnectivity: true,
        archiveAndRestore: true,
        mobileOverflow: false,
        mobileTouchTargetsVerified:true,
        pageErrors: errors,
      },
      null,
      2,
    ) + "\n",
  );
  console.info(
    "Project hierarchy, atomic move recovery, canonical content and offline creation verified.",
  );
} catch (error) {
  await page.screenshot({
    path: ".local/hierarchy-failure.png",
    fullPage: false,
  });
  console.error(
    "Diagnostics",
    JSON.stringify({ errors, consoleErrors, url: page.url() }),
  );
  console.error(await page.locator("body").innerText());
  throw error;
} finally {
  gate?.();
  await context.setOffline(false);
  await context.request
    .put(base + "/api/preferences", {
      headers,
      data: { projectLayout: "cards" },
    })
    .catch(() => {});
  await browser.close();
}
