import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as Y from "yjs";
import {
  HocuspocusProvider,
  HocuspocusProviderWebsocket,
} from "@hocuspocus/provider";
import { createDatabase, migrate, type Database } from "../server/database";
import { createApp } from "../server/app";
import { createCollaboration } from "../server/collaboration";
import { digest } from "../server/security";
import { documentText } from "../shared/documents";
import type { Resource } from "../shared/model";
const origin = "http://test.local";
let db: Database,
  api: Awaited<ReturnType<typeof createApp>>,
  collaboration: ReturnType<typeof createCollaboration>;
const clients: {
  provider: HocuspocusProvider;
  socket: HocuspocusProviderWebsocket;
  document: Y.Doc;
}[] = [];
async function until(check: () => boolean | Promise<boolean>, label: string) {
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`Timed out: ${label}`);
}
const headers = { origin, "x-kelvin-client": "web", "X-Kelvin-Document-Schema": "1" };
let pausedMember: string | undefined;
let releaseAccess: (() => void) | undefined;
let accessPaused = false;
before(async () => {
  db = await createDatabase(undefined, "memory://");
  await migrate(db);
  const collaborationDatabase: Database = {
    ...db,
    async query(sql, parameters) {
      const result = await db.query(sql, parameters);
      if (
        pausedMember &&
        sql.includes("SELECT role FROM memberships") &&
        parameters?.[0] === pausedMember
      ) {
        pausedMember = undefined;
        accessPaused = true;
        await new Promise<void>((resolve) => {
          releaseAccess = resolve;
        });
      }
      return result;
    },
  };
  collaboration = createCollaboration(collaborationDatabase, origin, {
    recheckIntervalMs: 500,
  });
  collaboration.server.configuration.port = 0;
  collaboration.server.configuration.stopOnSignals = false;
  api = await createApp(db, {
    origin,
    encryptionKey: "ab".repeat(32),
    onAccessChange: collaboration.revalidateConnections,
  });
  await collaboration.server.listen();
});
after(async () => {
  releaseAccess?.();
  for (const client of clients) {
    client.provider.destroy();
    client.socket.destroy();
    client.document.destroy();
  }
  await collaboration.server.destroy();
  await api.app.close();
  await db.close();
});

test("a sweep requested as an empty sweep finishes still checks newly registered connections", async () => {
  const first = collaboration.revalidateConnections();
  const id = randomUUID();
  let connected = true;
  const peer = {
    context: { userId: randomUUID(), sessionHash: "expired", documentId: id },
    close() {
      connected = false;
    },
  };
  collaboration.server.hocuspocus.documents.set(id, {
    getConnections: () => (connected ? [peer] : []),
  } as any);
  try {
    const second = collaboration.revalidateConnections();
    await Promise.all([first, second]);
    assert.equal(connected, false);
  } finally {
    collaboration.server.hocuspocus.documents.delete(id);
  }
});

test("an authorization read started before a role change cannot return the superseded role", async () => {
  const f = await fixture();
  pausedMember = f.member;
  accessPaused = false;
  const oldRead = collaboration.authorize({
    userId: f.member,
    sessionHash: digest(f.memberToken),
    documentId: f.document.id,
  });
  try {
    await until(() => accessPaused, "old membership read captured");
    await f.request("PATCH", `/workspaces/${f.workspace}/members/${f.member}`, {
      role: "viewer",
    });
    releaseAccess?.();
    assert.equal((await oldRead).role, "viewer");
  } finally {
    releaseAccess?.();
    pausedMember = undefined;
    await oldRead.catch(() => {});
  }
});
async function fixture() {
  const workspace = randomUUID(),
    owner = randomUUID(),
    member = randomUUID(),
    ownerToken = randomUUID(),
    memberToken = randomUUID();
  await db.transaction(async (tx) => {
    await tx.query("INSERT INTO workspaces(id,name) VALUES($1,$2)", [
      workspace,
      "Live access test",
    ]);
    for (const [id, token, role] of [
      [owner, ownerToken, "admin"],
      [member, memberToken, "member"],
    ]) {
      await tx.query(
        "INSERT INTO app_users(id,email,name,password_hash) VALUES($1,$2,$3,$4)",
        [id, `${id}@example.test`, role, "unused-test-hash"],
      );
      await tx.query("INSERT INTO memberships VALUES($1,$2,$3)", [
        workspace,
        id,
        role,
      ]);
      await tx.query(
        "INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",
        [digest(token), id],
      );
    }
  });
  const request = async (
    method: any,
    path: string,
    payload?: any,
    token = ownerToken,
  ) => {
    const result = await api.app.inject({
      method,
      url: "/api" + path,
      payload,
      headers: { ...headers, cookie: `kelvin_session=${token}` },
    });
    assert.equal(result.statusCode, 200, result.body);
    return result.json();
  };
  const make = async (kind: string, data: any = {}) =>
    (
      await request("POST", `/workspaces/${workspace}/mutate`, {
        id: randomUUID(),
        operationId: randomUUID(),
        expectedVersion: 0,
        kind,
        title: "Shared fixture",
        data,
      })
    ).resource as Resource;
  const parent = await make("project");
  const document = await make("document", {
    projectId: parent.id,
    content: {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "Baseline" }] },
      ],
    },
  });
  return {
    workspace,
    owner,
    member,
    ownerToken,
    memberToken,
    request,
    parent,
    document,
  };
}
async function connect(userId: string, token: string, documentId: string) {
  class OriginWebSocket extends WebSocket {
    constructor(url: string) {
      super(url, { headers: { Origin: origin } } as any);
    }
  }
  const document = new Y.Doc();
  const socket = new HocuspocusProviderWebsocket({
    url: `ws://127.0.0.1:${collaboration.server.address.port}`,
    WebSocketPolyfill: OriginWebSocket,
    autoConnect: false,
    maxAttempts: 1,
  });
  const provider = new HocuspocusProvider({
    websocketProvider: socket,
    document,
    name: documentId,
    token: collaboration.issue(userId, digest(token)),
  });
  const result = { provider, socket, document };
  clients.push(result);
  provider.attach();
  void socket.connect();
  await until(() => provider.isSynced, "initial document sync");
  return result;
}
function connection(documentId: string, userId: string) {
  return collaboration.server.hocuspocus.documents
    .get(documentId)
    ?.getConnections()
    .find((c) => (c.context as any).userId === userId);
}
const edit = (document: Y.Doc, text: string) => {
  const paragraph = document.getXmlFragment("default").get(0) as Y.XmlElement;
  (paragraph.get(0) as Y.XmlText).insert(0, text);
};
async function storedText(id: string) {
  return documentText(
    (await db.query<Resource>("SELECT * FROM resources WHERE id=$1", [id]))
      .rows[0].data.content,
  );
}
async function close(...items: Awaited<ReturnType<typeof connect>>[]) {
  for (const item of items) {
    item.provider.destroy();
    item.socket.destroy();
    item.document.destroy();
  }
}

test("an idle editor is downgraded before the role-change response and cannot persist further edits", async () => {
  const f = await fixture(),
    owner = await connect(f.owner, f.ownerToken, f.document.id),
    member = await connect(f.member, f.memberToken, f.document.id);
  try {
    const modes: boolean[] = [];
    member.provider.on("stateless", ({ payload }: { payload: string }) => {
      const message = JSON.parse(payload);
      if (message.type === "access-mode") modes.push(message.readOnly);
    });
    await f.request("PATCH", `/workspaces/${f.workspace}/members/${f.member}`, {
      role: "viewer",
    });
    assert.equal(connection(f.document.id, f.member)?.readOnly, true);
    await until(() => modes.includes(true), "read-only access notification");
    edit(member.document, "FORBIDDEN ");
    let checked = false;
    member.provider.on("stateless", ({ payload }: { payload: string }) => {
      if (JSON.parse(payload).type === "durable") checked = true;
    });
    member.provider.sendStateless('{"type":"durability-check"}');
    await until(() => checked, "read-only durability round trip");
    assert.equal(await storedText(f.document.id), "Baseline");
    edit(owner.document, "Allowed ");
    await until(
      async () => (await storedText(f.document.id)).includes("Allowed"),
      "owner update persisted",
    );
    await f.request("PATCH", `/workspaces/${f.workspace}/members/${f.member}`, {
      role: "member",
    });
    assert.equal(connection(f.document.id, f.member)?.readOnly, false);
    await until(
      () => modes.includes(false),
      "restored editor access notification",
    );
  } finally {
    await close(member, owner);
  }
});

test("making a parent private disconnects its idle descendant reader before returning", async () => {
  const f = await fixture(),
    owner = await connect(f.owner, f.ownerToken, f.document.id),
    member = await connect(f.member, f.memberToken, f.document.id);
  try {
    await f.request("POST", `/workspaces/${f.workspace}/mutate`, {
      id: f.parent.id,
      kind: "project",
      title: f.parent.title,
      data: { private: true, members: [f.owner] },
      expectedVersion: f.parent.version,
      operationId: randomUUID(),
    });
    assert.equal(connection(f.document.id, f.member), undefined);
    member.socket.disconnect();
    edit(owner.document, "Private after revocation ");
    await until(
      async () =>
        (await storedText(f.document.id)).includes("Private after revocation"),
      "private owner update",
    );
    assert.equal(
      member.document
        .getXmlFragment("default")
        .toString()
        .includes("Private after revocation"),
      false,
    );
  } finally {
    await close(member, owner);
  }
});

test("membership removal and document deletion close established connections", async () => {
  const f = await fixture(),
    member = await connect(f.member, f.memberToken, f.document.id),
    owner = await connect(f.owner, f.ownerToken, f.document.id);
  try {
    await f.request("PATCH", `/workspaces/${f.workspace}/members/${f.member}`, {
      role: null,
    });
    assert.equal(connection(f.document.id, f.member), undefined);
    member.socket.disconnect();
    await f.request("POST", `/workspaces/${f.workspace}/mutate`, {
      id: f.document.id,
      kind: "document",
      title: f.document.title,
      data: f.document.data,
      deleted: true,
      expectedVersion: f.document.version,
      operationId: randomUUID(),
    });
    assert.equal(connection(f.document.id, f.owner), undefined);
  } finally {
    await close(member, owner);
  }
});

test("logout and explicit session revocation close all documents on that session", async () => {
  for (const action of ["logout", "revoke"]) {
    const f = await fixture(),
      member = await connect(f.member, f.memberToken, f.document.id);
    try {
      if (action === "logout")
        await f.request("POST", "/logout", {}, f.memberToken);
      else
        await f.request(
          "DELETE",
          `/sessions/${digest(f.memberToken)}`,
          undefined,
          f.memberToken,
        );
      assert.equal(connection(f.document.id, f.member), undefined);
    } finally {
      await close(member);
    }
  }
});

test("periodic checks close an idle connection whose session expires without an HTTP write", async () => {
  const f = await fixture(),
    member = await connect(f.member, f.memberToken, f.document.id);
  try {
    await db.query(
      "UPDATE sessions SET expires_at=now()-interval '1 second' WHERE token_hash=$1",
      [digest(f.memberToken)],
    );
    await until(
      () => !connection(f.document.id, f.member),
      "idle expired session disconnected",
    );
  } finally {
    await close(member);
  }
});
