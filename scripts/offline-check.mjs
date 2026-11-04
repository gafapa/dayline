import { chromium } from "@playwright/test";
import { controlledByServiceWorker } from './service-worker-helper.mjs';
import { openSection } from './navigation-helper.mjs';
import { readFile, writeFile } from "node:fs/promises";
const base = "http://127.0.0.1:5173";
const browser = await chromium.launch({ channel: "msedge", headless: true });
const context = await browser.newContext({
  ...(process.env.BROWSER_STATE
    ? { storageState: process.env.BROWSER_STATE }
    : {}),
  viewport: { width: 1440, height: 1000 },
});
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("response", (response) => {
  if (response.url().endsWith("/state"))
    console.info("Document download response:", response.status());
});
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
  await controlledByServiceWorker(page);
  await controlledByServiceWorker(page);
  const title = `Documento creado sin conexión ${Date.now()}`,
    text =
      "Este contenido se creó sin conexión y debe conservarse al recargar.";
  await context.setOffline(true);
  await openSection(page, "Documentos");
  await page
    .getByRole("button", { name: "Nuevo documento", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByLabel("Título", { exact: true })
    .fill(title);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Crear documento", exact: true })
    .click();
  await page.locator(".tiptap").waitFor();
  await page.locator(".tiptap").fill(text);
  const saved = page.waitForEvent("download");
  await page.getByRole("button", { name: "Exportar", exact: true }).click();
  const file = await saved;
  const path = await file.path();
  if (!(await readFile(path, "utf8")).includes(text))
    throw new Error("Offline export omitted current content");
  await page.reload({ waitUntil: "domcontentloaded" });
  await page
    .getByRole("dialog")
    .getByRole("textbox", { name: "Título", exact: true })
    .waitFor();
  await page.locator(".tiptap").getByText(text, { exact: true }).waitFor();
  await context.setOffline(false);
  await page
    .getByText("Guardado en el servidor", { exact: true })
    .waitFor({ timeout: 60000 });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page
    .getByRole("dialog")
    .getByRole("textbox", { name: "Título", exact: true })
    .waitFor();
  await page.locator(".tiptap").getByText(text, { exact: true }).waitFor();
  await page.screenshot({
    path: "docs/evidence/offline-document-recovered.png",
    fullPage: true,
  });
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Cerrar", exact: true })
    .click();
  const profile = await (await page.request.get(`${base}/api/me`)).json();
  const workspaceId = profile.workspaces[0].id;
  const projectId = crypto.randomUUID(),
    documentId = crypto.randomUUID(),
    downloadTitle = `Documento descargado ${Date.now()}`,
    projectTitle = `Proyecto descargable ${Date.now()}`;
  for (const record of [
    { id: projectId, kind: "project", title: projectTitle, data: {} },
    {
      id: documentId,
      kind: "document",
      title: downloadTitle,
      data: {
        projectId,
        content: {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [
                {
                  type: "text",
                  text: "Contenido preparado antes de abrir el editor.",
                },
              ],
            },
          ],
        },
      },
    },
  ]) {
    const response = await page.request.post(
      `${base}/api/workspaces/${workspaceId}/mutate`,
      {
        headers: { "X-Kelvin-Client": "web", "X-Kelvin-Document-Schema": "1" },
        data: {
          ...record,
          operationId: crypto.randomUUID(),
          expectedVersion: 0,
        },
      },
    );
    if (!response.ok()) throw new Error("Could not prepare download fixture");
  }
  await page.reload({ waitUntil: "domcontentloaded" });
  await openSection(page, "Proyectos");
  await page
    .locator(".project-card")
    .filter({
      has: page.getByRole("button", { name: projectTitle, exact: true }),
    })
    .getByRole("button", { name: "Detalles del proyecto", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByRole("button", { name: "Descargar para sin conexión", exact: true })
    .click();
  await page
    .getByText(/1 documentos descargados para trabajar sin conexión/)
    .waitFor();
  await dialog.getByRole("button", { name: "Cerrar", exact: true }).click();
  await context.setOffline(true);
  await openSection(page, "Documentos");
  await page.getByRole("button", { name: new RegExp(downloadTitle) }).click();
  await page
    .locator(".tiptap")
    .getByText("Contenido preparado antes de abrir el editor.", { exact: true })
    .waitFor();
  await context.setOffline(false);
  if (errors.length) throw new Error(errors.join("\n"));
  await writeFile(
    "docs/evidence/offline-check.json",
    JSON.stringify(
      {
        verifiedAt: new Date().toISOString(),
        syntheticData: true,
        offlineDocumentCreation: true,
        currentContentExport: true,
        offlineReloadPreservedContent: true,
        reconnectDurability: true,
        onlineReloadPreservedContent: true,
        selectedProjectDownloadBeforeOpeningDocument: true,
        pageErrors: errors,
      },
      null,
      2,
    ),
  );
  console.info(
    "Offline document creation, export, reload and reconnect durability verified.",
  );
} catch (error) {
  console.error("Page errors:", errors);
  console.error(
    "Cache entries:",
    await page.evaluate(async () =>
      Promise.all(
        (await caches.keys()).map(async (key) => ({
          key,
          paths: (await (await caches.open(key)).keys()).map(
            (r) => new URL(r.url).pathname,
          ),
        })),
      ),
    ),
  );
  await context.setOffline(false);
  await page
    .screenshot({ path: "docs/evidence/offline-failure.png", fullPage: true })
    .catch(() => {});
  console.error(await page.locator("body").innerText());
  throw error;
} finally {
  await context.setOffline(false);
  await browser.close();
}
