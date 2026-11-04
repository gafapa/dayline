# Document format compatibility

The editor, API and database currently use document schema **1**. This format has not changed from the original rich editor. The application release version and document schema version serve different purposes.

## Negotiation and local preservation

Every current web API request sends `X-Kelvin-Document-Schema: 1`. API responses and health advertise the server format. Document and template writes, collaborative tickets, binary-state downloads and revision routes require an exact match. A missing or incompatible declaration receives HTTP 409 with `detail.code=document_schema_mismatch`. Other ordinary project/task operations do not require document capabilities.

Before constructing the local Yjs persistence or Tiptap editor, the app checks the resource format, the server declaration when reachable and the document cache marker. Unmarked local caches and resources are recognized as the known baseline schema 1. JSON document and template writes reject unknown blocks and attributes before storing them; revision restoration checks the same structure before changing the current editor. Unknown markers are preserved and refused; they are never replaced by an empty document. Downloads use the same cache check. Server connectivity failures still permit compatible cached offline editing.

The cache marker lives in the existing Yjs database's `custom` store under `document-schema`. The check occurs before opening `IndexeddbPersistence`, so refusing a marker does not append Yjs updates or normalize unfamiliar nodes. A compatible version can reopen the same data later.

Queued document mutations retain their originating `documentSchemaVersion`. A client that cannot interpret that version records an outbox error and sends no document mutation. It does not relabel the pending payload. Templates preserve per-document markers; incompatible template documents do not mount the rich editor, and the server refuses their application.

When a server response reports incompatibility, the application shows an update notice and disables editing. The document details remain mounted so unsaved metadata is not discarded by that notice. Collaborative document copies remain in local storage. Reload is an explicit action; normal unsaved-navigation handling still applies.

## Database and migration policy

`document_format` records the authoritative stored format. Startup migration refuses a different version within its transaction, before opening the collaboration listener. It does not rewrite or convert documents. JSON and complete workspace exports declare the document format in their manifest; individual document payloads also retain their marker.

Changing editor nodes, marks or serialized attributes requires compatibility review, a new `DOCUMENT_SCHEMA_VERSION`, and an explicit transactional database and local-cache migration or a separately preserved new cache. The schema fingerprint test detects unreviewed structural changes. Do not update its expected hash merely to silence a failure. Verify preservation of unsupported nodes, edits, states, attachments and queued operations before releasing a migration.

Releases before this protocol cannot enforce its local checks. The server refuses their document/template writes and synchronization tickets; their old interface may show a generic access error until refreshed. An already downloaded copy cannot be remotely erased. Rollback to a pre-protocol binary requires a compatibility review: those binaries do not understand the new document metadata or the startup format guard. No future format conversion or arbitrary old-client compatibility is claimed by this release.

## Evidence

- `tests/document-protocol.test.ts`: missing/stale capabilities, falsely labelled payloads, unchanged stored content and receipts, state/revision protection, transactional startup refusal, advertised format and the reviewed schema fingerprint.
- `scripts/document-protocol-check.mjs`: online/offline cache refusal before editor creation, bytewise preserved updates, recovery, retained dirty metadata, server mismatch, rejected stale tickets and retained future outbox payloads without an HTTP mutation.
- Release staging check: exact-image PostgreSQL capability negotiation and rejected future document writes.

Cross-tab logout cleanup, IndexedDB upgrade-blocking UX and historical revision privacy remain separate tracked requirements.
