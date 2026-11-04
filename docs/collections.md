# Saved views, bulk tasks and templates

## Task collections

Task collections filter by text, project, sprint, status, assignee, priority, type, labels, date and archive state. Ordering supports planning order, update time, due date, priority, estimate and title; missing dates remain last. Lists and boards can group by status, assignee or project. Boards include cancelled tasks. The interface renders 100 results initially and offers additional batches; this is client-side rendering, not server pagination or full virtualization.

Saved views retain their typed configuration rather than a copy of task results. They are personal by default. Shared views remain visible only to readers of every referenced project and sprint. The relative assignee `me` resolves to the reader; relative dates use the saved time zone and Monday–Sunday weeks. The current section and selected project still intersect with the view filters. Authors and administrators can change shared views. Cached views work offline; metadata saves use the existing ordered outbox and require server synchronization before other users can receive them.

Bulk commands select at most 100 explicit task versions. Status, priority, type, assignee, project, sprint, due date, estimate, labels and archive state can change together. A transaction validates every task and either commits the entire batch or rolls back resource history, notifications and queued automation effects. Background updates mark an existing selection stale; they do not silently replace its expected versions. Sending a batch to the trash offers versioned restoration. Other bulk edits have no automatic undo.

## Template library

Templates contain a connected hierarchy with one project, task or document root. A project can contain subprojects, tasks and documents; task and document roots can contain descendants of the same kind. The builder edits titles, descriptions, task estimates, labels, relative due dates, checklists, dependencies and document content. Captured fields that the builder does not expose remain preserved. Document editing uses the shared rich-content schema, retaining tables, task lists, mathematics and images.

Capture requires an online server command and a current source version. It includes the complete accessible hierarchy, canonical persisted collaborative document content and copied attachments. Inaccessible descendants reject the capture instead of producing a silently incomplete template. Wait for the document's server durability confirmation before capture. Active work in another client's unsynchronized local copy cannot be captured.

Captured templates preserve immutable permission snapshots and also recheck current source permissions. Selecting shared access does not publish private sources or personal notes. Revoking source access also revokes template access and operation replay. New templates and captures default to personal access. Administrators cannot bypass another user's personal ownership boundary.

Applying a template creates fresh resources and attachment identifiers in one transaction. Parent, project, dependency, related-resource and internal document links are remapped. Links to resources outside a captured hierarchy lose their resource link mark while retaining text. Images and file links are remapped to copied files with the new target's permissions. Dates shift from the capture reference date to the selected base date; out-of-range dates reject the whole copy.

Tasks restart in the backlog without assignees, sprints, recurrence or execution history. Checklists receive fresh identifiers and unchecked items. Votes, reviews, notifications, automations and time records are not copied. Personal document nodes remain personal to the person applying the template. A task-root copy requires an accessible destination project or an explicit workspace destination.

Limits are 200 nodes, 900 KiB of complete template metadata, 500 attachment bindings/source scopes, 5 MiB per uploaded file and 100 MiB of active attachments per workspace. Capture and application consume additional attachment storage. Templates are independent reusable copies; synchronized blocks and live-linked template instances remain outside this implementation.

## Durability and recovery

Template editor drafts retain the expected base version in user-scoped IndexedDB. Reopening restores unfinished work, including rich document content; malformed drafts remain available for explicit review/discard. Draft arbitration between dirty tabs remains a separate acceptance item.

Online bulk, capture and application commands persist their identifier and complete request in IndexedDB before transmission. A lost response leaves a visible retry action that survives reload. Retry sends the same command identifier, and the server checks current permissions before returning a previously committed result. An unresolved command blocks a different command in that command scope. Web Locks serialize these requests across tabs where available. Known client errors clear the pending command; an uncertain transport/server failure preserves it.

Collaborative document confirmations combine a state vector with the visible content digest. Delete-only edits do not advance a Yjs vector, and binary tombstones can differ between collected peers. The digest therefore includes the shared-schema projection, with a revision guard on the client. Reconnection explicitly asks for the persisted confirmation. Hash checks are briefly coalesced; no additional background service is required.

## Evidence and limits

`tests/collections.test.ts` covers view privacy, foreign references, atomic rollback, stale versions, role boundaries, canonical document capture, copied files, privacy revocation, idempotent replay, unsafe blueprint rejection and date overflow. `tests/durability.test.ts` covers delete-only confirmation and peer agreement. `scripts/collections-check.mjs` exercises the browser interface, local draft recovery, lost-response/reload replay, offline collections and responsive widths. Synthetic test fixtures remain local or in the temporary PostgreSQL staging network. Physical mobile devices, large-workspace load, all multi-tab lifecycle cases and encrypted-archive disaster recovery require separate acceptance.
