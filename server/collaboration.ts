import { documentState } from "./document-state.js";
import { documentDurabilityPayload } from "../shared/durability.js";
import { Server, type Connection } from "@hocuspocus/server";
import { randomUUID, createHash } from "node:crypto";
import * as Y from "yjs";
import type { Database } from "./database.js";
import { canRead } from "./permissions.js";
import { HttpError } from "./errors.js";
import type { Resource, Role } from "../shared/model.js";
import { getSchema } from "@tiptap/core";
import { documentExtensions } from "../shared/editor-schema.js";
import {
  prosemirrorJSONToYDoc,
  yXmlFragmentToProseMirrorRootNode,
} from "@tiptap/y-tiptap";

interface Ticket {
  userId: string;
  sessionHash: string;
  expires: number;
}
interface Context {
  userId: string;
  sessionHash: string;
  documentId: string;
}
export function createCollaboration(
  db: Database,
  origin: string,
  options: { recheckIntervalMs?: number } = {},
) {
  const tickets = new Map<string, Ticket>();
  const schema = getSchema(documentExtensions());
  const storeQueues = new Map<string, Promise<void>>();
  let recheckTimer: ReturnType<typeof setInterval> | undefined;
  let recheck: Promise<void> | undefined;
  let recheckAgain = false;
  let stopping = false;
  let accessGeneration = 0;
  const issue = (userId: string, sessionHash: string) => {
    for (const [id, t] of tickets)
      if (t.expires < Date.now()) tickets.delete(id);
    if (tickets.size > 1000)
      throw new HttpError(429, "Demasiadas conexiones pendientes.");
    const value = randomUUID();
    tickets.set(value, { userId, sessionHash, expires: Date.now() + 60000 });
    return value;
  };
  async function readAccess(context: Context) {
    const session = (
      await db.query(
        "SELECT user_id FROM sessions WHERE token_hash=$1 AND expires_at>now()",
        [context.sessionHash],
      )
    ).rows[0];
    if (!session || session.user_id !== context.userId)
      throw new Error("Session revoked");
    const resource = (
      await db.query<Resource>(
        "SELECT * FROM resources WHERE id=$1 AND kind='document' AND deleted_at IS NULL",
        [context.documentId],
      )
    ).rows[0];
    if (!resource) throw new Error("Document unavailable");
    const member = (
      await db.query(
        "SELECT role FROM memberships WHERE user_id=$1 AND workspace_id=$2",
        [context.userId, resource.workspace_id],
      )
    ).rows[0];
    if (!member) throw new Error("Membership revoked");
    const all = (
      await db.query<Resource>(
        "SELECT * FROM resources WHERE workspace_id=$1",
        [resource.workspace_id],
      )
    ).rows;
    if (!canRead(resource, context.userId, member.role as Role, all))
      throw new Error("Document access denied");
    return { resource, role: member.role };
  }
  async function authorize(context: Context) {
    while (true) {
      const generation = accessGeneration;
      try {
        const access = await readAccess(context);
        if (generation === accessGeneration) return access;
      } catch (error) {
        if (generation === accessGeneration) throw error;
      }
    }
  }
  async function checkConnection(connection: Connection<Context>) {
    try {
      const access = await authorize(connection.context);
      const readOnly = access.role === "viewer";
      if (connection.readOnly !== readOnly) {
        connection.readOnly = readOnly;
        connection.sendStateless(
          JSON.stringify({ type: "access-mode", readOnly }),
        );
      }
      return access;
    } catch {
      connection.close({ code: 4403, reason: "Access revoked" });
      return null;
    }
  }
  function revalidateConnections(): Promise<void> {
    if (stopping) return Promise.resolve();
    accessGeneration++;
    if (recheck) {
      recheckAgain = true;
      return recheck;
    }
    recheck = Promise.resolve().then(async () => {
      try {
        do {
          recheckAgain = false;
          for (const document of server.hocuspocus.documents.values())
            for (const connection of document.getConnections())
              await checkConnection(connection as Connection<Context>);
        } while (recheckAgain && !stopping);
      } finally {
        recheck = undefined;
      }
    });
    return recheck;
  }
  const server = new Server<Context>({
    port: Number(process.env.COLLABORATION_PORT || 4311),
    address: process.env.HOST || "127.0.0.1",
    quiet: true,
    debounce: 700,
    maxDebounce: 2000,
    maxUnauthenticatedQueueSize: 65536,
    maxUnauthenticatedQueueMessages: 100,
    maxPendingDocuments: 10,
    async onListen() {
      stopping = false;
      recheckTimer = setInterval(() => {
        void revalidateConnections().catch(() => {});
      }, options.recheckIntervalMs ?? 15000);
      recheckTimer.unref();
    },
    async onDestroy() {
      stopping = true;
      clearInterval(recheckTimer);
      await recheck;
    },
    async connected({ connection }) {
      await checkConnection(connection as Connection<Context>);
    },
    async onAuthenticate({
      token,
      documentName,
      requestHeaders,
      connectionConfig,
    }) {
      if (requestHeaders.get("origin") !== origin)
        throw new Error("Origin denied");
      const ticket = tickets.get(token);
      if (!ticket || ticket.expires < Date.now())
        throw new Error("Ticket expired");
      const context = {
        userId: ticket.userId,
        sessionHash: ticket.sessionHash,
        documentId: documentName,
      };
      const { role } = await authorize(context);
      connectionConfig.readOnly = role === "viewer";
      return context;
    },
    async beforeHandleMessage({ connection, document, update }) {
      if (update.byteLength > 2 * 1024 * 1024)
        throw new Error("Document update exceeds the 2 MiB limit");
      if (!(await checkConnection(connection)))
        throw { code: 4403, reason: "Access revoked" };
      for (const peer of document.getConnections())
        if (peer !== connection)
          await checkConnection(peer as Connection<Context>);
      if (
        !(await checkConnection(connection)) ||
        !document.hasConnection(connection)
      )
        throw { code: 4403, reason: "Access revoked" };
    },
    async onLoadDocument({ documentName, document }) {
      const state = await documentState(db, documentName);
      Y.applyUpdate(document, new Uint8Array(state));
      return document;
    },
    async onStateless({ connection, documentName, payload }) {
      if (payload !== '{"type":"durability-check"}') return;
      if (!(await checkConnection(connection as Connection<Context>))) return;
      try {
        await storeQueues.get(documentName);
        if (!(await checkConnection(connection as Connection<Context>))) return;
        const state = (
          await db.query(
            "SELECT state FROM document_states WHERE resource_id=$1",
            [documentName],
          )
        ).rows[0]?.state;
        if (state) {
          const stored = new Y.Doc();
          Y.applyUpdate(stored, new Uint8Array(state));
          const digest = createHash("sha256")
            .update(documentDurabilityPayload(stored))
            .digest("hex");
          stored.destroy();
          if (
            !(await checkConnection(connection as Connection<Context>)) ||
            !connection.document.hasConnection(connection)
          )
            return;
          connection.sendStateless(
            JSON.stringify({
              type: "durable",
              digest,
            }),
          );
        }
      } catch {
        connection.close({ code: 1011, reason: "Storage unavailable" });
      }
    },
    async onChange({ documentName, document }) {
      const state = Buffer.from(Y.encodeStateAsUpdate(document));
      const vector = Buffer.from(Y.encodeStateVector(document)).toString(
        "base64",
      );
      const projection = yXmlFragmentToProseMirrorRootNode(
        document.getXmlFragment("default"),
        schema,
      ).toJSON();
      const digest = createHash("sha256")
        .update(documentDurabilityPayload(document, projection))
        .digest("hex");
      const prior = storeQueues.get(documentName) || Promise.resolve();
      const work = prior
        .catch(() => {})
        .then(async () => {
          await db.transaction(async (tx) => {
            await tx.query(
              "INSERT INTO document_states(resource_id,state) VALUES($1,$2) ON CONFLICT(resource_id) DO UPDATE SET state=EXCLUDED.state,updated_at=now()",
              [documentName, state],
            );
            await tx.query(
              "UPDATE resources SET data=jsonb_set(data,'{content}',$1::jsonb),updated_at=now() WHERE id=$2",
              [JSON.stringify(projection), documentName],
            );
          });
          for (const peer of document.getConnections())
            await checkConnection(peer as Connection<Context>);
          document.broadcastStateless(
            JSON.stringify({ type: "durable", vector, digest }),
          );
        });
      storeQueues.set(documentName, work);
      try {
        await work;
      } finally {
        if (storeQueues.get(documentName) === work)
          storeQueues.delete(documentName);
      }
    },
    async onStoreDocument({ documentName, document, lastContext }) {
      const content = yXmlFragmentToProseMirrorRootNode(
        document.getXmlFragment("default"),
        schema,
      ).toJSON();
      await db.transaction(async (tx) => {
        const latest = (
          await tx.query(
            "SELECT content,created_at FROM document_revisions WHERE resource_id=$1 ORDER BY id DESC LIMIT 1",
            [documentName],
          )
        ).rows[0];
        if (
          latest &&
          (JSON.stringify(latest.content) === JSON.stringify(content) ||
            Date.now() - new Date(latest.created_at).getTime() < 60000)
        )
          return;
        await tx.query(
          "INSERT INTO document_revisions(resource_id,content,user_id) VALUES($1,$2,$3)",
          [documentName, JSON.stringify(content), lastContext?.userId || null],
        );
      });
    },
  });
  return { server, issue, authorize, revalidateConnections };
}
