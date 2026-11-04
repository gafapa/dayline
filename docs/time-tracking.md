# Optional time tracking

## Entries and clocks

The Time screen records manual durations or persistent clocks in the existing `time_entry` resource type. A log has a description, optional notes, an allocation date, a time-zone snapshot, optional original project/task links and personal or shared visibility. New interface entries are personal by default. Shared entries remain subject to their complete permission context; workspace administration cannot rewrite another author's entry.

Durations are integer seconds. The interface displays hours:minutes:seconds, and exports both exact seconds and decimal hours. The server derives the legacy `minutes` field from seconds rather than trusting a second client total. A completed entry lasts between one second and seven days.

A clock stores its original start instant and initially records zero seconds. Stopping stores an explicit end instant and the elapsed duration, rounded down to whole seconds. UTC instants measure elapsed time across daylight-saving changes; the editor displays them in the entry's stored time zone. The server checks the interval, rejects inconsistent duration values and allows at most five minutes of future clock skew. The mode, original start and time zone cannot be rewritten, and a recorded clock cannot reopen.

Clocks continue conceptually after a tab closes because elapsed time comes from the persisted start, not a browser counter. No background timer process or additional server service is needed. One-second UI updates live inside the visible clock component and do not recompute the report. Multiple clocks and manually reported durations may overlap; totals add those entries. Running clocks do not contribute to recorded totals. If a clock was left open for more than seven days, the interface retains it and requests a corrected manual entry and explicit removal instead of truncating its duration.

## Scope and privacy

Visibility and original project/task relationships become immutable at creation. A task-linked new entry must use that task's project. Later task moves do not silently reassign past work: the original attribution remains, and access to the current task and all recorded contexts is still required. To change visibility or attribution, create a separate entry rather than publishing private history through an ordinary edit.

Every mutation retains the current task/ancestor permission context alongside the previous distinct contexts. Reads, resource versions and durable command retries check the current graph and every retained original graph. Changing a project from public to private, editing a log there and publishing the project again does not expose those private edits. PostgreSQL `jsonb` key ordering is normalized when comparing contexts, so ordinary edits do not exhaust the history bound merely because object keys were reordered.

The context is limited to 500 locations per graph, 32 distinct graphs and 512 KiB in total. Duplicate graphs do not add another copy. Parent cycles, deleted/missing locations and ancestor permission types that cannot be captured correctly are refused. The user can instead link directly to the project or create an unlinked entry. The existing project/folder/document/task/sprint/team/comment/notification/retrospective/automation inheritance rules are supported; dynamic dashboard, template, view and delivery permission policies are not silently flattened.

## Offline durability

New forms and edits use user/workspace-scoped local drafts. Saves, stops, deletions and restoration use the existing versioned outbox and operation identifiers. Reloading offline restores the queued resource and its clock state. Reconnecting sends the captured stop instant; retrying a lost acknowledgement uses the same operation and cannot add another completion. Conflicting edits remain explicit outbox conflicts rather than overwriting another version.

The application also schedules one outbox check when pending work becomes available during session initialization. This covers a connection event that occurred before the cached session/outbox was ready. It uses the existing serialization/backoff behavior, not a periodic retry loop or relaxed request quotas.

Cached offline permissions reflect the last verified snapshot. Online checks remain authoritative, and losing a task/project permission can hide an associated log. Personal drafts and unresolved changes retain the existing export/review and explicit sign-out retention behavior.

## Reports and exports

Filters select allocation dates, an original project with optional descendants, an author and archive visibility. Deleted entries or entries with unavailable/deleted ancestors do not contribute, including pending local deletions. Recorded integer seconds drive the total and project/author/date breakdowns. A clock crossing midnight is allocated to the chosen entry date, not automatically split into calendar days.

CSV exports contain only the selected recorded entries, with allocation date, author name and stable author ID, original project, task, description, notes, seconds, hours, origin, visibility and UTC endpoints. Active clocks are excluded. Cells use the common UTF-8/RFC-style exporter with spreadsheet formula neutralization. A former member without a current display name remains identifiable through the exported author ID.

The interface initially renders 100 report rows and explicitly adds the next batch. Small screens retain all fields in a work/duration list, with the duration visible beside the work name. Filter controls collapse into a native disclosure whose caption continues to show the period and scope.

## Qualification

- `tests/time-tracking.test.ts`: durations, invalid dates, daylight-saving intervals, personal/shared visibility, authorship, normalized totals, forged context rejection, attribution, retries, stale versions, original/current privacy, descendants, archives/deletions and context canonicalization.
- `scripts/time-tracking-check.mjs`: real compiled interface flows, durable offline drafts/entries, clock reload, offline stop, reconnect during interrupted initialization, lost-response replay, scoped arithmetic/CSV, reader controls, historical privacy and 1440/768/390 layouts.
- `scripts/design-time-check.mjs`: authenticated report/editor probes and screenshots at three widths, reusing Framed sheet direction 94022767.
- Release staging check: the exact release image against isolated PostgreSQL, including `jsonb` context deduplication, manual/clock writes, protected context changes, author-only edits and stop replay.

Production smoke checks open the report online and offline without creating real work entries. Synthetic browser fixtures and isolated staging do not establish production load limits or physical-device qualification. See the complete requirements ledger for the remaining product scope.
