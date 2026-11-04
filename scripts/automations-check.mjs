import { chromium } from "@playwright/test";
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
const waitFor = async (read, accept, description) => {
  for (let count = 0; count < 60; count++) {
    const result = await read();
    if (accept(result)) return result;
    await page.waitForTimeout(1000);
  }
  throw new Error(description);
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
    projectId = crypto.randomUUID(),
    ruleTitle = `Revisar entradas ${suffix}`,
    projectTitle = `Reglas de equipo ${suffix}`;
  const snapshot = async () =>
    await (
      await page.request.get(`${base}/api/workspaces/${workspaceId}/resources`)
    ).json();
  const create = async (kind, title, data = {}) => {
    const result = await page.request.post(
      `${base}/api/workspaces/${workspaceId}/mutate`,
      {
        headers: { "X-Kelvin-Client": "web", "X-Kelvin-Document-Schema": "1" },
        data: {
          id: kind === "project" ? projectId : crypto.randomUUID(),
          kind,
          title,
          data,
          operationId: crypto.randomUUID(),
          expectedVersion: 0,
        },
      },
    );
    if (!result.ok())
      throw new Error("Could not prepare synthetic automation fixture");
    return (await result.json()).resource;
  };
  await create("project", projectTitle);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page
    .getByRole("heading", { name: "Hoy", exact: true })
    .waitFor();
  const navigate = async (name) => {
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
  await navigate("Hoja de ruta");
  await page
    .getByRole("navigation", { name: "Áreas de planificación" })
    .getByRole("button", { name: "Reglas y ejecuciones", exact: true })
    .click();
  await page
    .locator(".planning-section")
    .filter({
      has: page.getByRole("heading", {
        name: "Reglas del proyecto",
        exact: true,
      }),
    })
    .getByRole("button", { name: "Añadir regla", exact: true })
    .click();
  let dialog = page.getByRole("dialog");
  await dialog.getByLabel("Título", { exact: true }).fill(ruleTitle);
  await dialog.getByLabel("Proyecto", { exact: true }).selectOption(projectId);
  await dialog
    .getByRole("button", { name: "Crear automatización", exact: true })
    .click();
  dialog = page.locator(".resource-dialog");
  await dialog
    .getByLabel("Cuándo", { exact: true })
    .selectOption("task_created");
  await dialog
    .getByLabel("Acción automática", { exact: true })
    .selectOption("set_status");
  await dialog
    .getByLabel("Estado de destino", { exact: true })
    .selectOption("review");
  await dialog
    .getByLabel("Solo tareas con etiqueta", { exact: true })
    .fill("auto");
  await dialog.getByLabel("Activar regla", { exact: true }).check();
  await dialog
    .getByRole("button", { name: "Guardar cambios", exact: true })
    .click();
  await dialog.getByText("Guardado", { exact: true }).waitFor();
  await dialog.getByRole("button", { name: "Cerrar", exact: true }).click();
  const resources = await waitFor(
    snapshot,
    (data) =>
      data.resources?.some((r) => r.title === ruleTitle && r.data.enabled),
    "Rule did not synchronize",
  );
  const rule = resources.resources.find((r) => r.title === ruleTitle);
  const task = await create("task", `Entrada automática ${suffix}`, {
    projectId,
    status: "todo",
    labels: ["auto"],
  });
  await waitFor(
    snapshot,
    (data) =>
      data.resources?.find((r) => r.id === task.id)?.data.status === "review",
    "Background rule did not execute",
  );
  await page
    .getByRole("button", { name: "Actualizar historial", exact: true })
    .click();
  const row = page
    .locator(".automation-run")
    .filter({ has: page.getByText(ruleTitle, { exact: true }) });
  await row.getByText(/Completada/).waitFor();
  await row.getByText("Historial de intentos", { exact: true }).click();
  await row.getByText(/Intento 1: Completada/).waitFor();
  await page.screenshot({
    path: "docs/evidence/automations-desktop.png",
    fullPage: true,
  });
  const recurring = await create("task", `Ronda diaria ${suffix}`, {
    projectId,
    status: "todo",
    dueDate: new Date().toISOString().slice(0, 10),
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page
    .getByRole("heading", { name: "Hoy", exact: true })
    .waitFor();
  await navigate("Todas las tareas");
  await page.getByLabel("Buscar tareas", { exact: true }).fill(recurring.title);
  await page
    .getByRole("button", { name: new RegExp(recurring.title) })
    .first()
    .click();
  dialog = page.locator(".resource-dialog");
  await dialog
    .getByLabel("Al completar, repetir", { exact: true })
    .selectOption("daily");
  await dialog
    .getByRole("button", { name: "Guardar cambios", exact: true })
    .click();
  await dialog.getByText("Guardado", { exact: true }).waitFor();
  await dialog.getByRole("button", { name: "Cerrar", exact: true }).click();
  await waitFor(
    snapshot,
    (data) =>
      data.resources?.find((r) => r.id === recurring.id)?.data.recurrence ===
      "daily",
    "Recurrence did not synchronize",
  );
  await page
    .getByRole("button", { name: new RegExp(recurring.title) })
    .first()
    .click();
  dialog = page.locator(".resource-dialog");
  await dialog.getByLabel("Estado", { exact: true }).selectOption("done");
  await dialog
    .getByRole("button", { name: "Guardar cambios", exact: true })
    .click();
  await dialog.getByText("Guardado", { exact: true }).waitFor();
  await dialog.getByRole("button", { name: "Cerrar", exact: true }).click();
  const result = await waitFor(
    snapshot,
    (data) =>
      data.resources?.filter(
        (r) => r.kind === "task" && r.title === recurring.title,
      ).length === 2,
    "Recurring task was not created",
  );
  const next = result.resources.find(
    (r) => r.title === recurring.title && r.id !== recurring.id,
  );
  if (
    next.data.status !== "todo" ||
    next.data.dueDate <= recurring.data.dueDate
  )
    throw new Error("Recurrence output was invalid");
  await navigate("Hoja de ruta");
  await page
    .getByRole("navigation", { name: "Áreas de planificación" })
    .getByRole("button", { name: "Reglas y ejecuciones", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Actualizar historial", exact: true })
    .click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: "docs/evidence/automations-mobile.png",
    fullPage: true,
  });
  if (
    await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)
  )
    throw new Error("Automation history overflows on mobile");
  await page
    .locator(".planning-section")
    .filter({
      has: page.getByRole("heading", {
        name: "Reglas del proyecto",
        exact: true,
      }),
    })
    .getByRole("button", { name: new RegExp(ruleTitle) })
    .click();
  await page
    .getByRole("heading", { name: "Regla de ejecución", exact: true })
    .waitFor();
  await page.screenshot({
    path: "docs/evidence/automation-rule-mobile.png",
    fullPage: false,
  });
  if (
    await page.evaluate(() => {
      const dialog = document.querySelector("dialog");
      return dialog.scrollWidth > dialog.clientWidth + 1;
    })
  )
    throw new Error("Automation editor overflows on mobile");
  if (errors.length) throw new Error(errors.join("\n"));
  const history = await (
    await page.request.get(
      `${base}/api/workspaces/${workspaceId}/automations/runs`,
    )
  ).json();
  if (!history.worker.lastTick || history.worker.lastError)
    throw new Error("Background worker heartbeat failed");
  await writeFile(
    "docs/evidence/automations-check.json",
    JSON.stringify(
      {
        verifiedAt: new Date().toISOString(),
        syntheticData: true,
        ruleCreationAndActivation: true,
        backgroundEventExecution: true,
        immutableAttemptHistory: true,
        recurrenceConfiguredInUI: true,
        backgroundNextOccurrence: true,
        mobileOverflow: false,
        workerHeartbeat: true,
        pageErrors: errors,
      },
      null,
      2,
    ),
  );
  console.info(
    "Automation rules, background execution, attempt history, recurrence and mobile layout verified.",
  );
} catch (error) {
  await page
    .screenshot({ path: ".local/automation-failure.png", fullPage: true })
    .catch(() => {});
  console.error(
    await page
      .locator("body")
      .innerText()
      .catch(() => ""),
  );
  throw error;
} finally {
  await browser.close();
}
