import { customFieldValueSchema } from "../shared/custom-fields.js";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import * as Y from "yjs";
import { getSchema } from "@tiptap/core";
import { yXmlFragmentToProseMirrorRootNode } from "@tiptap/y-tiptap";
import { documentExtensions } from "../shared/editor-schema.js";
import {
  mutationSchema,
  type Resource,
  type Role,
  type User,
} from "../shared/model.js";
import {
  templateBlueprintSchema,
  rewriteDocument,
  type TemplateBlueprint,
  type TemplateScope,
} from "../shared/collections.js";
import { validDay } from "../shared/automation.js";
import { canRead } from "./permissions.js";
import { HttpError } from "./errors.js";
import type { Connection, Database } from "./database.js";
import { applyMutation, resources } from "./mutations.js";
import { validateBlueprint, templateFields } from "./collection-validation.js";
const uuid = z.string().uuid(),
  version = z.number().int().min(0),
  schema = getSchema(documentExtensions());
const date = z.string().refine(validDay, "Fecha no válida");
const clone = <T>(value: T): T => structuredClone(value);
const attachmentUrl = (workspaceId: string, id: string) =>
  `/api/workspaces/${workspaceId}/attachments/${id}`;
const assetId = (value: unknown, workspaceId: string) =>
  typeof value === "string"
    ? new RegExp(
        "^/api/workspaces/" +
          workspaceId +
          "/attachments/([a-f\\d-]{36})(?:\\?[^#]*)?$",
        "i",
      ).exec(value)?.[1]
    : undefined;
const permissionScope = (resource: Resource): TemplateScope => ({
  id: resource.id,
  kind: resource.kind,
  createdBy: resource.created_by,
  ...Object.fromEntries(
    [
      "projectId",
      "parentId",
      "targetId",
      "ownerId",
      "assigneeId",
      "private",
      "members",
      "viewConfig",
    ]
      .filter(
        (key) =>
          resource.data[key] !== undefined && resource.data[key] !== null,
      )
      .map((key) => [key, clone(resource.data[key])]),
  ),
});
type File = {
  id: string;
  target_id: string;
  name: string;
  mime: string;
  size: number;
  template_node_key?: string | null;
};
type Binding = { file: File; nodeKey: string; newId: string };
function rewriteLinks(
  content: any,
  asset: (value: string) => string,
  resource: (id: string) => string | undefined,
) {
  return rewriteDocument(content, (node) => {
    if (node.type === "image")
      node.attrs = { ...node.attrs, src: asset(String(node.attrs?.src || "")) };
    if (node.marks)
      node.marks = node.marks.flatMap((mark: any) => {
        if (mark.type !== "link") return [mark];
        const href = String(mark.attrs?.href || ""),
          match = /[?&]resource=([a-f\d-]{36})/i.exec(href);
        if (match) {
          const replacement = resource(match[1]);
          return replacement
            ? [{ ...mark, attrs: { ...mark.attrs, href: replacement } }]
            : [];
        }
        return [{ ...mark, attrs: { ...mark.attrs, href: asset(href) } }];
      });
    return node;
  });
}

export function registerCollectionRoutes(
  app: FastifyInstance,
  db: Database,
  userFor: (req: FastifyRequest) => Promise<User>,
) {
  async function context(
    tx: Connection,
    workspaceId: string,
    user: User,
    write = true,
  ) {
    uuid.parse(workspaceId);
    if (write)
      await tx.query("SELECT id FROM workspaces WHERE id=$1 FOR UPDATE", [
        workspaceId,
      ]);
    const member = (
      await tx.query(
        "SELECT role FROM memberships WHERE workspace_id=$1 AND user_id=$2" +
          (write ? " FOR UPDATE" : ""),
        [workspaceId, user.id],
      )
    ).rows[0];
    if (!member || (write && member.role === "viewer"))
      throw new HttpError(403, "Se requiere acceso de edición al espacio.");
    return {
      workspaceId,
      user,
      role: member.role as Role,
      all: await resources(tx, workspaceId),
    };
  }
  type Context = Awaited<ReturnType<typeof context>>;
  const readable = (resource: Resource | undefined, access: Context) =>
    resource && canRead(resource, access.user.id, access.role, access.all);
  async function previous(
    tx: Connection,
    operationId: string,
    access: Context,
    command: string,
  ) {
    const prior = (
      await tx.query("SELECT * FROM operations WHERE id=$1", [operationId])
    ).rows[0];
    if (!prior) return null;
    if (
      prior.workspace_id !== access.workspaceId ||
      prior.user_id !== access.user.id ||
      prior.response.command !== command
    )
      throw new HttpError(409, "Identificador de operación ya utilizado.");
    if (
      (prior.response.ids || []).some(
        (id: string) =>
          !readable(
            access.all.find((r) => r.id === id),
            access,
          ),
      )
    )
      throw new HttpError(
        403,
        "El resultado ya no está disponible para esta cuenta.",
      );
    return prior.response;
  }
  async function remember(
    tx: Connection,
    operationId: string,
    access: Context,
    command: string,
    result: any,
  ) {
    const response = { ...result, command };
    await tx.query(
      "INSERT INTO operations(id,workspace_id,user_id,response) VALUES($1,$2,$3,$4)",
      [
        operationId,
        access.workspaceId,
        access.user.id,
        JSON.stringify(response),
      ],
    );
    return response;
  }
  async function copyFiles(
    tx: Connection,
    access: Context,
    bindings: Binding[],
    targets: Map<string, string>,
  ) {
    const used = Number(
        (
          await tx.query(
            "SELECT coalesce(sum(size),0) AS total FROM attachments WHERE workspace_id=$1 AND deleted_at IS NULL",
            [access.workspaceId],
          )
        ).rows[0].total,
      ),
      added = bindings.reduce(
        (sum, binding) => sum + Number(binding.file.size),
        0,
      );
    if (used + added > 100 * 1024 * 1024)
      throw new HttpError(
        413,
        "No hay espacio para copiar los adjuntos. El límite activo del espacio es de 100 MiB.",
      );
    for (const binding of bindings) {
      const target = targets.get(binding.nodeKey);
      if (!target)
        throw new HttpError(
          400,
          "El adjunto no tiene un elemento de destino válido.",
        );
      await tx.query(
        `INSERT INTO attachments(id,workspace_id,target_id,name,mime,size,body,created_by,template_node_key) SELECT $1,$2,$3,name,mime,size,body,$4,$5 FROM attachments WHERE id=$6 AND workspace_id=$2 AND deleted_at IS NULL`,
        [
          binding.newId,
          access.workspaceId,
          target,
          access.user.id,
          binding.nodeKey,
          binding.file.id,
        ],
      );
    }
  }
  const bulkPatch = z
    .object({
      status: z
        .enum(["backlog", "todo", "in_progress", "review", "done", "cancelled"])
        .optional(),
      priority: z.enum(["none", "low", "medium", "high", "urgent"]).optional(),
      customFields: z.record(uuid, customFieldValueSchema).optional(),
      taskType: z
        .enum([
          "feature",
          "bug",
          "research",
          "maintenance",
          "debt",
          "regression",
        ])
        .optional(),
      assigneeId: uuid.nullable().optional(),
      projectId: uuid.nullable().optional(),
      sprintId: uuid.nullable().optional(),
      dueDate: z.union([date, z.literal("")]).optional(),
      estimate: z.number().min(0).max(10000).optional(),
      archived: z.boolean().optional(),
      addLabels: z.array(z.string().min(1).max(80)).max(30).optional(),
      removeLabels: z.array(z.string().min(1).max(80)).max(30).optional(),
    })
    .strict();
  app.post<{ Params: { workspaceId: string } }>(
    "/api/workspaces/:workspaceId/tasks/bulk",
    async (req) => {
      const user = await userFor(req),
        input = z
          .object({
            operationId: uuid,
            tasks: z
              .array(z.object({ id: uuid, expectedVersion: version }))
              .min(1)
              .max(100),
            mode: z.enum(["update", "trash", "restore"]).default("update"),
            patch: bulkPatch.default({}),
          })
          .strict()
          .parse(req.body);
      return db.transaction(async (tx) => {
        const access = await context(tx, req.params.workspaceId, user),
          prior = await previous(tx, input.operationId, access, "tasks_bulk");
        if (prior) return prior;
        if (
          new Set(input.tasks.map((task) => task.id)).size !==
          input.tasks.length
        )
          throw new HttpError(400, "Hay tareas duplicadas en el lote.");
        const selected = input.tasks.map((expected) => {
          const task = access.all.find(
            (task) => task.id === expected.id && task.kind === "task",
          );
          if (!readable(task, access))
            throw new HttpError(
              403,
              "Una tarea del lote ya no es accesible. No se ha aplicado ningún cambio.",
            );
          if (task!.version !== expected.expectedVersion)
            throw new HttpError(
              409,
              "Una tarea del lote cambió. Revisa la selección antes de aplicar todos los cambios.",
            );
          if (!!task!.deleted_at !== (input.mode === "restore"))
            throw new HttpError(
              409,
              "El estado de la papelera cambió. Revisa el lote.",
            );
          return task!;
        });
        const results: Resource[] = [];
        for (const task of selected) {
          const data = { ...task.data };
          if (input.mode === "update") {
            const { addLabels, removeLabels, ...patch } = input.patch;
            const customFields = patch.customFields
              ? { ...data.customFields, ...patch.customFields }
              : data.customFields;
            Object.assign(data, patch);
            if (patch.customFields) data.customFields = customFields;
            if (addLabels || removeLabels)
              data.labels = [
                ...new Set([...(data.labels || []), ...(addLabels || [])]),
              ].filter((label) => !(removeLabels || []).includes(label));
          }
          const result = await applyMutation(
            tx,
            access.workspaceId,
            user,
            access.role,
            mutationSchema.parse({
              operationId: randomUUID(),
              id: task.id,
              kind: "task",
              title: task.title,
              data,
              expectedVersion: task.version,
              deleted: input.mode === "trash",
            }),
            { skipOperation: true },
          );
          results.push(result.resource);
        }
        return remember(tx, input.operationId, access, "tasks_bulk", {
          ids: results.map((result) => result.id),
          versions: results.map((result) => ({
            id: result.id,
            version: result.version,
          })),
          count: results.length,
        });
      });
    },
  );
  app.post<{ Params: { workspaceId: string } }>(
    "/api/workspaces/:workspaceId/templates/capture",
    async (req) => {
      const user = await userFor(req),
        input = z
          .object({
            operationId: uuid,
            sourceId: uuid,
            expectedVersion: version,
            title: z.string().trim().min(1).max(500),
            anchorDate: date,
            shared: z.boolean().default(false),
          })
          .strict()
          .parse(req.body);
      return db.transaction(async (tx) => {
        const access = await context(tx, req.params.workspaceId, user),
          prior = await previous(
            tx,
            input.operationId,
            access,
            "template_capture",
          );
        if (prior) return prior;
        const source = access.all.find(
          (r) => r.id === input.sourceId && !r.deleted_at,
        );
        if (
          !readable(source, access) ||
          !["project", "task", "document"].includes(source!.kind)
        )
          throw new HttpError(
            404,
            "No se encuentra el origen de la plantilla.",
          );
        if (source!.version !== input.expectedVersion)
          throw new HttpError(
            409,
            "El origen cambió. Recárgalo antes de capturar la plantilla.",
          );
        const selected = new Map([[source!.id, clone(source!)]]);
        let changed = true;
        while (changed) {
          changed = false;
          for (const candidate of access.all) {
            if (
              candidate.deleted_at ||
              selected.has(candidate.id) ||
              !["project", "folder", "task", "document"].includes(
                candidate.kind,
              )
            )
              continue;
            const belongs =
              source!.kind === "project"
                ? selected.has(candidate.data.projectId) ||
                  selected.has(candidate.data.parentId)
                : candidate.kind === source!.kind &&
                  selected.has(candidate.data.parentId);
            if (!belongs) continue;
            if (!readable(candidate, access))
              throw new HttpError(
                403,
                "La estructura incluye contenido sin acceso. No se ha creado una plantilla parcial.",
              );
            selected.set(candidate.id, clone(candidate));
            changed = true;
            if (selected.size > 200)
              throw new HttpError(
                413,
                "Cada plantilla admite hasta 200 elementos. Captura una parte del proyecto.",
              );
          }
        }
        const keys = new Map(
            [...selected.keys()].map((id, index) => [id, "node" + index]),
          ),
          scopes = new Map<string, TemplateScope>(
            [...selected.values()].map((resource) => [
              resource.id,
              permissionScope(resource),
            ]),
          );
        const nodes: TemplateBlueprint["nodes"] = [];
        for (const original of selected.values()) {
          if (original.kind === "document") {
            const state = (
              await tx.query(
                "SELECT state FROM document_states WHERE resource_id=$1 FOR UPDATE",
                [original.id],
              )
            ).rows[0]?.state;
            if (state) {
              const doc = new Y.Doc();
              try {
                Y.applyUpdate(doc, Buffer.from(state));
                original.data.content = yXmlFragmentToProseMirrorRootNode(
                  doc.getXmlFragment("default"),
                  schema,
                ).toJSON();
              } finally {
                doc.destroy();
              }
            }
          }
          const data = Object.fromEntries(
              Object.entries(original.data)
                .filter(([field]) => templateFields.has(field))
                .map(([field, value]) => [field, clone(value)]),
            ),
            node: TemplateBlueprint["nodes"][number] = {
              key: keys.get(original.id)!,
              kind: original.kind as "project" | "folder" | "task" | "document",
              title: original.title,
              data,
              dependencies: (original.data.dependencies || [])
                .filter((id: string) => selected.has(id))
                .map((id: string) => keys.get(id)!),
              related: (original.data.related || [])
                .filter((id: string) => selected.has(id))
                .map((id: string) => keys.get(id)!),
            };
          if (original.data.ownerId) node.personal = true;
          if (original.id !== source!.id) {
            if (keys.has(original.data.parentId))
              node.parentKey = keys.get(original.data.parentId);
            if (
              original.kind !== "project" &&
              keys.has(original.data.projectId)
            )
              node.projectKey = keys.get(original.data.projectId);
            if (!node.parentKey && !node.projectKey) {
              if (source!.kind === "project")
                node.projectKey = keys.get(source!.id);
              else node.parentKey = keys.get(source!.id);
            }
          }
          for (const [field, key] of [
            ["startDate", "startOffset"],
            ["dueDate", "dueOffset"],
            ["endDate", "endOffset"],
          ] as const)
            if (original.data[field]) {
              if (!validDay(original.data[field]))
                throw new HttpError(
                  400,
                  "El origen contiene una fecha que necesita revisión.",
                );
              node[key] = Math.round(
                (Date.parse(original.data[field]) -
                  Date.parse(input.anchorDate)) /
                  86400000,
              );
            }
          nodes.push(node);
        }
        const blueprint: TemplateBlueprint = {
            version: 1,
            rootKey: keys.get(source!.id)!,
            nodes,
          },
          files = (
            await tx.query<File>(
              "SELECT id,target_id,name,mime,size,template_node_key FROM attachments WHERE workspace_id=$1 AND target_id=ANY($2::uuid[]) AND deleted_at IS NULL",
              [access.workspaceId, [...selected.keys()]],
            )
          ).rows,
          bindings = new Map<string, Binding>();
        const bind = (file: File, nodeKey: string) => {
          const key = nodeKey + ":" + file.id;
          if (!bindings.has(key))
            bindings.set(key, { file, nodeKey, newId: randomUUID() });
          return bindings.get(key)!;
        };
        for (const file of files) bind(file, keys.get(file.target_id)!);
        for (const node of nodes)
          if (node.data.content) {
            const referenced = new Set<string>();
            rewriteDocument(node.data.content, (element) => {
              if (element.type === "image") {
                const id = assetId(element.attrs?.src, access.workspaceId);
                if (!id)
                  throw new HttpError(
                    400,
                    "Las imágenes deben estar adjuntas al espacio antes de capturar la plantilla.",
                  );
                referenced.add(id);
              }
              for (const mark of element.marks || []) {
                const id = assetId(mark.attrs?.href, access.workspaceId);
                if (id) referenced.add(id);
              }
              return element;
            });
            for (const id of referenced) {
              let file = files.find((file) => file.id === id);
              if (!file) {
                file = (
                  await tx.query<File>(
                    "SELECT id,target_id,name,mime,size FROM attachments WHERE id=$1 AND workspace_id=$2 AND deleted_at IS NULL",
                    [id, access.workspaceId],
                  )
                ).rows[0];
                const target = access.all.find((r) => r.id === file?.target_id);
                if (!file || !readable(target, access))
                  throw new HttpError(
                    403,
                    "Un adjunto del documento ya no es accesible.",
                  );
                scopes.set(target!.id, permissionScope(target!));
                files.push(file);
              }
              bind(file, node.key);
            }
          }
        if (bindings.size > 500 || scopes.size > 500)
          throw new HttpError(
            413,
            "La plantilla supera el límite de adjuntos o contextos de origen.",
          );
        for (const node of nodes)
          if (node.data.content)
            node.data.content = rewriteLinks(
              node.data.content,
              (value) => {
                const id = assetId(value, access.workspaceId);
                return id
                  ? attachmentUrl(
                      access.workspaceId,
                      bind(
                        files.find((file) => file.id === id)!,
                        node.key,
                      ).newId,
                    )
                  : value;
              },
              (id) =>
                keys.has(id) ? "/?templateNode=" + keys.get(id) : undefined,
            );
        validateBlueprint(blueprint);
        const templateId = randomUUID(),
          data = {
            description: `Plantilla de ${source!.title}`,
            templateBlueprint: blueprint,
            templateScopes: [...scopes.values()],
            targetId: source!.id,
            ...(source!.kind === "project"
              ? { projectId: source!.id }
              : source!.data.projectId
                ? { projectId: source!.data.projectId }
                : {}),
            ...(!input.shared ? { ownerId: user.id } : {}),
          };
        await applyMutation(
          tx,
          access.workspaceId,
          user,
          access.role,
          mutationSchema.parse({
            id: templateId,
            operationId: randomUUID(),
            kind: "template",
            title: input.title,
            data,
            expectedVersion: 0,
          }),
          { skipOperation: true, trustedTemplateCapture: true },
        );
        await copyFiles(
          tx,
          access,
          [...bindings.values()],
          new Map(nodes.map((node) => [node.key, templateId])),
        );
        return remember(tx, input.operationId, access, "template_capture", {
          ids: [templateId],
          templateId,
          nodeCount: nodes.length,
          attachmentCount: bindings.size,
        });
      });
    },
  );
  app.post<{ Params: { workspaceId: string; templateId: string } }>(
    "/api/workspaces/:workspaceId/templates/:templateId/apply",
    async (req) => {
      const user = await userFor(req),
        input = z
          .object({
            operationId: uuid,
            expectedVersion: version,
            title: z.string().trim().min(1).max(500),
            baseDate: date,
            visibility: z.enum(["private", "project", "workspace"]),
            destinationProjectId: uuid.optional(),
          })
          .strict()
          .parse(req.body);
      return db.transaction(async (tx) => {
        const access = await context(tx, req.params.workspaceId, user),
          template = access.all.find(
            (r) =>
              r.id === req.params.templateId &&
              r.kind === "template" &&
              !r.deleted_at,
          );
        if (!readable(template, access))
          throw new HttpError(404, "No se encuentra la plantilla.");
        const prior = await previous(
          tx,
          input.operationId,
          access,
          "template_apply",
        );
        if (prior) return prior;
        if (template!.version !== input.expectedVersion)
          throw new HttpError(
            409,
            "La plantilla cambió. Revísala antes de aplicarla.",
          );
        const blueprint = validateBlueprint(template!.data.templateBlueprint),
          root = blueprint.nodes.find(
            (node) => node.key === blueprint.rootKey,
          )!;
        const destination = input.destinationProjectId
          ? access.all.find(
              (r) =>
                r.id === input.destinationProjectId &&
                r.kind === "project" &&
                !r.deleted_at,
            )
          : undefined;
        if (
          (input.visibility === "project" &&
            (!destination || !readable(destination, access))) ||
          (input.visibility !== "project" && input.destinationProjectId)
        )
          throw new HttpError(
            400,
            "Selecciona un proyecto de destino accesible.",
          );
        if (root.kind === "task" && input.visibility === "private")
          throw new HttpError(
            400,
            "Las tareas necesitan un proyecto o un destino de equipo explícito.",
          );
        const ids = new Map(
            blueprint.nodes.map((node) => [node.key, randomUUID()]),
          ),
          nodes = new Map(blueprint.nodes.map((node) => [node.key, node])),
          files = (
            await tx.query<File>(
              "SELECT id,target_id,name,mime,size,template_node_key FROM attachments WHERE workspace_id=$1 AND target_id=$2 AND deleted_at IS NULL",
              [access.workspaceId, template!.id],
            )
          ).rows,
          bindings = new Map<string, Binding>();
        const bind = (file: File, nodeKey: string) => {
          const key = nodeKey + ":" + file.id;
          if (!bindings.has(key))
            bindings.set(key, { file, nodeKey, newId: randomUUID() });
          return bindings.get(key)!;
        };
        for (const file of files) {
          const nodeKey = file.template_node_key || blueprint.rootKey;
          if (nodes.has(nodeKey)) bind(file, nodeKey);
        }
        for (const node of blueprint.nodes)
          if (node.data.content)
            rewriteDocument(node.data.content, (element) => {
              for (const value of [
                element.type === "image" ? element.attrs?.src : undefined,
                ...(element.marks || [])
                  .filter((mark: any) => mark.type === "link")
                  .map((mark: any) => mark.attrs?.href),
              ]) {
                const id = assetId(value, access.workspaceId);
                if (id) {
                  const file = files.find((file) => file.id === id);
                  if (!file)
                    throw new HttpError(
                      400,
                      "Un adjunto de la plantilla ya no está disponible.",
                    );
                  bind(file, node.key);
                } else if (
                  element.type === "image" &&
                  value === element.attrs?.src
                )
                  throw new HttpError(
                    400,
                    "La plantilla tiene una imagen sin adjunto disponible.",
                  );
              }
              return element;
            });
        const projectFor = (key: string): string | undefined => {
          const node = nodes.get(key)!;
          if (node.kind === "project") return ids.get(node.key);
          if (node.parentKey) return projectFor(node.parentKey);
          if (node.projectKey) return ids.get(node.projectKey);
          return root.kind === "project"
            ? ids.get(blueprint.rootKey)
            : destination?.id;
        };
        const clones: Resource[] = blueprint.nodes.map((node) => {
          const data = clone(node.data);
          if (node.kind === "project") {
            data.status = "active";
            data.members = [];
            if (node.key === blueprint.rootKey)
              data.private = input.visibility === "private";
            if (node.parentKey) data.parentId = ids.get(node.parentKey);
            else if (destination) data.parentId = destination.id;
          } else {
            data.projectId = projectFor(node.key) || null;
            if (node.parentKey) data.parentId = ids.get(node.parentKey);
            if (node.kind === "task") {
              data.status = "backlog";
              data.dependencies = node.dependencies.map((key) => ids.get(key));
              data.related = node.related.map((key) => ids.get(key));
              if (data.checklist)
                data.checklist = (data.checklist as any[]).map((entry) => ({
                  ...entry,
                  id: randomUUID(),
                  done: false,
                }));
            }
            if (
              node.kind === "document" &&
              (node.personal ||
                (root.kind === "document" && input.visibility === "private"))
            )
              data.ownerId = user.id;
          }
          for (const [field, key] of [
            ["startDate", "startOffset"],
            ["dueDate", "dueOffset"],
            ["endDate", "endOffset"],
          ] as const)
            if (node[key] !== undefined) {
              const shifted = new Date(
                Date.parse(input.baseDate) + node[key]! * 86400000,
              )
                .toISOString()
                .slice(0, 10);
              if (!validDay(shifted))
                throw new HttpError(
                  400,
                  "Las fechas de la copia quedan fuera del intervalo permitido.",
                );
              data[field] = shifted;
            }
          if (data.content)
            data.content = rewriteDocument(data.content, (element) => {
              if (element.type === "image") {
                const id = assetId(element.attrs?.src, access.workspaceId)!;
                element.attrs = {
                  ...element.attrs,
                  src: attachmentUrl(
                    access.workspaceId,
                    bind(
                      files.find((file) => file.id === id)!,
                      node.key,
                    ).newId,
                  ),
                };
              }
              if (element.marks)
                element.marks = element.marks.map((mark: any) => {
                  if (mark.type !== "link") return mark;
                  const href = String(mark.attrs?.href || ""),
                    key = /^\/\?templateNode=([A-Za-z0-9_-]+)$/.exec(href)?.[1],
                    fileId = assetId(href, access.workspaceId);
                  if (key && !ids.has(key))
                    throw new HttpError(
                      400,
                      "Un enlace interno de plantilla no tiene destino.",
                    );
                  return {
                    ...mark,
                    attrs: {
                      ...mark.attrs,
                      href: key
                        ? "/?resource=" + ids.get(key)
                        : fileId
                          ? attachmentUrl(
                              access.workspaceId,
                              bind(
                                files.find((file) => file.id === fileId)!,
                                node.key,
                              ).newId,
                            )
                          : href,
                    },
                  };
                });
              return element;
            });
          return {
            id: ids.get(node.key)!,
            workspace_id: access.workspaceId,
            kind: node.kind,
            title: node.key === blueprint.rootKey ? input.title : node.title,
            data,
            version: 0,
            created_by: user.id,
            created_at: "",
            updated_at: "",
            deleted_at: null,
          };
        });
        const graph = [...access.all, ...clones];
        for (const resource of clones)
          await applyMutation(
            tx,
            access.workspaceId,
            user,
            access.role,
            mutationSchema.parse({
              id: resource.id,
              operationId: randomUUID(),
              kind: resource.kind,
              title: resource.title,
              data: resource.data,
              expectedVersion: 0,
            }),
            { skipOperation: true, graph, trustedFieldSnapshots: true },
          );
        await copyFiles(tx, access, [...bindings.values()], ids);
        return remember(tx, input.operationId, access, "template_apply", {
          ids: clones.map((resource) => resource.id),
          rootId: ids.get(blueprint.rootKey),
          count: clones.length,
          attachmentCount: bindings.size,
        });
      });
    },
  );
}
