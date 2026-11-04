# Personal reminders

The **Recordatorios** screen schedules personal inbox notices in the selected workspace. Each reminder belongs permanently to its creator; other members and administrators cannot read its metadata, versions, delivery status or resulting notification. Current membership and access to an optional linked target remain required.

## Capture and scheduling

Create an independent reminder or use **Crear recordatorio personal** on a readable task, document, project, folder, sprint, milestone, release, decision or risk. A linked capture preserves its target in the creation draft across reloads. Reminders are not nested project resources and cannot be assigned to another account.

The editor stores a title, optional message, local date/time, IANA time zone and explicit choice of the first or second occurrence of a repeated hour. Nonexistent local times are rejected instead of being silently normalized. The server retains a canonical UTC instant between 2000 and 2099. Changing the zone keeps the entered local clock value, so review both fields before saving. Dates have minute precision in the interface.

New and edited reminders use user/workspace-scoped drafts and the normal durable metadata outbox. Draft JSON export preserves incomplete input. Creation, cancellation and rescheduling can be saved offline and synchronize later. A past-due reminder is processed when its command reaches the server; it is not a device alarm.

## Delivery and lifecycle

The existing worker checks at most 50 due reminders per pass. It normally runs every 15 seconds while the server application is running. Permission checks, notification preferences and quiet hours govern delivery. Quiet-hour notices enter the same persistent notification queue. Disabling the reminder category suppresses a due schedule once; it does not repeatedly retry the disabled notice.

Each schedule has a canonical revision identifier. Processing records are retained for every processed revision, including suppressed or unavailable deliveries. Workspace locks and transactional insertion prevent duplicate processing. Reusing a previously processed revision after another schedule is rejected. Metadata no-op saves retain the current pending quiet-hour notice.

Editing a schedule, cancelling it or moving it to trash cancels its older queued delivery. Already delivered inbox records remain as history. Rescheduling or reactivating creates a new revision and can produce a new notice, including immediately when its date is already past. Trash restoration keeps the reminder disabled until explicitly reactivated. Read-only members can read a previously scheduled reminder and its delivery but cannot create or change reminders.

At delivery the worker checks membership, current target visibility and the current schedule. Notifications link back to the personal reminder; the inbox can open that target. Delivery states distinguish delivered notices, quiet-hour deferral, preference suppression, unavailable targets and cancelled delivery. The interface retains a timestamped local status cache for offline reads; stale status is labelled as such.

The read-only status cache does not count as unsaved work during sign-out. Actual reminder drafts remain protected, including after leaving their screen. The browser regression checks a blocked dirty-draft sign-out followed by two-tab cleanup and refusal to restore the signed-out session offline.

## Export, recovery and limits

Title/message filtering, explicit cancelled-record visibility, initially 50 rendered rows and filtered JSON export keep the list usable without another service. Individual resource links retain navigation and prepared offline state. Reminder JSON and workspace metadata archives contain schedule metadata, not the worker's processing receipts. Database backups include the processing table and pending notification queue; preserve both to maintain delivery deduplication during recovery.

Review compatibility before rollback to a pre-0.15 worker. This feature delivers to the internal inbox and does not request browser notification permission. Push, email, native-device alarms, load guarantees, bounded historical retention and full encrypted-archive disaster recovery remain separate work.

## Evidence

Tests cover canonical instants, repeated/skipped hours, ownership, foreign administrators, reader roles, command replay, worker recreation, cancelled/rescheduled quiet deliveries, current permissions, preference suppression, schema migration, processing-history preservation and rejected identifier reuse. The synthetic browser flow covers offline creation/reload/reconnection, actual delivery, lost-response retry, linked capture draft recovery, cancellation/reactivation, private access, trash restoration, exports and 1440/768/390 pixel layouts. Isolated PostgreSQL staging exercises the real background worker and delivery/privacy/history gates before production replacement.
