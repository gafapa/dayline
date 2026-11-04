import { chromium } from "@playwright/test";
import { controlledByServiceWorker } from './service-worker-helper.mjs';
import { openSection } from './navigation-helper.mjs';
import { writeFile } from "node:fs/promises";
const base = "http://127.0.0.1:5173",
  browser = await chromium.launch({ channel: "msedge", headless: true });
const context = await browser.newContext({
    ...(process.env.BROWSER_STATE
      ? { storageState: process.env.BROWSER_STATE }
      : {}),
    viewport: { width: 1440, height: 1000 },
  }),
  page = await context.newPage(),
  errors = [];
page.on("pageerror", (error) => errors.push(error.message));
let participantContext;
const waitFor = async (read, accept, message) => {
  for (let attempt = 0; attempt < 60; attempt++) {
    const value = await read();
    if (accept(value)) return value;
    await page.waitForTimeout(500);
  }
  throw new Error(message);
};
const navigation = async (target, name) => {
  if (
    await target
      .getByRole("button", { name: "Abrir navegación", exact: true })
      .isVisible()
  )
    await target
      .getByRole("button", { name: "Abrir navegación", exact: true })
      .click();
  await openSection(target, name);
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
  const profile = await (await page.request.get(`${base}/api/me`)).json(),
    workspaceId = profile.workspaces[0].id,
    suffix = Date.now(),
    title = `Sprint compartido ${suffix}`,
    ownerName = profile.user.name;
  const snapshot = async () =>
    await (
      await page.request.get(`${base}/api/workspaces/${workspaceId}/resources`)
    ).json();
  const create = async (kind, title, data = {}) => {
    const response = await page.request.post(
      `${base}/api/workspaces/${workspaceId}/mutate`,
      {
        headers: { "X-Kelvin-Client": "web", "X-Kelvin-Document-Schema": "1" },
        data: {
          id: crypto.randomUUID(),
          operationId: crypto.randomUUID(),
          kind,
          title,
          data,
          expectedVersion: 0,
        },
      },
    );
    if (!response.ok())
      throw new Error("Could not prepare synthetic sprint fixture");
    return (await response.json()).resource;
  };
  const project = await create("project", `Entregas de prueba ${suffix}`),
    first = await create("task", `Revisar entrega ${suffix}`, {
      projectId: project.id,
      status: "in_progress",
      estimate: 3,
      assigneeId: profile.user.id,
    }),
    second = await create("task", `Preparar seguimiento ${suffix}`, {
      projectId: project.id,
      status: "todo",
      estimate: 5,
      assigneeId: profile.user.id,
    }),
    future = await create("sprint", `Siguiente sprint ${suffix}`, {
      status: "planned",
    });
  await navigation(page, "Sprints");
  await page.getByRole("button", { name: "Nuevo sprint", exact: true }).click();
  let dialog = page.getByRole("dialog");
  await dialog.getByLabel("Título", { exact: true }).fill(title);
  await dialog
    .getByLabel("Objetivo del sprint", { exact: true })
    .fill("Verificar planificación, estimación y cierre con datos sintéticos.");
  await dialog
    .getByRole("button", { name: "Crear sprint", exact: true })
    .click();
  await page
    .locator(".resource-dialog")
    .getByRole("button", { name: "Cerrar", exact: true })
    .click();
  const records = await waitFor(
      snapshot,
      (data) => data.resources?.some((resource) => resource.title === title),
      "Sprint did not synchronize",
    ),
    sprint = records.resources.find((resource) => resource.title === title),
    sprintBase = `${base}/api/workspaces/${workspaceId}/sprints/${sprint.id}`;
  await page
    .getByLabel("Sprint de trabajo", { exact: true })
    .selectOption(sprint.id);
  await page
    .getByLabel("Añadir tarea al sprint", { exact: true })
    .selectOption(first.id);
  await page
    .getByLabel("Añadir tarea al sprint", { exact: true })
    .selectOption(second.id);
  await page
    .getByLabel("Añadir capacidad de una persona", { exact: true })
    .selectOption(profile.user.id);
  await page
    .getByLabel(`Días disponibles de ${ownerName}`, { exact: true })
    .fill("10");
  await page
    .getByLabel(`Dedicación de ${ownerName} (%)`, { exact: true })
    .fill("75");
  await page
    .getByLabel(`Capacidad en puntos de ${ownerName}`, { exact: true })
    .fill("5");
  await page
    .getByText("La carga supera la capacidad indicada en puntos.", {
      exact: true,
    })
    .waitFor();
  await page
    .getByLabel(`Capacidad en puntos de ${ownerName}`, { exact: true })
    .fill("8");
  const definition =
    "Código revisado, pruebas guardadas y entrega demostrable.";
  await page
    .getByLabel("Definición de terminado del sprint", { exact: true })
    .fill(definition);
  await page
    .getByLabel("Nuevo criterio de cierre", { exact: true })
    .fill("Demostración revisada");
  await page
    .getByRole("button", { name: "Añadir criterio", exact: true })
    .click();
  await page
    .getByText("Borrador guardado en este dispositivo.", { exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "Estimación compartida", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Planificación", exact: true })
    .last()
    .click();
  await controlledByServiceWorker(page);
  await controlledByServiceWorker(page);
  await context.setOffline(true);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Sprints", exact: true }).waitFor();
  await navigation(page, "Sprints");
  await page
    .getByLabel("Sprint de trabajo", { exact: true })
    .selectOption(sprint.id);
  await page
    .getByLabel("Definición de terminado del sprint", { exact: true })
    .waitFor();
  await waitFor(
    () =>
      page
        .getByLabel("Definición de terminado del sprint", { exact: true })
        .inputValue(),
    (value) => value === definition,
    "Offline planning draft was lost",
  );
  await page
    .getByText("45 horas disponibles · 8 puntos asignados de 8", {
      exact: true,
    })
    .waitFor();
  await page.screenshot({
    path: "docs/evidence/sprint-offline-draft.png",
    fullPage: true,
  });
  await context.setOffline(false);
  await page
    .getByRole("button", { name: "Guardar planificación", exact: true })
    .click();
  await waitFor(
    async () => await (await page.request.get(sprintBase + "/planning")).json(),
    (data) =>
      data.tasks?.length === 2 &&
      data.sprint.data.capacityPlan?.[0]?.points === 8,
    "Plan did not save",
  );
  await page.getByText("Plan sincronizado", { exact: true }).waitFor();
  await page
    .getByRole("button", { name: "Iniciar sprint", exact: true })
    .click();
  await page
    .getByText("Sprint iniciado; su alcance inicial se conserva.", {
      exact: true,
    })
    .waitFor();
  await page
    .getByRole("button", { name: "Estimación compartida", exact: true })
    .click();
  await page
    .getByLabel("Tarea para estimar", { exact: true })
    .selectOption(first.id);
  await page
    .getByRole("button", { name: "Iniciar ronda", exact: true })
    .click();
  await page
    .locator(".poker-deck")
    .getByRole("button", { name: "3", exact: true })
    .click();
  await page.getByText("Tu carta: 3", { exact: true }).waitFor();
  const email = `sprint-player-${suffix}@example.test`,
    invitation = await page.request.post(
      `${base}/api/workspaces/${workspaceId}/invitations`,
      {
        headers: { "X-Kelvin-Client": "web", "X-Kelvin-Document-Schema": "1" },
        data: { email, role: "member" },
      },
    );
  if (!invitation.ok())
    throw new Error("Could not prepare planning participant");
  participantContext = await browser.newContext({
    viewport: { width: 1200, height: 900 },
  });
  const participant = await participantContext.newPage();
  participant.on("pageerror", (error) => errors.push(error.message));
  await participant.goto((await invitation.json()).url, {
    waitUntil: "domcontentloaded",
  });
  await participant
    .getByLabel("Tu nombre", { exact: true })
    .fill("Participante de estimación");
  await participant
    .getByLabel("Correo electrónico", { exact: true })
    .fill(email);
  await participant
    .getByLabel("Contraseña", { exact: true })
    .fill("browser-test-password-long");
  await participant.getByLabel("Repite la contraseña", { exact: true }).fill("browser-test-password-long");
  await participant
    .getByRole("button", { name: "Aceptar invitación", exact: true })
    .click();
  await participant
    .getByRole("heading", { name: "Hoy", exact: true })
    .waitFor();
  await navigation(participant, "Sprints");
  await participant
    .getByLabel("Sprint de trabajo", { exact: true })
    .selectOption(sprint.id);
  await participant
    .getByRole("button", { name: "Estimación compartida", exact: true })
    .click();
  await participant
    .locator(".poker-deck")
    .getByRole("button", { name: "8", exact: true })
    .click();
  await participant.getByText("Tu carta: 8", { exact: true }).waitFor();
  await waitFor(
    () => page.locator(".poker-participants strong").allTextContents(),
    (values) =>
      values.length === 2 && values.every((value) => value === "Carta oculta"),
    "Other votes were visible before reveal",
  );
  await page
    .getByRole("button", { name: "Revelar cartas", exact: true })
    .click();
  await page
    .locator(".poker-participants strong")
    .getByText("8", { exact: true })
    .waitFor();
  await participant
    .locator(".poker-participants strong")
    .getByText("3", { exact: true })
    .waitFor();
  await page.screenshot({
    path: "docs/evidence/sprint-poker-desktop.png",
    fullPage: true,
  });
  await page
    .getByLabel("Estimación acordada en puntos", { exact: true })
    .fill("5");
  await page
    .getByRole("button", { name: "Aplicar estimación acordada", exact: true })
    .click();
  await waitFor(
    snapshot,
    (data) =>
      data.resources?.find((resource) => resource.id === first.id)?.data
        .estimate === 5,
    "Consensus estimate was not applied",
  );
  const current = (await snapshot()).resources.find(
    (resource) => resource.id === first.id,
  );
  const completed = await page.request.post(
    `${base}/api/workspaces/${workspaceId}/mutate`,
    {
      headers: { "X-Kelvin-Client": "web", "X-Kelvin-Document-Schema": "1" },
      data: {
        id: first.id,
        operationId: crypto.randomUUID(),
        kind: "task",
        title: current.title,
        data: { ...current.data, status: "done" },
        expectedVersion: current.version,
      },
    },
  );
  if (!completed.ok()) throw new Error("Could not complete synthetic delivery");
  await page
    .getByRole("button", { name: "Actualizar datos", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Planificación", exact: true })
    .last()
    .click();
  await page.getByText("Plan sincronizado", { exact: true }).waitFor();
  await page
    .getByRole("button", { name: "Preparar cierre", exact: true })
    .click();
  await page
    .getByLabel("Destino de las tareas pendientes", { exact: true })
    .selectOption(future.id);
  await page
    .getByRole("checkbox", { name: /Confirmo el cierre con 1 criterios/ })
    .check();
  await page
    .getByRole("button", { name: "Confirmar cierre del sprint", exact: true })
    .click();
  await page
    .getByText(
      "Sprint cerrado. Su alcance y sus estimaciones quedan conservados.",
      { exact: true },
    )
    .waitFor();
  const closure = await (
    await page.request.get(sprintBase + "/planning")
  ).json();
  if (
    closure.sprint.data.snapshot.length !== 2 ||
    (await snapshot()).resources.find((resource) => resource.id === second.id)
      ?.data.sprintId !== future.id
  )
    throw new Error("Closure or rollover was incorrect");
  await page
    .getByRole("button", { name: "Revisión y retrospectiva", exact: true })
    .click();
  const delivery =
    "Demostración con una entrega completada y seguimiento planificado.";
  await page
    .getByLabel("Resultado del objetivo", { exact: true })
    .selectOption("partial");
  await page
    .getByLabel("Trabajo entregado y demostración", { exact: true })
    .fill(delivery);
  await page
    .getByLabel("Qué funcionó bien", { exact: true })
    .fill("Estimaciones secretas y capacidad visible.");
  await page
    .getByLabel("Qué queremos mejorar", { exact: true })
    .fill("Dividir antes las tareas grandes.");
  await page
    .getByText("Borrador de revisión guardado en este dispositivo.", {
      exact: true,
    })
    .waitFor();
  await page.getByRole("button", { name: "Métricas", exact: true }).click();
  await page
    .getByRole("img", { name: "Burndown: puntos pendientes", exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "Revisión y retrospectiva", exact: true })
    .click();
  await waitFor(
    () =>
      page
        .getByLabel("Trabajo entregado y demostración", { exact: true })
        .inputValue(),
    (value) => value === delivery,
    "Review draft was lost after changing area",
  );
  const followUpTitle = `Mejora acordada ${suffix}`;
  await page
    .getByLabel("Nueva acción de mejora", { exact: true })
    .fill(followUpTitle);
  await page
    .getByRole("button", { name: "Crear tarea de mejora", exact: true })
    .click();
  const followUpSnapshot = await waitFor(
    snapshot,
    (data) =>
      data.resources?.some((resource) => resource.title === followUpTitle),
    "Follow-up task did not synchronize",
  );
  const followUp = followUpSnapshot.resources.find(
    (resource) => resource.title === followUpTitle,
  );
  if (followUp.data.targetId !== sprint.id || followUp.data.sprintId)
    throw new Error(
      "Follow-up task did not inherit the sprint access context outside its frozen scope",
    );
  await page
    .getByRole("button", {
      name: "Guardar revisión y retrospectiva",
      exact: true,
    })
    .click();
  await page
    .getByText("Revisión y retrospectiva guardadas.", { exact: true })
    .waitFor();
  const review = await (
    await page.request.get(sprintBase + "/ceremonies")
  ).json();
  if (!review.data.retrospective.actionIds.includes(followUp.id))
    throw new Error("Follow-up task was not linked to the retrospective");
  await page
    .getByText("Versiones de revisión y retrospectiva", { exact: true })
    .click();
  await page
    .getByRole("button", { name: "Consultar versiones", exact: true })
    .click();
  await page
    .locator(".ceremony-version")
    .getByText(delivery, { exact: true })
    .waitFor();
  await page.getByRole("button", { name: "Métricas", exact: true }).click();
  await page
    .getByRole("img", {
      name: "Burnup: alcance y puntos completados",
      exact: true,
    })
    .waitFor();
  await page.screenshot({
    path: "docs/evidence/sprint-metrics-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: "docs/evidence/sprint-metrics-mobile.png",
    fullPage: true,
  });
  if (
    await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)
  )
    throw new Error("Sprint metrics overflow on mobile");
  await page
    .getByRole("button", { name: "Planificación", exact: true })
    .last()
    .click();
  await page.screenshot({
    path: "docs/evidence/sprint-planning-mobile.png",
    fullPage: true,
  });
  if (
    await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)
  )
    throw new Error("Sprint planning overflows on mobile");
  if (errors.length) throw new Error(errors.join("\n"));
  const metrics = await (
    await page.request.get(sprintBase + "/metrics")
  ).json();
  if (
    metrics.baseline.scope !== 8 ||
    metrics.final.scope !== 10 ||
    metrics.final.done !== 5
  )
    throw new Error("Historical scope metrics did not match delivered state");
  await writeFile(
    "docs/evidence/sprints-check.json",
    JSON.stringify(
      {
        verifiedAt: new Date().toISOString(),
        syntheticData: true,
        sprintCreation: true,
        capacityPlanning: true,
        localPlanDraftAcrossAreas: true,
        offlineReloadPlanDraft: true,
        immutableStartBaseline: true,
        twoParticipantPoker: true,
        votesHiddenBeforeReveal: true,
        explicitEstimateApplication: true,
        reviewDraftAcrossAreas: true,
        ceremonyHistory: true,
        followUpTaskCreation: true,
        closureExceptionsAcknowledged: true,
        selectedRolloverSprint: true,
        scopeAndDeliveryMetrics: true,
        mobileOverflow: false,
        pageErrors: errors,
      },
      null,
      2,
    ),
  );
  console.info(
    "Sprint capacity, offline drafts, secret collaborative estimates, reviews, rollover and historical metrics verified.",
  );
} catch (error) {
  await context.setOffline(false);
  await page
    .screenshot({ path: ".local/sprint-failure.png", fullPage: true })
    .catch(() => {});
  console.error(
    await page
      .locator("body")
      .innerText()
      .catch(() => ""),
  );
  console.error("Page errors:", errors);
  throw error;
} finally {
  await context.setOffline(false);
  await participantContext?.close();
  await browser.close();
}
