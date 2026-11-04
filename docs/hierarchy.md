# Project structure

The Projects screen provides cards and a structure view. Folders, projects, subprojects and documents form a workspace-scoped hierarchy. The current location has breadcrumbs, visible child counts, search, creation, details, archive controls and access to project tasks. Mobile location navigation folds into a native disclosure. Existing project cards remain available and the chosen view is a user preference.

Folders inherit their location's permissions. A project can be nested under another project or folder; its descendants must satisfy the permissions of every enclosing project. Personal document ownership remains restrictive even for administrators. Deleting a folder hides live descendants; restoring it makes the same authorized descendants available again. Archiving a location is distinct from deletion and does not rewrite descendant archive flags.

## Creation and navigation

Creation uses the persistent user-scoped outbox, including offline creation under cached or pending parents. Creation forms retain device-local drafts. Folder and project parent types are validated on the server, and document project scope must agree with its parent location. Parent chains are bounded at 128 levels and cycles are rejected.

Directory URLs use `?view=projects&workspace=<uuid>&location=<uuid>`. A copied folder resource link also opens its directory across authorized workspaces. Opening a document retains its directory as browser-history context; closing or reloading returns to the appropriate location. The structure module is included in the application-shell precache so offline reload does not depend on a module having been downloaded after service-worker activation.

## Reviewed moves

A move requires connectivity and has separate preview and confirmation steps. The server computes the complete affected branch and proposed document/folder project assignments. Subprojects retain their own project identity. The operation refuses an inaccessible descendant, an invalid or archived destination, cycles and branches larger than 1000 resources. Notifications and personal auxiliary collections are not relocated as directory children; their original permission context remains intact.

The preview fingerprint covers branch membership, resource versions, deletion markers and source/destination ancestor versions. An edited descendant, added child or changed destination invalidates the preview. Confirmation locks the workspace and applies all affected metadata, resource versions, activity and the command receipt in one database transaction. Late validation failure rolls everything back. Raw metadata updates cannot bypass the reviewed move for a nonempty structure.

Collaborative document identifiers and binary states remain unchanged. Metadata writes retain the current canonical document projection, and trashed descendants retain their original deletion timestamps. A durable command identifier supports retry after an uncertain response or reload without duplicate versions. Replays check both original and current permission scopes before returning the result. Document revisions follow the current document permissions: moving can make earlier revisions available to destination readers, and the confirmation states this explicitly. Metadata snapshots retain their recorded resource context, while complete historical ancestor-scope preservation remains separately tracked.

Project template capture includes nested folders and preserves their parent relationships. Application remaps folder/document relationships and the nearest nested project scope. Folder nodes are supported inside project templates; standalone folder-root templates are not supported.

## Evidence and limits

`tests/hierarchy.test.ts` covers atomic scope changes, canonical Yjs preservation, cycles, typed locations, inherited privacy, stale previews, concurrent moves, replay, inaccessible descendants, late rollback, folder-aware templates, trash restoration and deletion timestamp preservation. `tests/navigation.test.ts` adds directory URL validation.

`scripts/hierarchy-check.mjs` uses synthetic local accounts to create folders/projects/documents, edit a document, interrupt a successful move response, reload/retry without duplicate versions, navigate and create offline, archive/restore and reopen folder permalinks. Design probes cover 1440, 768 and 390px. The exact-image PostgreSQL staging check additionally verifies concurrent command replay, folder-aware template copying, inherited project privacy and trashed timestamps.

A folder move can change who can read its current contents; the confirmation states this before applying it. Downloaded content is not remotely erased. Complete historical/export acceptance, multiple dirty tabs, shared-device cleanup, large-workspace pagination and native device acceptance remain tracked separately. Older releases do not implement the same folder UI and inherited permission checks; assess compatibility before rolling back after hierarchy adoption.
