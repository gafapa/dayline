import { chromium } from "@playwright/test";
import { openSection } from './navigation-helper.mjs';
import { readFile, writeFile } from "node:fs/promises";
import { TOTP, Secret } from "otpauth";
const base = "http://127.0.0.1:5173",
  password = "browser-test-password-long";
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
let securityContext;
try {
  await page.goto(base, { waitUntil: "domcontentloaded" });
  if (!(await page.request.get(base + "/api/me")).ok()) {
    await page
      .getByLabel("Correo electrónico", { exact: true })
      .fill("browser@example.test");
    await page.getByLabel("Contraseña", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Entrar", exact: true }).click();
  }
  await page
    .getByRole("heading", { name: "Hoy", exact: true })
    .waitFor();
  await openSection(page, "Documentos");
  await page
    .getByRole("button", { name: "Nuevo documento", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByLabel("Título", { exact: true })
    .fill(`Documento enriquecido ${Date.now()}`);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Crear documento", exact: true })
    .click();
  await page.locator(".tiptap").waitFor();
  await page
    .locator(".tiptap")
    .fill(
      "Documento de verificación de tablas, fórmulas, diagramas y adjuntos.",
    );
  await page.getByRole("button", { name: "Tabla", exact: true }).click();
  await page.locator(".tiptap table").waitFor();
  await page
    .getByRole("button", { name: "Lista de tareas", exact: true })
    .click();
  await page.locator('.tiptap ul[data-type="taskList"]').waitFor();
  page.once("dialog", (dialog) => dialog.accept("x^2+y^2=z^2"));
  await page
    .getByRole("button", { name: "Fórmula matemática", exact: true })
    .click();
  await page.locator(".tiptap .katex").first().waitFor();
  await page
    .getByRole("button", { name: "Diagrama Mermaid", exact: true })
    .click();
  await page
    .getByAltText("Diagrama generado a partir del bloque Mermaid")
    .waitFor({ timeout: 60000 });
  await page
    .locator(".editor-toolbar input[type=file]")
    .setInputFiles({
      name: "pixel.png",
      mimeType: "image/png",
      buffer: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=",
        "base64",
      ),
    });
  await page
    .locator(".tiptap img:not(.ProseMirror-separator)")
    .first()
    .waitFor();
  await page.getByText("Guardado en el servidor", { exact: true }).waitFor();
  await page
    .getByLabel("Formato de exportación", { exact: true })
    .selectOption("html");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Exportar", exact: true }).click();
  const output = await download;
  const html = await readFile(await output.path(), "utf8");
  if (!html.includes("<table>") || !html.includes("data:image/png;base64,"))
    throw new Error("HTML export did not embed the table/image");
  await page.screenshot({
    path: "docs/evidence/document-features.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Historial", exact: true }).click();
  await page
    .getByRole("button", {
      name: "Conservar versión actual del servidor",
      exact: true,
    })
    .click();
  await page
    .getByRole("button", {
      name: "Comparar con el contenido actual",
      exact: true,
    })
    .first()
    .click();
  await page
    .getByRole("heading", { name: "Comparación de contenido", exact: true })
    .waitFor();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Cerrar", exact: true })
    .click();
  const profile = await (await page.request.get(`${base}/api/me`)).json();
  const email = `security-ui-${Date.now()}@example.test`;
  const invitation = await page.request.post(
    `${base}/api/workspaces/${profile.workspaces[0].id}/invitations`,
    { headers: { "X-Kelvin-Client": "web", "X-Kelvin-Document-Schema": "1" }, data: { email, role: "member" } },
  );
  if (!invitation.ok()) throw new Error("Could not create security UI fixture");
  securityContext = await browser.newContext();
  const securityPage = await securityContext.newPage();
  await securityPage.goto((await invitation.json()).url, {
    waitUntil: "domcontentloaded",
  });
  await securityPage
    .getByLabel("Tu nombre", { exact: true })
    .fill("Verificación de seguridad");
  await securityPage
    .getByLabel("Correo electrónico", { exact: true })
    .fill(email);
  await securityPage.getByLabel("Contraseña", { exact: true }).fill(password);
  await securityPage
    .getByRole("button", { name: "Aceptar invitación", exact: true })
    .click();
  await securityPage
    .getByRole("heading", { name: "Hoy", exact: true })
    .waitFor();
  await securityPage
    .getByRole("button", { name: "Configuración", exact: true })
    .click();
  await securityPage
    .getByRole("button", { name: "Seguridad", exact: true })
    .click();
  const setup = securityPage
    .locator("form")
    .filter({
      has: securityPage.getByRole("button", {
        name: "Configurar autenticador",
        exact: true,
      }),
    });
  await setup.getByLabel("Contraseña actual", { exact: true }).fill(password);
  await setup
    .getByRole("button", { name: "Configurar autenticador", exact: true })
    .click();
  const secret = await securityPage
    .getByLabel("Clave para introducir manualmente", { exact: true })
    .inputValue();
  const otp = new TOTP({
    secret: Secret.fromBase32(secret),
    digits: 6,
    period: 30,
  }).generate();
  await securityPage
    .getByLabel("Código de verificación", { exact: true })
    .fill(otp);
  await securityPage
    .getByRole("button", { name: "Activar verificación", exact: true })
    .click();
  await securityPage
    .getByRole("heading", { name: "Guarda estos códigos", exact: true })
    .waitFor();
  const codes = (await securityPage.locator(".recovery-codes pre").innerText())
    .trim()
    .split("\n");
  await securityPage
    .getByRole("button", { name: "Ya los he guardado", exact: true })
    .click();
  const disable = securityPage
    .locator("form")
    .filter({
      has: securityPage.getByRole("button", {
        name: "Desactivar verificación",
        exact: true,
      }),
    });
  await disable.getByLabel("Contraseña actual", { exact: true }).fill(password);
  await disable
    .getByLabel("O código de recuperación", { exact: true })
    .fill(codes[0]);
  securityPage.once("dialog", (dialog) => dialog.accept());
  await disable
    .getByRole("button", { name: "Desactivar verificación", exact: true })
    .click();
  await securityPage
    .getByRole("button", { name: "Configurar autenticador", exact: true })
    .waitFor();
  if (errors.length) throw new Error(errors.join("\n"));
  await writeFile(
    "docs/evidence/features-check.json",
    JSON.stringify(
      {
        verifiedAt: new Date().toISOString(),
        syntheticData: true,
        table: true,
        taskList: true,
        mathematics: true,
        mermaidPreview: true,
        imageUpload: true,
        selfContainedHTMLExport: true,
        contentCheckpoint: true,
        contentComparison: true,
        mfaSetupAndRecoveryDisable: true,
        pageErrors: errors,
      },
      null,
      2,
    ),
  );
  console.info(
    "Rich documents, self-contained export, content history and MFA UI verified.",
  );
} finally {
  await securityContext?.close();
  await browser.close();
}
