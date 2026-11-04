import assert from "node:assert/strict";
import { controlledByServiceWorker } from './service-worker-helper.mjs';
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
  suffix = Date.now(),
  errors = [];
page.on("pageerror", (error) => errors.push(error.message));
let workspaceId, project, task, milestone, risk, release;
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
const area = async (name) =>
  page
    .getByRole("navigation", { name: "Áreas de planificación", exact: true })
    .getByRole("button", { name, exact: true })
    .click();
const snapshot = async () => {
  const response = await page.request.get(
    `${base}/api/workspaces/${workspaceId}/resources`,
  );
  assert.equal(response.status(), 200);
  return (await response.json()).resources;
};
const mutate = async (kind, title, data = {}, existing) => {
  const response = await page.request.post(
    `${base}/api/workspaces/${workspaceId}/mutate`,
    {
      headers: { "X-Kelvin-Client": "web", "X-Kelvin-Document-Schema": "1" },
      data: {
        operationId: crypto.randomUUID(),
        id: existing?.id || crypto.randomUUID(),
        expectedVersion: existing?.version || 0,
        kind,
        title,
        data,
      },
    },
  );
  assert.equal(response.status(), 200, await response.text());
  return (await response.json()).resource;
};
const stored = async (title) => {
  let result;
  await expect
    .poll(async () => {
      result = (await snapshot()).find((r) => r.title === title);
      return !!result;
    })
    .toBe(true);
  return result;
};
const saveForm = async () => {
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Guardar planificación", exact: true })
    .click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await expect(
    page.getByRole("region", { name: "Detalle de planificación", exact: true }),
  ).toHaveCount(1);
};
const check = async () => {
  await page
    .getByRole("button", { name: "Comprobar entrega", exact: true })
    .click();
  await page
    .getByRole("button", {
      name: /^Confirmar hito alcanzado$|^Confirmar publicación$|^Aceptar decisión$/,
    })
    .waitFor();
};
const options = async (first, second, reason) => {
  const dialog = page.getByRole("dialog");
  await dialog
    .getByRole("button", { name: "Añadir alternativa", exact: true })
    .click();
  await dialog.getByLabel("Alternativa 1", { exact: true }).fill(first);
  await dialog
    .getByLabel("Ventajas y costes de alternativa 1", { exact: true })
    .fill("Ventajas y límites documentados con datos sintéticos.");
  await dialog
    .getByRole("button", { name: "Añadir alternativa", exact: true })
    .click();
  await dialog.getByLabel("Alternativa 2", { exact: true }).fill(second);
  await dialog
    .getByLabel("Alternativa elegida", { exact: true })
    .selectOption({ label: first });
  await dialog
    .getByLabel("Motivo de la decisión", { exact: true })
    .fill(reason);
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
  project = await mutate("project", `Entregas verificadas ${suffix}`, {
    description: "Synthetic delivery workflow qualification",
  });
  task = await mutate("task", `Validar entrega ${suffix}`, {
    projectId: project.id,
    status: "todo",
    estimate: 3,
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page
    .getByRole("heading", { name: "Hoy", exact: true })
    .waitFor();
  await nav("Hoja de ruta");
  await page
    .getByLabel("Proyecto de planificación", { exact: true })
    .selectOption(project.id);
  await page.getByRole("button", { name: "Crear hito", exact: true }).click();
  let dialog = page.getByRole("dialog");
  await dialog
    .getByLabel("Título de planificación", { exact: true })
    .fill(`Hito verificable ${suffix}`);
  await dialog
    .getByLabel("Objetivo de la entrega", { exact: true })
    .fill("Demostrar alcance, comprobaciones e historial duradero.");
  await dialog
    .getByLabel("Fecha de inicio", { exact: true })
    .fill("2026-11-03");
  await dialog
    .getByLabel("Fecha límite de planificación", { exact: true })
    .fill("2026-11-15");
  await dialog
    .getByLabel("Tareas del hito", { exact: true })
    .selectOption([task.id]);
  await saveForm();
  milestone = await stored(`Hito verificable ${suffix}`);
  await check();
  await page
    .getByText(`Tarea pendiente: ${task.title}`, { exact: true })
    .waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "Confirmar hito alcanzado", exact: true })
      .isDisabled(),
    true,
  );
  task = await mutate(
    "task",
    task.title,
    { ...task.data, status: "done" },
    task,
  );
  await check();
  await page
    .getByText("Todas las condiciones están satisfechas.", { exact: true })
    .waitFor();
  task = await mutate("task", task.title, { ...task.data, estimate: 5 }, task);
  await page
    .getByRole("alert")
    .filter({ hasText: "El alcance cambió desde la comprobación" })
    .waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "Confirmar hito alcanzado", exact: true })
      .isDisabled(),
    true,
  );
  await check();
  await page
    .getByLabel("Nota de confirmación", { exact: true })
    .fill("Hito revisado con su equipo.");
  await page
    .getByRole("button", { name: "Confirmar hito alcanzado", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "Confirmación conservada", exact: true })
    .waitFor();
  milestone = (await snapshot()).find((r) => r.id === milestone.id);
  assert.equal(
    milestone.data.deliveryReceipt.items.find((r) => r.id === task.id).estimate,
    5,
  );
  await page
    .getByRole("button", { name: "Volver a planificación", exact: true })
    .click();
  await area("Riesgo");
  await page.getByRole("button", { name: "Crear riesgo", exact: true }).click();
  dialog = page.getByRole("dialog");
  await dialog
    .getByLabel("Título de planificación", { exact: true })
    .fill(`Riesgo revisado ${suffix}`);
  await dialog
    .getByLabel("Estado de planificación", { exact: true })
    .selectOption("accepted");
  await dialog
    .getByLabel("Responsable de planificación", { exact: true })
    .selectOption(profile.user.id);
  await dialog.getByLabel("Probabilidad del riesgo", { exact: true }).fill("2");
  await dialog.getByLabel("Impacto del riesgo", { exact: true }).fill("4");
  await dialog
    .getByLabel("Motivo para aceptar el riesgo", { exact: true })
    .fill("Impacto acotado y plan de contingencia revisado.");
  await dialog
    .getByLabel("Medidas de mitigación", { exact: true })
    .fill("Restauración ensayada antes de cada publicación.");
  await dialog
    .getByLabel("Plan de contingencia", { exact: true })
    .fill("Volver a la versión anterior conservando los datos.");
  await saveForm();
  risk = await stored(`Riesgo revisado ${suffix}`);
  await page
    .getByText("Probabilidad 2/5 × impacto 4/5 = 8/25", { exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "Volver a planificación", exact: true })
    .click();
  await area("Versión");
  await page
    .getByRole("button", { name: "Crear versión", exact: true })
    .click();
  dialog = page.getByRole("dialog");
  await dialog
    .getByLabel("Título de planificación", { exact: true })
    .fill(`Versión verificable ${suffix}`);
  await dialog
    .getByLabel("Objetivo de la entrega", { exact: true })
    .fill(
      "Entregar el hito con riesgos revisados y comprobación de recuperación.",
    );
  await dialog
    .getByLabel("Identificador de versión", { exact: true })
    .fill("1.2.0");
  await dialog
    .getByLabel("Etiqueta del repositorio", { exact: true })
    .fill("v1.2.0");
  await dialog
    .getByLabel("Enlace del repositorio", { exact: true })
    .fill("https://example.test/team/repository");
  await dialog
    .getByLabel("Hitos de la versión", { exact: true })
    .selectOption([milestone.id]);
  await dialog
    .getByLabel("Riesgos de la versión", { exact: true })
    .selectOption([risk.id]);
  await dialog
    .getByLabel("Notas de publicación", { exact: true })
    .fill("Entrega sintética para verificar el flujo completo.");
  await dialog
    .getByLabel("Fecha de inicio", { exact: true })
    .fill("2026-11-15");
  await dialog
    .getByLabel("Fecha límite de planificación", { exact: true })
    .fill("2026-11-20");
  await dialog
    .getByRole("button", { name: "Añadir comprobación", exact: true })
    .click();
  await dialog
    .getByLabel("Texto de comprobación 1", { exact: true })
    .fill("Restauración y rutas verificadas");
  await saveForm();
  release = await stored(`Versión verificable ${suffix}`);
  await check();
  await page
    .getByText("Comprobación pendiente: Restauración y rutas verificadas", {
      exact: true,
    })
    .waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "Confirmar publicación", exact: true })
      .isDisabled(),
    true,
  );
  await page
    .getByRole("button", { name: "Editar planificación", exact: true })
    .click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("Completar comprobación 1", { exact: true }).check();
  await saveForm();
  await check();
  await page
    .getByText("Todas las condiciones están satisfechas.", { exact: true })
    .waitFor();
  const pattern = `**/api/workspaces/${workspaceId}/planning/${release.id}/confirm`;
  let committed;
  await page.route(pattern, async (route) => {
    const response = await route.fetch();
    assert.equal(response.status(), 200);
    committed = await response.json();
    await route.abort("failed");
  });
  await page
    .getByRole("button", { name: "Confirmar publicación", exact: true })
    .click();
  await expect.poll(() => !!committed).toBe(true);
  await page
    .getByRole("button", { name: "Reintentar comando pendiente", exact: true })
    .waitFor();
  await page.unroute(pattern);
  await page
    .getByRole("button", { name: "Reintentar comando pendiente", exact: true })
    .click();
  await page
    .getByText("Confirmación recuperada del servidor sin duplicar la entrega.", { exact: true })
    .waitFor();
  await page
    .getByRole("heading", { name: "Confirmación conservada", exact: true })
    .waitFor();
  release = (await snapshot()).find((r) => r.id === release.id);
  assert.equal(release.version, committed.version);
  assert.equal(release.data.status, "released");
  await page
    .getByRole("button", { name: "Comentarios e historial", exact: true })
    .click();
  const discussion = page.getByRole("dialog");
  assert.equal(
    await discussion.getByLabel("Título", { exact: true }).isEditable(),
    false,
  );
  await discussion
    .getByLabel("Añadir comentario", { exact: true })
    .fill(`Publicación revisada por el equipo ${suffix}`);
  await discussion
    .getByRole("button", { name: "Comentar", exact: true })
    .click();
  await discussion
    .getByText(`Publicación revisada por el equipo ${suffix}`, { exact: true })
    .waitFor();
  await discussion
    .getByRole("button", { name: "Historial", exact: true })
    .click();
  await discussion
    .getByText("No hay versiones sincronizadas.", { exact: true })
    .waitFor({ state: "hidden" });
  await discussion.getByRole("button", { name: "Cerrar", exact: true }).click();

  assert.equal(
    release.data.deliveryReceipt.items.find((r) => r.id === risk.id).riskScore,
    8,
  );
  await page
    .getByRole("button", { name: "Volver a planificación", exact: true })
    .click();
  await area("Decisión");
  await page
    .getByRole("button", { name: "Crear decisión", exact: true })
    .click();
  dialog = page.getByRole("dialog");
  await dialog
    .getByLabel("Proyecto del registro", { exact: true })
    .selectOption(project.id);
  await dialog
    .getByLabel("Título de planificación", { exact: true })
    .fill(`Decisión inicial ${suffix}`);
  await options(
    "Aplicación modular",
    "Servicios separados",
    "Menor consumo y operación sencilla.",
  );
  await saveForm();
  const firstDecision = await stored(`Decisión inicial ${suffix}`);
  await check();
  await page
    .getByRole("button", { name: "Aceptar decisión", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "Confirmación conservada", exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "Volver a planificación", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Crear decisión", exact: true })
    .click();
  dialog = page.getByRole("dialog");
  await dialog
    .getByLabel("Proyecto del registro", { exact: true })
    .selectOption(project.id);
  await dialog
    .getByLabel("Título de planificación", { exact: true })
    .fill(`Decisión revisada ${suffix}`);
  await options(
    "Revisar el límite del módulo",
    "Mantener el límite",
    "Nuevas medidas justifican un cambio acotado.",
  );
  await dialog
    .getByLabel("Decisión aceptada a sustituir", { exact: true })
    .selectOption(firstDecision.id);
  await saveForm();
  const secondDecision = await stored(`Decisión revisada ${suffix}`);
  await check();
  await page
    .getByRole("button", { name: "Aceptar decisión", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "Confirmación conservada", exact: true })
    .waitFor();
  const old = (await snapshot()).find((r) => r.id === firstDecision.id);
  assert.equal(old.data.status, "superseded");
  assert.equal(old.data.delivery.supersededById, secondDecision.id);
  await page
    .getByRole("button", { name: "Volver a planificación", exact: true })
    .click();
  await area("Riesgo");
  await page.getByRole("button", { name: "Crear riesgo", exact: true }).click();
  dialog = page.getByRole("dialog");
  await dialog
    .getByLabel("Título de planificación", { exact: true })
    .fill(`Riesgo sin conexión ${suffix}`);
  await dialog
    .getByLabel("Proyecto del registro", { exact: true })
    .selectOption(project.id);
  await dialog
    .getByLabel("Medidas de mitigación", { exact: true })
    .fill("Borrador conservado tras recargar.");
  await dialog
    .getByText("Borrador de planificación conservado en este dispositivo.", {
      exact: true,
    })
    .waitFor();
  await controlledByServiceWorker(page);
  await controlledByServiceWorker(page);
  await context.setOffline(true);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page
    .getByRole("heading", { name: "Hoja de ruta", exact: true })
    .waitFor();
  await nav("Hoja de ruta");
  await area("Riesgo");
  await page.getByRole("button", { name: "Crear riesgo", exact: true }).click();
  dialog = page.getByRole("dialog");
  await expect(
    dialog.getByLabel("Título de planificación", { exact: true }),
  ).toHaveValue(`Riesgo sin conexión ${suffix}`);
  await expect(
    dialog.getByLabel("Medidas de mitigación", { exact: true }),
  ).toHaveValue("Borrador conservado tras recargar.");
  await saveForm();
  await page
    .getByRole("heading", {
      name: `Riesgo sin conexión ${suffix}`,
      exact: true,
    })
    .waitFor();
  await context.setOffline(false);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page
    .getByRole("heading", { name: "Hoja de ruta", exact: true })
    .waitFor();
  await stored(`Riesgo sin conexión ${suffix}`);
  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await nav("Hoja de ruta");
    await area("Hoja de ruta");
    await page
      .getByLabel("Proyecto de planificación", { exact: true })
      .selectOption(project.id);
    await page.screenshot({
      path: `docs/evidence/delivery-roadmap-${width}.png`,
      fullPage: true,
    });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    await page
      .locator(".delivery-row")
      .filter({
        has: page.getByRole("button", { name: release.title, exact: true }),
      })
      .getByRole("button", { name: release.title, exact: true })
      .click();
    await page
      .getByRole("heading", { name: "Confirmación conservada", exact: true })
      .waitFor();
    await page.screenshot({
      path: `docs/evidence/delivery-receipt-${width}.png`,
      fullPage: true,
    });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    await page
      .getByRole("button", { name: "Volver a planificación", exact: true })
      .click();
  }
  assert.deepEqual(errors, []);
  await context.storageState({ path: ".local/browser-state.json" });
  await writeFile(
    "docs/evidence/delivery-check.json",
    JSON.stringify(
      {
        verifiedAt: new Date().toISOString(),
        syntheticData: true,
        milestoneConditions: true,
        staleScopeProtection: true,
        riskEvaluationAndAcceptance: true,
        releaseChecklist: true,
        immutableConfirmation: true,
        planningDiscussionAndHistory: true,
        lostResponseReloadRetry: true,
        decisionSupersession: true,
        offlineDraftReloadAndOutbox: true,
        responsiveWidths: [1440, 768, 390],
        pageErrors: errors,
      },
      null,
      2,
    ),
  );
  console.info(
    "Milestones, release conditions, risks, decision supersession, offline drafts and durable confirmation replay verified.",
  );
} catch (error) {
  await page.screenshot({
    path: ".local/delivery-failure.png",
    fullPage: true,
  });
  throw error;
} finally {
  await context.setOffline(false);
  await browser.close();
}
