# Configurable dashboards and project analytics

The **Informes** screen provides personal and shared dashboard resources. A dashboard saves project/descendant scope, archive visibility, assignee and label filters, a time zone, a relative or explicit history window, section visibility/order and one or two columns. The seven available sections are summary, project portfolio, task states, workload, attention, delivery history and sprint closure history.

Project selection is workspace scoped. Shared dashboards are visible only to people who can currently read every explicitly selected project. A shared workspace-wide dashboard computes each reader's own authorized data. Personal dashboards retain their owner's restriction even for other administrators. Only the author or an administrator can update a shared configuration; viewer accounts can explore filters without publishing changes. Configuration changes use the normal versioned outbox and its conflict review. Dashboard history and command retries retain original ancestor permission context for explicit project references.

## Current data

Each task appears once in the panel totals. Selecting a project can include its visible descendants; portfolio rows show each project's direct work so summing rows does not double count descendants. Unprojected tasks have a separate row when the whole workspace is selected. Archived projects, archived ancestor locations and archived tasks are excluded unless requested. Deleted tasks are excluded. Cancellation remains visible in the state distribution and is excluded from the current task/point scope.

Workload counts open tasks and estimated points, with separate unassigned and unavailable-person groups. Overdue work uses the configured local calendar date. Dependencies that are incomplete or unavailable produce an attention indicator without exposing a hidden dependency's status. The report uses task estimates as points; elapsed historical durations are labelled in hours.

## Historical calculations

The analytics endpoint runs a read-only repeatable-read PostgreSQL transaction. It reads only the selected current task cohort and the minimal permission/state history needed for its former and current contexts. It does not fetch histories of currently unreadable ancestors. Historical membership projections retain only the requesting user's membership bit rather than copying every member list into every event. Unknown or unsupported historical context is refused as evidence for a transition.

The engine reconstructs project/folder/document and supported relationship contexts at event time and checks both historical and current permission boundaries. PostgreSQL event timestamps preserve microseconds so two visibility changes within one millisecond are not collapsed. Events sharing a transaction timestamp are evaluated after its ancestor snapshots have been installed.

A delivery is an authorized entry into `done`; a task created as done is one such event. Reopening and completing a task can create further deliveries. The report shows event count, distinct delivered tasks, reopening count, daily series and median lead/cycle durations. Lead measurements require a complete authorized history from creation. Cycle measurements require the first verified start and continuous authorized work segment of a cycle; returning from review to work keeps that start, while a reopening begins another cycle; a later public cycle can be measured without revealing an earlier private phase. Durations are elapsed hours, including calendar time, rather than business-hour estimates.

The current project/assignee/label/archive filters define the cohort used to inspect history. Moving, relabelling, archiving or deleting tasks can therefore change the report. These are permission-scoped cohort reports, not immutable organization-wide totals. Closed sprint rows use recorded closure task states and estimates, limited to currently available cohort tasks whose original closure context is authorized. The history window affects historical events and closures; it does not silently change the current workload scope.

A query admits at most 2,000 relevant current/context resources, 5,000 task versions, 10,000 context versions, 366 calendar days and 100 returned sprint closures. Too much history returns an explicit unavailable result rather than partial aggregate figures. A saved configuration records at most 500 unique referenced ancestor locations and 512 KiB of original permission context; the client checks those bounds before queuing a save. These bounds do not establish a measured multi-user load limit.

## Offline use and exports

Configuration drafts are user/workspace/dashboard scoped on the current device. Offline panel saves are durable outbox mutations. A lost response can be retried without creating a duplicate panel or incrementing its version twice. A stale base version remains a conflict to review. Explicit reset discards only the selected local configuration draft.

Historical results are cached per user and normalized filter set with a scope signature and timestamp. The cache is reused offline only when the current resource versions still match; offline changes that invalidate that signature require a connected recalculation. Superseded requests cannot replace a newer result. An online permission denial does not silently fall back to a cached report.

Portfolio and daily history CSV exports contain the currently displayed authorized cohort. Spreadsheet formula prefixes are neutralized, quotes/newlines are escaped and UTF-8 text is preserved. Panel permalinks resolve through the normal resource ACL. Opening a project from a saved panel retains that panel as its browser-history backdrop across reload and close.

## Evidence and remaining scope

`tests/analytics.test.ts` covers rollup arithmetic, archives/descendants, private historical ancestors, microsecond ordering, daylight-saving durations, scope and event limits, immutable configuration ownership, stale versions, protected history and command replay. `tests/navigation.test.ts` covers validated report backdrops.

`scripts/dashboard-check.mjs` exercises widget order, filters, recoverable date errors, personal/shared saves, offline drafts and queued updates, lost-response replay, portfolio navigation, CSV downloads, offline history, reader controls and permission revocation. `scripts/design-analytics-check.mjs` inspects rendered reports and settings at 1440, 768 and 390 pixels. The exact-image PostgreSQL stage checks dashboard creation, delivery metrics and author/project authorization. Production smoke verification reads the reports online and offline without creating production dashboard fixtures.

This adds no chart server, search server, external telemetry or mandatory AI provider. Arbitrary SQL/custom widget builders, cross-workspace aggregation and forecasts are not provided. Other full-scope requirements remain in the implementation checkpoint.
