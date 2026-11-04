# Custom task fields

Projects can define up to 50 task fields, including archived definitions. Supported types are text, finite number, boolean, calendar date, single selection, multiple selection, HTTP(S) URL and workspace member. Each selection supports up to 50 stable options. Tasks retain up to 100 custom values, including legacy and origin values.

Project creators and workspace administrators configure fields from **Campos de tareas** in project cards or the project structure. Readers cannot change definitions. The server enforces the same rules for ordinary edits, bulk commands, templates, recurrence and automation updates.

## Reviewed configuration

Configuration changes use separate preview and apply commands. The preview validates existing live tasks and reports only tasks the caller can read. An apply command checks the project version and a fingerprint of the reviewed task versions, applies required defaults and records the operation atomically. A changed project/task set requires another preview. Repeating an acknowledged operation does not apply it twice, and replay rechecks its permission scope.

Required fields can use defaults to populate missing values. Optional defaults apply to newly created tasks; populating existing empty values requires the explicit backfill checkbox. Existing nonempty values remain intact. Zero and false are values. At most 1,000 tasks can change in one configuration command. A configuration that would change an inaccessible task is refused.

Saved field types and identifiers are immutable. Archive definitions or options instead of deleting them. Renaming keeps values; archived choices remain visible on existing tasks. Invalid bounds, incompatible values, unknown option IDs and invalid member selections are rejected. Archived values and unchanged former-member selections survive unrelated edits.

## Task workflow

Task creation, task details, subtasks and sprint review actions render typed controls. Saved task views support project-scoped AND conditions and up to eight displayed properties. Bulk editing merges one field into existing values and validates the entire versioned batch before committing.

Configuration drafts remain on the current device and can be recovered offline. Configuration review/apply requires a connection. Uncertain responses retain a durable command for retry. Task values use the ordinary offline outbox and conflict handling. Viewer controls are read-only.

Project templates carry their field definitions and task values into an independent project scope. Standalone task templates preserve origin labels and values; those values are read-only until the destination has compatible definitions, or the user explicitly removes them. Snapshots retain only selected option metadata and omit unused defaults and descriptions. Existing named freeform fields remain available.

## Boundaries and evidence

This feature does not add formulas, computed fields, schema type conversion, cross-project field mapping or historical access-control migration. Document revision visibility retains the limitations described in [hierarchy.md](hierarchy.md).

- `tests/custom-fields.test.ts`: typed values, defaults, permissions, atomicity, retries, stale previews, archives, templates, filters, bulk commands and minimized snapshots.
- `tests/automations.test.ts`: configured fields survive automatic assignment and recurring-task creation.
- `scripts/custom-fields-check.mjs`: compiled browser workflow, offline drafts/editing, lost-response recovery, saved filters, bulk changes, read-only access and mobile overflow.
- `scripts/design-custom-fields-check.mjs`: actual rendered administration, task and filter screens at 1440, 768 and 390 pixels.
- Release staging check: exact-image PostgreSQL configuration, concurrent command replay, atomic backfill, typed bulk validation and template copying before production replacement.
