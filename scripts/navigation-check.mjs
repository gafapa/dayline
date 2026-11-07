import assert from "node:assert/strict";
import { controlledByServiceWorker } from './service-worker-helper.mjs';
import { openSection } from './navigation-helper.mjs';
import { chromium, expect as baseExpect } from "@playwright/test";
// Deep links resolve over the network after sign-in or a context switch; on a busy machine that
// takes longer than the 5 s default, so this check waits up to 15 s for each resolved view.
const expect = baseExpect.configure({ timeout: 15000 });
import { writeFile } from "node:fs/promises";
const base = "http://127.0.0.1:5173",
  browser = await chromium.launch({ channel: "msedge", headless: true }),
  context = await browser.newContext({
    storageState: ".local/browser-state.json",
    viewport: { width: 1440, height: 1000 },
    permissions: ["clipboard-read", "clipboard-write"],
  }),
  page = await context.newPage(),
  errors = [],
  suffix = Date.now();
page.on("pageerror", (e) => errors.push(e.message));
let secondary, visitor, peer, releaseSlow, releaseFence, releaseFollowups;
const headers = { "X-Kelvin-Client": "web", "X-Kelvin-Document-Schema": "1" };
const request = async (path, data, requestContext = context.request) => {
  const response = await requestContext.post(base + "/api" + path, {
    headers,
    data,
  });
  assert.equal(response.status(), 200, await response.text());
  return response.json();
};
const mutate = async (workspace, kind, title, data = {}, existing) => {
  return (
    await request(`/workspaces/${workspace}/mutate`, {
      operationId: crypto.randomUUID(),
      id: existing?.id || crypto.randomUUID(),
      expectedVersion: existing?.version || 0,
      kind,
      title,
      data,
    })
  ).resource;
};
const href = (id) => `${base}/?resource=${id}`;
const open = async (id) =>
  page.evaluate(
    (url) =>
      window.dispatchEvent(
        new CustomEvent("kelvin:navigation", { detail: { href: url } }),
      ),
    href(id),
  );
const title = (target) =>
  target
    .getByRole("dialog")
    .getByRole("textbox", { name: "Título", exact: true });
try {
  const profileResponse = await context.request.get(base + "/api/me");
  assert.equal(profileResponse.status(), 200);
  const profile = await profileResponse.json(),
    workspaceA = profile.workspaces[0],
    workspaceB = await request("/workspaces", {
      name: `Espacio de enlaces ${suffix}`,
    });
  const projectB = await mutate(
      workspaceB.id,
      "project",
      `Proyecto de destino ${suffix}`,
      {},
    ),
    taskA = await mutate(workspaceA.id, "task", `Tarea enlazada ${suffix}`, {
      status: "todo",
    }),
    poison = await mutate(
      workspaceA.id,
      "task",
      `Respuesta antigua ${suffix}`,
      { status: "todo" },
    ),
    documentB = await mutate(
      workspaceB.id,
      "document",
      `Documento enlazado ${suffix}`,
      {
        projectId: projectB.id,
        content: {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [
                {
                  type: "text",
                  text: "Abrir tarea de otro espacio",
                  marks: [
                    { type: "link", attrs: { href: `/?resource=${taskA.id}` } },
                  ],
                },
              ],
            },
          ],
        },
      },
    ),
    documentA = await mutate(
      workspaceA.id,
      "document",
      `Documento compartido ${suffix}`,
      {
        content: {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [
                {
                  type: "text",
                  text: "Seguir enlace de lectura",
                  marks: [
                    { type: "link", attrs: { href: `/?resource=${taskA.id}` } },
                  ],
                },
              ],
            },
          ],
        },
      },
    );
  const interrupted = await context.newPage();
  let releaseInitial;
  const initialGate = new Promise((resolve) => { releaseInitial = resolve; });
  const initialStarted = new Promise((resolve) => {
    interrupted.route(`**/api/resources/${documentB.id}/location`, async (route) => {
      resolve();
      await initialGate;
      await route.continue().catch(() => {});
    });
  });
  try {
    await interrupted.goto(href(documentB.id), { waitUntil: "domcontentloaded" });
    await initialStarted;
    await openSection(interrupted, "Todas las tareas");
    await interrupted.getByLabel("Buscar tareas", { exact: true }).fill(taskA.title);
    await expect(interrupted.getByText(taskA.title, { exact: true }).first()).toBeVisible();
    await expect(interrupted.getByText("Abriendo tu espacio…", { exact: true })).toHaveCount(0);
  } finally {
    releaseInitial();
    await interrupted.close();
  }
  await page.goto(href(documentB.id), { waitUntil: "domcontentloaded" });
  await expect(title(page)).toHaveValue(documentB.title);
  await expect(
    page.getByLabel("Espacio de trabajo", { exact: true }),
  ).toHaveValue(workspaceB.id);
  await page
    .locator(".tiptap a")
    .getByText("Abrir tarea de otro espacio", { exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "Copiar enlace", exact: true })
    .click();
  assert.equal(
    await page.evaluate(() => navigator.clipboard.readText()),
    href(documentB.id),
  );
  let readAttempts = 0,
    limitedAt = 0;
  const limitedPattern = `**/api/resources/${taskA.id}/location`;
  await page.route(limitedPattern, async (route) => {
    readAttempts++;
    if (readAttempts === 1) {
      limitedAt = Date.now();
      await route.fulfill({
        status: 429,
        headers: { "Retry-After": "1" },
        contentType: "application/json",
        body: JSON.stringify({ error: "Synthetic read quota" }),
      });
    } else await route.continue();
  });
  await page.locator(".tiptap a").click();
  await page
    .getByRole("button", { name: "Abrir enlace seleccionado", exact: true })
    .click();
  await expect(title(page)).toHaveValue(taskA.title);
  assert.equal(readAttempts, 2);
  assert.ok(Date.now() - limitedAt >= 900);
  await page.unroute(limitedPattern);
  await expect(
    page.getByLabel("Espacio de trabajo", { exact: true }),
  ).toHaveValue(workspaceA.id);
  await page.goBack();
  await expect(title(page)).toHaveValue(documentB.title);
  await page.goForward();
  await expect(title(page)).toHaveValue(taskA.title);
  await title(page).fill(`Borrador sin guardar ${suffix}`);
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.goBack();
  await expect(title(page)).toHaveValue(`Borrador sin guardar ${suffix}`);
  assert.equal(new URL(page.url()).searchParams.get("resource"), taskA.id);
  page.once("dialog", (dialog) => dialog.accept());
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Cerrar", exact: true })
    .click();
  assert.equal(new URL(page.url()).searchParams.has("resource"), false);
  // Hold an earlier workspace response until the linked destination is already rendered.
  let captured = false,
    returned = false;
  const gate = new Promise((resolve) => {
    releaseSlow = resolve;
  });
  const slowPattern = `**/api/workspaces/${workspaceA.id}/resources`;
  await page.route(slowPattern, async (route) => {
    if (captured) {
      await route.continue();
      return;
    }
    captured = true;
    const response = await route.fetch();
    await gate;
    try {
      await route.fulfill({ response });
    } catch {}
    returned = true;
  });
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect.poll(() => captured).toBe(true);
  await open(documentB.id);
  await expect(title(page)).toHaveValue(documentB.title);
  releaseSlow();
  await expect.poll(() => returned).toBe(true);
  await page.unroute(slowPattern);
  await page.waitForTimeout(150);
  await expect(title(page)).toHaveValue(documentB.title);
  await expect(
    page.getByLabel("Espacio de trabajo", { exact: true }),
  ).toHaveValue(workspaceB.id);
  assert.equal(
    await page
      .getByRole("dialog")
      .getByText(poison.title, { exact: true })
      .count(),
    0,
  );
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async () => {
          throw new Error("Synthetic unavailable clipboard");
        },
      },
    });
  });
  await page
    .getByRole("button", { name: "Copiar enlace", exact: true })
    .click();
  await expect(
    page.getByLabel("Enlace al elemento", { exact: true }),
  ).toHaveValue(href(documentB.id));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: "docs/evidence/navigation-copy-mobile.png",
    fullPage: true,
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
  await page.goto(href(taskA.id), { waitUntil: "domcontentloaded" });
  await expect(title(page)).toHaveValue(taskA.title);
  await page.goto(href(documentB.id), { waitUntil: "domcontentloaded" });
  await expect(title(page)).toHaveValue(documentB.title);
  await expect(
    page.getByLabel("Espacio de trabajo", { exact: true }),
  ).toHaveValue(workspaceB.id);
  await context.setOffline(false);
  // Initial links survive the unauthenticated screen and password sign-in.
  secondary = await browser.newContext();
  const signIn = await secondary.newPage();
  await signIn.goto(href(taskA.id), { waitUntil: "domcontentloaded" });
  await signIn
    .getByLabel("Correo electrónico", { exact: true })
    .fill("browser@example.test");
  await signIn
    .getByLabel("Contraseña", { exact: true })
    .fill("browser-test-password-long");
  await signIn.getByRole("button", { name: "Entrar", exact: true }).click();
  await expect(title(signIn)).toHaveValue(taskA.title);
  await secondary.request.post(base + "/api/logout", { headers, data: {} });
  await secondary.close();
  secondary = undefined;
  const email = `navigation-reader-${suffix}@example.test`,
    invitation = await request(`/workspaces/${workspaceA.id}/invitations`, {
      email,
      role: "viewer",
    });
  visitor = await browser.newContext();
  const accepted = await request(
    "/invitations/accept",
    {
      email,
      name: "Lector de enlaces",
      password: "navigation-test-password-long",
      token: new URL(invitation.url).searchParams.get("invitation"),
    },
    visitor.request,
  );
  assert.equal((await visitor.request.get(base + "/api/me")).status(), 200);
  const reader = await visitor.newPage();
  reader.on("pageerror", (e) => errors.push(e.message));
  await reader.goto(href(documentB.id), { waitUntil: "domcontentloaded" });
  await reader
    .getByRole("alert")
    .filter({ hasText: "El enlace no está disponible para esta cuenta." })
    .waitFor();
  assert.ok(
    !(await reader.locator("body").innerText()).includes(documentB.title),
  );
  assert.ok(
    !(await reader.locator("body").innerText()).includes(workspaceB.name),
  );
  await reader.goto(href(documentA.id), { waitUntil: "domcontentloaded" });
  await expect(title(reader)).toHaveValue(documentA.title);
  assert.equal(await title(reader).isEditable(), false);
  const opened = reader.waitForEvent("popup");
  await reader.locator(".tiptap a").click();
  const linkedReader = await opened;
  await expect(title(linkedReader)).toHaveValue(taskA.title);
  assert.equal(await title(linkedReader).isEditable(), false);
  await linkedReader.close();
  await reader.goto(href(documentA.id), { waitUntil: "domcontentloaded" });
  await expect(title(reader)).toHaveValue(documentA.title);
  const oldSnapshot = await (
    await visitor.request.get(
      `${base}/api/workspaces/${workspaceA.id}/resources`,
    )
  ).json();
  await reader.route(`**/api/workspaces/${workspaceA.id}/resources`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(oldSnapshot),
    }),
  );
  const privateDocument = await mutate(
    workspaceA.id,
    "document",
    documentA.title,
    { ...documentA.data, ownerId: profile.user.id },
    documentA,
  );
  await reader.goto(href(documentA.id), { waitUntil: "domcontentloaded" });
  await reader
    .getByRole("alert")
    .filter({ hasText: "El enlace no está disponible para esta cuenta." })
    .waitFor();
  assert.equal(await reader.getByRole("dialog").count(), 0);
  await controlledByServiceWorker(reader);
  await controlledByServiceWorker(reader);
  await visitor.setOffline(true);
  await reader.reload({ waitUntil: "domcontentloaded" });
  await reader
    .getByRole("alert")
    .filter({ hasText: "El último control de acceso rechazó este enlace" })
    .waitFor();
  assert.equal(await reader.getByRole("dialog").count(), 0);
  await visitor.setOffline(false);
  await reader.unroute(`**/api/workspaces/${workspaceA.id}/resources`);
  const restoredData = { ...privateDocument.data };
  delete restoredData.ownerId;
  await mutate(
    workspaceA.id,
    "document",
    documentA.title,
    restoredData,
    privateDocument,
  );
  await reader.reload({ waitUntil: "domcontentloaded" });
  await expect(title(reader)).toHaveValue(documentA.title);
  await context.setOffline(false);
  await open(taskA.id);
  await expect(title(page)).toHaveValue(taskA.title);
  peer = await context.newPage();
  await peer.goto(href(taskA.id), { waitUntil: "domcontentloaded" });
  await expect(title(peer)).toHaveValue(taskA.title);
  let currentTask = taskA;
  for (const mode of ["snapshot", "outbox"]) {
    let fenceCaptured = false,
      fenceReturned = false;
    const fence = new Promise((resolve) => {
        releaseFence = resolve;
      }),
      followups = new Promise((resolve) => {
        releaseFollowups = resolve;
      });
    const fencePattern = `**/api/workspaces/${workspaceA.id}/resources`;
    await page.route(fencePattern, async (route) => {
      if (fenceCaptured) {
        await followups;
        try {
          await route.continue();
        } catch {}
        return;
      }
      fenceCaptured = true;
      const response = await route.fetch();
      await fence;
      try {
        await route.fulfill({ response });
      } catch {}
      fenceReturned = true;
    });
    await page.bringToFront();
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect.poll(() => fenceCaptured).toBe(true);
    const newTitle = `Tarea actualizada ${mode} ${suffix}`;
    if (mode === "snapshot")
      currentTask = await mutate(
        workspaceA.id,
        "task",
        newTitle,
        currentTask.data,
        currentTask,
      );
    else {
      await peer.route(fencePattern, async (route) => {
        await followups;
        try {
          await route.continue();
        } catch {}
      });
      const acknowledged = peer.waitForResponse(
        (response) =>
          response.url().endsWith(`/api/workspaces/${workspaceA.id}/mutate`) &&
          response.status() === 200,
      );
      await title(peer).fill(newTitle);
      await peer
        .getByRole("button", { name: "Guardar cambios", exact: true })
        .click();
      await acknowledged;
      await expect
        .poll(() =>
          peer.evaluate(
            ({ userId, id }) =>
              new Promise((resolve, reject) => {
                const open = indexedDB.open(`kelvin-${userId}`);
                open.onerror = () => reject(open.error);
                open.onsuccess = () => {
                  const db = open.result,
                    request = db
                      .transaction("outbox")
                      .objectStore("outbox")
                      .getAll();
                  request.onsuccess = () => {
                    resolve(
                      request.result.some((item) => item.resource.id === id),
                    );
                    db.close();
                  };
                  request.onerror = () => reject(request.error);
                };
              }),
            { userId: profile.user.id, id: taskA.id },
          ),
        )
        .toBe(false);
    }
    await expect(title(peer)).toHaveValue(newTitle);
    releaseFence();
    await expect.poll(() => fenceReturned).toBe(true);
    await expect(title(page)).toHaveValue(newTitle);
    releaseFollowups();
    await page.unroute(fencePattern);
    if (mode === "outbox") await peer.unroute(fencePattern);
  }
  await peer.close();
  peer = undefined;
  await page.goto(href(documentB.id), { waitUntil: "domcontentloaded" });
  await expect(title(page)).toHaveValue(documentB.title);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({
    path: "docs/evidence/navigation-document-desktop.png",
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  await context.storageState({ path: ".local/browser-state.json" });
  await writeFile(
    "docs/evidence/navigation-check.json",
    JSON.stringify(
      {
        verifiedAt: new Date().toISOString(),
        syntheticData: true,
        crossWorkspacePermalinks: true,
        editorLinkOpening: true,
        readOnlyDocumentLinks: true,
        historyBackForward: true,
        unsavedMetadataGuard: true,
        staleWorkspaceResponseIsolation: true,
        sameWorkspaceSnapshotFence: true,
        acknowledgedOutboxFence: true,
        clipboardAndFallback: true,
        mobileOverflow: false,
        offlineCrossWorkspaceLinks: true,
        linkAfterSignIn: true,
        opaqueDeniedTarget: true,
        denialDoesNotFallBackToCache: true,
        permissionRestoration: true,
        readQuotaBackoff: true,
        interruptedInitialNavigation: true,
        pageErrors: errors,
      },
      null,
      2,
    ),
  );
  console.info(
    "Permalinks, cross-workspace history, stale-response isolation, offline copies and permission-scoped navigation verified.",
  );
} catch (error) {
  for (const reader of visitor?.pages() || []) {
    await reader.screenshot({
      path: ".local/navigation-reader-failure.png",
      fullPage: true,
    });
    console.error(
      "Synthetic reader failure state:",
      await reader.locator("body").innerText(),
    );
  }
  await page.screenshot({
    path: ".local/navigation-failure.png",
    fullPage: true,
  });
  throw error;
} finally {
  releaseSlow?.();
  releaseFence?.();
  releaseFollowups?.();
  await peer?.close();
  await context.setOffline(false);
  await visitor?.setOffline(false);
  await visitor?.request
    .post(base + "/api/logout", { headers, data: {} })
    .catch(() => {});
  await secondary?.close();
  await visitor?.close();
  await browser.close();
}
