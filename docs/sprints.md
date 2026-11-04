# Sprint planning, estimation and delivery history

## Planning and capacity

The Sprints screen groups planning, shared estimation, review/retrospective and metrics. Create planned sprints ahead of time, select backlog work or work from another planned sprint, and order the selected tasks with the move controls. Tasks in another active/closed sprint must be moved out explicitly before this planner can select them.

Planning commits the sprint definition, completion criteria, task scope/order and capacity in one transaction. The request includes both the sprint version and every affected task version. Stale or inaccessible work rejects the entire transaction; unrelated task descriptions/statuses are not overwritten. A workspace lock serializes concurrent team metadata writers.

Capacity uses independently entered available days, hours per day, focus percentage and optional point capacity per member. The interface reports hours and story points separately. Empty point capacity means unspecified. An overload warning compares assigned points against that person's entered point capacity; it does not convert story points into hours or predict productivity.

Only members and administrators manage the shared plan. Read-only users can inspect accessible work. Private project/task context remains enforced independently of sprint visibility. Planning requires access to every affected current task, preventing a partial view from silently removing hidden work.

## Local drafts and offline copies

Unsaved plans and review notes are stored in the signed-in user's IndexedDB metadata. Switching areas or reloading restores their original expected versions. The browser reports when the local write has actually committed. Malformed drafts are preserved with a recovery message and require an explicit discard before replacement.

After a sprint has been opened online, its current plan and latest review are cached for offline reads and draft preparation. Server commands, voting and applying estimates require connectivity. Local drafts are not silently rebased or automatically submitted after reconnecting. Core sprint UI assets are included in service-worker installation so an early first visit does not leave its offline module missing. API responses are never put into the public service-worker cache.

Starting and closing are disabled while an unsaved planning draft exists. Shared-device/multi-tab logout cleanup remains in the global acceptance ledger.

## Start and closure

Starting preserves a baseline containing the actual starting task versions and capacity. It is never replaced by subsequent scope edits. An active sprint cannot be reset to planned to rewrite that baseline. Old sprints without recorded baselines show an explanation instead of an invented initial scope.

Closure checks the sprint version and, when supplied by the planning UI, the complete task-version set. Remaining completion criteria or completed-task checklist exceptions require explicit acknowledgement. Open estimation rounds are cancelled. The closure snapshot preserves task metadata and estimates; later task edits cannot rewrite it. Unfinished work moves either to the backlog or a selected future/active sprint. Self-rollover and closed/deleted destinations are rejected.

Review notes remain editable after closure through a separate versioned record. They cannot modify the closure snapshot. Retrospectives record successes, improvements and follow-up task links; newly created follow-up tasks inherit the sprint's access context. Review history can be paged and restored as a new draft, preserving previous versions.

## Shared estimates

A sprint has one open round at a time. Members/admins facilitate; guests with access can vote. Viewers cannot vote. Votes use a small story-point deck, an uncertainty card and a break card. A person can change their own card while voting remains open.

Before reveal, each response exposes only that caller's own card and participation status, even to an administrator. Reveal requires the facilitator or an administrator. Cancelled unrevealed rounds never expose others' cards. Previously revealed rounds preserve their revealed history.

Applying consensus is a separate explicit command with a selected numeric estimate, round version and current task version. There is no automatic average. A stale task rejects application without consuming the round. Retried commands are idempotent; the estimate change is versioned and follows normal notifications/automation events. Access is rechecked against both current task context and the round's original access context, so publishing a task does not publish its previous private estimates.

The UI currently shows up to 50 recent rounds after permission filtering. Polling batches votes into one query and strips document text/large snapshots from its permission lookup. Full large-history navigation remains part of the collection/pagination work.

## Metrics and privacy

Burndown shows remaining points; burnup shows total scope and completed points. Exact recorded changes are drawn as steps for up to 200 meaningful points. Larger histories are summarized into bounded time samples and visibly marked. An accessible table accompanies each chart, and scale/date labels use normal page text so they remain legible on mobile.

Scope history records additions, removals and estimate changes after start. Mean lead time runs from task creation to its first recorded completion; cycle time runs from its first recorded in-progress state to its first completion. The sample count is reported, missing states are not imputed, and these are elapsed durations rather than worked hours. Reopened tasks do not create fictitious additional cycle samples.

Calculations include only current readable tasks and historical snapshots whose original project/parent/owner context is also readable. The baseline, frozen snapshot, version endpoints, round history and metrics all apply this boundary. The 10,000-version interactive calculation limit returns an explicit unavailable result instead of a partial curve. Metrics query only the fields needed for timing, scope and permissions, bounding memory when task descriptions are large.

## Evidence and remaining scope

`tests/sprints.test.ts` covers atomic/stale planning, baseline immutability, closure exceptions/rollover, hidden votes, explicit/idempotent consensus, current/historical privacy and metric calculations. `scripts/sprints-check.mjs` uses two isolated browser contexts with synthetic local users and verifies offline draft reload, capacity, secret voting, reviews, selected rollover, charts and mobile overflow.

The deployment staging script checks these commands on the real PostgreSQL image using temporary isolated containers before production replacement. Public production checks create no demonstration projects/tasks.

Configurable dashboards, broader portfolio delivery analytics, large-collection pagination and physical Android/iOS/native acceptance remain in the full requirements ledger. Publication of this module does not complete the overall product scope.

Lifecycle controls remain disabled while a saved plan is being refreshed. This prevents starting or closing with the pre-save sprint version during the synchronization window.
