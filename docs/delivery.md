# Delivery planning

Planning contains a dated roadmap, milestones, releases, risks and decisions. Rules/execution history and teams remain in separate areas. Search opens the specialized detail. Comments, mentions, following, attachments and version history remain available without bypassing the planning editor or confirmation rules.

## Milestones and releases

Milestones belong to active projects and select direct tasks and preceding milestones. Readable descendant-project tasks are eligible. Dependencies must be acyclic. Achievement requires an explicit server confirmation.

Releases select direct tasks, milestones and relevant risks, with a version identifier, repository reference, tag, notes and publication checklist. Repository URLs must use HTTPS without embedded credentials. The prepared state validates current conditions; publication checks again because source changes can invalidate preparation.

Confirmation requires an objective, nonempty task/milestone scope, completed or cancelled tasks and their transitive task dependencies, achieved preceding/included milestones, completed criteria and accepted/resolved release risks. Releases require at least one publication checklist item. Cancelled tasks remain recorded as cancelled. Unavailable dependencies reject the operation instead of disappearing from the scope.

Publication records a reviewed delivery in this project. Repository links/tags are references. Repository event ingestion, tag creation and deployment integrations remain separate requirements.

## Risks and decisions

Risks record probability and impact on a 1–5 scale, their product on a 1–25 scale, mitigation, contingency, review date and responsibility. Identified risks can remain unassigned. Mitigating/resolved risks require responsibility and mitigation; acceptance requires responsibility and an explicit reason. The assignee must be able to read the record and scope. Publication preserves the risk's original status, score and mitigation/acceptance context independently of later changes.

Decisions record alternatives, tradeoffs, choice and rationale. Acceptance requires at least two alternatives, a valid choice and rationale. Accepted content remains immutable. Accepting a new proposal that references an accepted decision atomically supersedes the earlier decision and links both. Its original receipt stays unchanged. Concurrent supersession requires a new check.

## Confirmation, privacy and history

Readiness collects the project/ancestor context, selected scope, task dependencies and prior decisions. Confirmation supplies explicit expected versions for the root and every reference. A workspace transaction validates exact agreement, persists status/receipt/history/activity and supersedes any earlier decision together. Failed checks have no partial effects.

Receipts retain actor, time, root version, checklist, note, referenced versions, task statuses/estimates, risk context and original permission scopes. Confirmed core metadata is immutable; archiving, trash/restore and following retain the receipt. Comments are separate records. Attachment lifecycle follows the normal attachment permissions; the receipt is not a frozen attachment manifest.

Direct references inherit access boundaries. Confirmation additionally checks dependencies and parent/target context. Receipt reads require access to current sources and their original permission snapshots. Publishing a previously private project does not publish an originally private receipt. Versions and command replay apply the same checks. Request-local permission memoization uses resource object identity, preserving original/current context differences while avoiding repeated dependency expansion.

## Offline behavior and limits

The roadmap uses persisted planned dates and retains undated records in the list. Its scrollable timeline has an equivalent dated list. Rendering starts with 100 records; server pagination and general virtualization remain pending.

User-scoped IndexedDB drafts preserve their expected base version. Offline saves use the ordered outbox. Confirmation requires connection and outbox synchronization. Changed source versions disable confirmation until another check. Persisted command identifiers support lost-response/reload retry without duplicate effects.

Limits: 200 direct tasks, 50 direct milestone dependencies/inclusions, 100 release risks, 500 collected context/reference records and 900 KiB of complete metadata including receipt. Permission traversals fail closed beyond their depth bound. These are resource bounds, not measured concurrency/load acceptance.

## Evidence

`tests/delivery.test.ts` covers conditions, cycles, descendant scope, stale versions, immutable estimates, responsibility, risk acceptance, supersession, roles, historical privacy and bounded dependency permission work. `scripts/delivery-check.mjs` covers the browser workflow, discussion/history, interrupted confirmation replay, offline drafts/outbox and three viewport widths. `scripts/design-delivery-check.mjs` uses the actual design probe/judging modules. The deployment stage qualifies the exact image against isolated PostgreSQL. Fixtures remain local or in staging; production verification is read-only.
