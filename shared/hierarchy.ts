import type { Resource, ResourceKind } from "./model.js";
export const structureKinds = ["project", "folder", "document"] as const;
export const isStructure = (r: Resource) =>
  (structureKinds as readonly string[]).includes(r.kind) &&
  !r.data.personalNote;
export function structureParent(resource: Resource): string | null {
  return (
    resource.data.parentId ||
    (resource.kind !== "project" ? resource.data.projectId : null) ||
    null
  );
}
export function acceptsChild(parent: ResourceKind, child: ResourceKind) {
  if (parent === "document") return child === "document";
  return (
    ["folder", "project"].includes(parent) &&
    (structureKinds as readonly string[]).includes(child)
  );
}
export function structurePath(
  id: string | null,
  resources: Resource[],
): Resource[] {
  const byId = new Map(resources.map((r) => [r.id, r])),
    path: Resource[] = [],
    seen = new Set<string>();
  let cursor = id;
  while (cursor) {
    if (seen.has(cursor) || path.length >= 128)
      throw new Error("La estructura crea un ciclo o supera 128 niveles.");
    seen.add(cursor);
    const resource = byId.get(cursor);
    if (!resource) throw new Error("La ubicación no está disponible.");
    path.unshift(resource);
    cursor = structureParent(resource);
  }
  return path;
}
export function projectAt(
  id: string | null,
  resources: Resource[],
): string | null {
  return (
    structurePath(id, resources)
      .reverse()
      .find((r) => r.kind === "project")?.id || null
  );
}
export function structureBranch(id: string, resources: Resource[]): Resource[] {
  const selected = new Set([id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const r of resources) {
      if (
        ![
          "notification",
          "view",
          "time_entry",
          "template",
          "dashboard",
        ].includes(r.kind) &&
        !selected.has(r.id) &&
        selected.has(structureParent(r) || "")
      ) {
        selected.add(r.id);
        changed = true;
      }
    }
  }
  return resources.filter((r) => selected.has(r.id));
}
export interface MovePreview {
  id: string;
  destinationId: string | null;
  fingerprint: string;
  title: string;
  destinationTitle: string;
  affectedCount: number;
  changes: {
    id: string;
    title: string;
    kind: ResourceKind;
    version: number;
    parentId: string | null;
    projectId: string | null;
  }[];
}
