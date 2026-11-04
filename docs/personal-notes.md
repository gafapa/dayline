# Personal notes

The **Mis notas** screen lists the signed-in account's personal notes in the selected workspace. Notes are ordinary rich documents with a permanent `personalNote` marker and creator ownership. Workspace membership is still required; creating or editing requires a writing role. Another workspace administrator cannot read the note through resource lists, links, document state, versions, comments or notification targets.

## Creation and editing

The creation form retains a user/workspace-scoped title and summary draft across reloads and supports draft JSON export. Saving creates a fresh, stable document identifier through the existing durable command outbox. The rich editor then provides collaborative-state persistence, revisions, attachments and current-content exports. Title and summary changes require the metadata save action; rich text uses the editor's automatic synchronization.

The index searches titles and summaries, orders by latest resource update and initially renders 50 rows. More rows can be shown incrementally. This is not rich-body full-text search or server pagination. Archive visibility is optional. Archiving, trashing and restoring preserve document content and permanent ownership.

## Privacy boundaries

Ownership is assigned by the server at creation and cannot be transferred or removed. Existing shared documents cannot be converted into managed personal notes. Notes cannot be assigned to projects, parented under shared structure or used as parents of new resources. Their marker is also checked against the creator when reading, including malformed records with a missing owner field.

Template capture preserves the personal marker and source access policy. Applying a captured note creates a personal copy owned by the applying account even when workspace visibility is requested. A project destination is rejected. Mentioning another member in a private comment does not grant access or expose its target through notifications or activity.

These controls govern application access. They do not encrypt note content against the database operator or turn an administrator-exported database backup into a user-only encrypted vault. AI requests remain optional and require explicit selected context and configured credentials.

## Offline use and verification

After the application shell has been prepared online, the notes screen, draft form and editor chunks are available offline. Cached notes and newly created offline notes use the existing per-user IndexedDB storage, Yjs persistence and metadata outbox. Reconnection retries pending writes. Attachment bytes still require connectivity unless already available through an applicable export.

The synthetic browser check covers offline draft reload, offline creation and rich-text reload, synchronization, Markdown export, administrator denial, summary search, archive/unarchive, metadata editing and trash restoration. Index and editor screenshots cover 1440, 768 and 390 pixel viewports. API tests cover immutable ownership, malformed-record read protection, template copies and mention privacy. Physical-device acceptance, load qualification and broader historical exports remain separate work.
