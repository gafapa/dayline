import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { writeFile } from "node:fs/promises";
const base = "http://127.0.0.1:5173",
  headers = { "X-Kelvin-Client": "web", "X-Kelvin-Document-Schema": "1" },
  suffix = Date.now();
const browser = await chromium.launch({ channel: "msedge", headless: true });
const owner = await browser.newContext({
    storageState: ".local/browser-state.json",
  }),
  member = await browser.newContext({ viewport: { width: 390, height: 844 } }),
  page = await member.newPage(),
  errors = [];
page.on("pageerror", (error) => errors.push(error.message));
async function post(context, path, data, method = "POST") {
  const response = await context.request.fetch(base + "/api" + path, {
    method,
    headers,
    data,
  });
  assert.equal(response.status(), 200, await response.text());
  return response.json();
}
try {
  const profile = await (await owner.request.get(base + "/api/me")).json(),
    workspace = profile.workspaces[0];
  const invitation = await post(
    owner,
    `/workspaces/${workspace.id}/invitations`,
    { email: `live-access-${suffix}@example.test`, role: "member" },
  );
  await post(member, "/invitations/accept", {
    email: `live-access-${suffix}@example.test`,
    name: "Live access reader",
    password: "synthetic-live-access-password",
    token: new URL(invitation.url).searchParams.get("invitation"),
  });
  const memberProfile = await (
    await member.request.get(base + "/api/me")
  ).json();
  const document = (
    await post(owner, `/workspaces/${workspace.id}/mutate`, {
      id: crypto.randomUUID(),
      kind: "document",
      title: `Acceso activo ${suffix}`,
      data: {
        content: {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [
                {
                  type: "text",
                  text: "Contenido autorizado antes del cambio.",
                },
              ],
            },
          ],
        },
      },
      expectedVersion: 0,
      operationId: crypto.randomUUID(),
    })
  ).resource;
  await page.goto(`${base}/?resource=${document.id}`, {
    waitUntil: "domcontentloaded",
  });
  await expect(page.locator(".tiptap")).toHaveAttribute(
    "contenteditable",
    "true",
  );
  await page.getByText("Guardado en el servidor", { exact: true }).waitFor();
  const stale = await (
    await member.request.get(`${base}/api/workspaces/${workspace.id}/resources`)
  ).json();
  const pattern = `**/api/workspaces/${workspace.id}/resources`;
  await page.route(pattern, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(stale),
    }),
  );
  await post(
    owner,
    `/workspaces/${workspace.id}/members/${memberProfile.user.id}`,
    { role: "viewer" },
    "PATCH",
  );
  await expect(page.locator(".tiptap")).toHaveAttribute(
    "contenteditable",
    "false",
  );
  await post(
    owner,
    `/workspaces/${workspace.id}/members/${memberProfile.user.id}`,
    { role: "member" },
    "PATCH",
  );
  await expect(page.locator(".tiptap")).toHaveAttribute(
    "contenteditable",
    "true",
  );
  const updated = (
    await post(owner, `/workspaces/${workspace.id}/mutate`, {
      id: document.id,
      kind: "document",
      title: document.title,
      data: { ...document.data, ownerId: profile.user.id },
      expectedVersion: document.version,
      operationId: crypto.randomUUID(),
    })
  ).resource;
  await page
    .getByText(/El acceso ha cambiado\. Tu copia local se conserva/)
    .waitFor();
  await expect(page.locator(".tiptap")).toHaveAttribute(
    "contenteditable",
    "false",
  );
  await expect(page.locator(".tiptap")).toContainText(
    "Contenido autorizado antes del cambio.",
  );
  await page.screenshot({
    path: "docs/evidence/collaboration-access-mobile.png",
    fullPage: false,
  });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  await page.unroute(pattern);
  const { ownerId, ...shared } = updated.data;
  await post(owner, `/workspaces/${workspace.id}/mutate`, {
    id: updated.id,
    kind: "document",
    title: updated.title,
    data: shared,
    expectedVersion: updated.version,
    operationId: crypto.randomUUID(),
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator(".tiptap")).toHaveAttribute(
    "contenteditable",
    "true",
  );
  await page.getByText("Guardado en el servidor", { exact: true }).waitFor();
  assert.deepEqual(errors, []);
  await writeFile(
    "docs/evidence/collaboration-access-check.json",
    JSON.stringify(
      {
        verifiedAt: new Date().toISOString(),
        syntheticData: true,
        establishedSocketRoleDowngrade: true,
        roleRestoration: true,
        editorDisabledAfterRevocation: true,
        staleSnapshotDoesNotKeepEditorWritable: true,
        explicitReopenAfterAccessRestoration: true,
        localCopyPreserved: true,
        mobileOverflow: false,
        pageErrors: errors,
      },
      null,
      2,
    ) + "\n",
  );
  console.info(
    "Established collaboration permissions and editor recovery verified with a stale HTTP snapshot.",
  );
} finally {
  await member.request
    .post(base + "/api/logout", { headers, data: {} })
    .catch(() => {});
  await owner.close();
  await member.close();
  await browser.close();
}
