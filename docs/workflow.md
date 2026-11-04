# Workflow states

Each project can name the real stages of its work. Open **Flujo de estados** from a project card or the project structure screen. Administrators and the project's creator can configure it; members and viewers see the configured names.

## Model

A named state belongs to one of the six fixed categories: Backlog, Por hacer, En curso, En revisión, Completada and Cancelada. Tasks keep `status` as their category and store the optional `stateId` of a named state. Reports, sprints, burndown, cycle times, automations and recurrence keep using the category, so their history and definitions do not change.

A category without active named states appears under its usual label. A task without a `stateId` appears in the first active state of its category. Within a category, states are ordered, and the order sets the board columns and selector entries.

## Rules

- Names are unique among active states and limited to 60 characters; a project holds up to 40 states.
- A saved state's category cannot change. Saved states are archived instead of removed, so tasks keep their history.
- Tasks already in an archived state keep it until they move. An archived state cannot be newly assigned.
- A status change, project move, bulk edit, template copy, status automation or recurrence that leaves a `stateId` outside its category or project drops that `stateId` on the server; the task falls back to its category's first active state.

## Interface

A single-project board shows one column per named state, plus columns for categories without named states and for archived states that still hold tasks. Boards that mix projects keep one column per category and show each task's named state in its selector. Lists, task details, grouping by status and sprint plans show the named state.

Configuration drafts are saved per user, workspace and project on the device and survive reload. Saving uses the durable metadata outbox, so configuration and state changes work offline and synchronize later.

## Evidence

`tests/workflow.test.ts` covers immutable categories, archive-only removal, duplicate names, manager permission, misplaced fields, stale-reference normalization, archived-state protection, status automations and the display/column helpers. `scripts/workflow-check.mjs` covers configuration, draft reload, reordering, named board columns, state selection, offline change and reload, reconnection and 1440/768/390 pixel layouts.

Review compatibility before rolling back to a pre-0.17 binary: its strict schema rejects projects and tasks that contain `workflowStates` or `stateId`.
