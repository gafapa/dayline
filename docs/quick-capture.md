# Quick capture

**Captura rápida** saves a thought without leaving the current screen. Open it from the plus control in the top bar, with Alt+Q outside text fields, or from the command palette (Ctrl+K).

## Destinations

- **Private note** (default): a personal note owned permanently by its creator. A selected shared location never publishes it; other members and administrators cannot read it.
- **Task**: created in a chosen project with its required/default typed fields, an optional due date and, by default, assigned to the author. The dialog discloses that project members can read it.
- **Document**: created in a chosen project, folder or document directory and inherits that location's project and privacy.

Text is stored literally as paragraphs; markup is never interpreted. An optional source link must be a complete http/https address without credentials. It is stored as a plain link: no preview, remote fetch, external image or AI call is made.

**Guardar y abrir** opens the new resource. **Guardar y capturar otra** keeps the dialog open, restores destination defaults and returns focus to the title.

## Drafts, offline and recovery

Each workspace has its own capture draft in IndexedDB, saved while typing and protected during sign-out. Drafts can be exported as JSON or discarded explicitly. Offline captures enter the normal durable outbox; a captured note or document can be opened and edited offline before synchronization.

Captured documents carry `documentSeedVersion: 1`. The server writes the collaborative state from the captured content in the same transaction as the resource, using a document-specific seed client identifier, so offline edits merge without duplicating the initial paragraphs. The seed marker is document-only and immutable; it cannot be added to an existing document. If a seeded document's state is missing, the server reports `initial_document_state_unavailable` instead of fabricating a different history.

Losing write access while the dialog is open disables fields and save actions but keeps export and discard available. A lost response is retried with the same command identifier and does not create duplicates.

## Evidence

`tests/capture.test.ts` covers private ownership, inherited locations, field validation, source URL rejection, input limits, canonical seed bytes, offline merge without duplicates, seed immutability and missing-state reporting. `scripts/quick-capture-check.mjs` exercises the shortcut, palette, workspace draft isolation, offline note creation/reload/reconnection, task fields, lost-response replay, folder documents, permission loss, recovery export and 1440/768/390 pixel layouts. Isolated PostgreSQL staging checks seeded state, note privacy and seed immutability before production replacement.

Review compatibility before rolling back to a pre-0.16 binary: an older server rejects pending outbox captures carrying the seed marker, and it would derive a missing seeded state from metadata instead of reporting it.
