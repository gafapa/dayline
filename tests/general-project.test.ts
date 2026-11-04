import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createDatabase, migrate, type Database } from "../server/database";
import { createApp } from "../server/app";
import type { Resource } from "../shared/model";

let db: Database, api: Awaited<ReturnType<typeof createApp>>, workspaceId: string, ownerId: string, cookie: string;
const headers = { "x-kelvin-client": "web", origin: "http://general.test" };
const request = (method: any, url: string, payload?: any) =>
  api.app.inject({ method, url, payload, headers: { ...headers, cookie } });
const mutate = (kind: string, title: string, data: any = {}, id: string = randomUUID(), expectedVersion = 0, deleted = false) =>
  request("POST", `/api/workspaces/${workspaceId}/mutate`, { id, kind, title, data, expectedVersion, operationId: randomUUID(), deleted });
async function make(kind: string, title: string, data: any = {}) {
  const response = await mutate(kind, title, data);
  assert.equal(response.statusCode, 200, response.body);
  return response.json().resource as Resource;
}
const generals = async () =>
  (await db.query<Resource>("SELECT * FROM resources WHERE workspace_id=$1 AND kind='project' AND data->>'general'='true' AND deleted_at IS NULL", [workspaceId])).rows;

before(async () => {
  db = await createDatabase(undefined, "memory://");
  await migrate(db);
  api = await createApp(db, { origin: "http://general.test", setupToken: "general-setup", encryptionKey: "ab".repeat(32) });
  const setup = await api.app.inject({
    method: "POST",
    url: "/api/setup",
    headers,
    payload: { email: "general@example.test", password: "general-password", name: "General owner", workspaceName: "General tests", setupToken: "general-setup" },
  });
  assert.equal(setup.statusCode, 200, setup.body);
  cookie = setup.headers["set-cookie"]!.toString().split(";")[0];
  const me = (await request("GET", "/api/me")).json();
  workspaceId = me.workspaces[0].id;
  ownerId = me.user.id;
});
after(async () => {
  await api.app.close();
  await db.close();
});

test("tasks and root team documents without a project go to one General project", async () => {
  assert.equal((await generals()).length, 0, "General is created on first use only");
  const [a, b] = await Promise.all([make("task", "Sin proyecto A"), make("task", "Sin proyecto B")]);
  const doc = await make("document", "Acta suelta");
  const [general] = await generals();
  assert.ok(general);
  assert.equal(general.title, "General");
  assert.equal((await generals()).length, 1);
  for (const r of [a, b, doc]) assert.equal(r.data.projectId, general.id);
  const project = await make("project", "Producto");
  const owned = await make("task", "Con proyecto", { projectId: project.id });
  assert.equal(owned.data.projectId, project.id);
});

test("personal notes stay personal and child documents take their parent's project", async () => {
  const note = await make("document", "Mi nota", { personalNote: true, ownerId });
  assert.equal(note.data.projectId, undefined);
  const project = await make("project", "Con documentos");
  const parent = await make("document", "Padre", { projectId: project.id });
  const child = await make("document", "Hijo", { parentId: parent.id });
  assert.equal(child.data.projectId, project.id);
});

test("the General project cannot be removed, archived or impersonated", async () => {
  const [general] = await generals();
  const removed = await mutate("project", general.title, general.data, general.id, general.version, true);
  assert.equal(removed.statusCode, 409);
  const archived = await mutate("project", general.title, { ...general.data, archived: true }, general.id, general.version);
  assert.equal(archived.statusCode, 409);
  const renamed = await mutate("project", "General del equipo", { status: "active" }, general.id, general.version);
  assert.equal(renamed.statusCode, 200, renamed.body);
  assert.equal(renamed.json().resource.data.general, true, "keeps its mark when a client omits it");
  const impostor = await make("project", "Otro", { general: true });
  assert.equal(impostor.data.general, undefined);
  assert.equal((await generals()).length, 1);
});

test("the migration moves existing team work without a project into General", async () => {
  const id = randomUUID();
  await db.query(
    "INSERT INTO resources(id,workspace_id,kind,title,data,created_by) VALUES($1,$2,'task','Antigua sin proyecto',$3,$4)",
    [id, workspaceId, JSON.stringify({ status: "todo" }), ownerId],
  );
  await migrate(db);
  const [general] = await generals();
  const moved = (await db.query<Resource>("SELECT * FROM resources WHERE id=$1", [id])).rows[0];
  assert.equal(moved.data.projectId, general.id);
});
