# Notification preferences and quiet hours

Notification settings belong to the signed-in account and apply across its workspaces. The available transport is the internal inbox. Email, push and external delivery adapters are separate pending integrations.

## Categories and delivery

Assignments, review requests, followed items, comments, mentions, automatic rules, overdue notices and daily summaries have independent switches, together with a master switch. Existing delivered notifications remain in the inbox. New disabled events are suppressed; disabling a category also cancels its queued deliveries when the worker next examines them. When one event has several reasons, the highest-priority enabled reason is used, with at most one notification per recipient. A disabled mention can therefore still produce a comment notification if that category is enabled.

Quiet hours specify a start, end, IANA time zone and selected start days. An overnight Monday schedule can continue into Tuesday morning. Equal start/end times, empty/repeated day selections and invalid zones are rejected. UTC minute traversal resolves skipped and repeated local hours to the first available minute. Existing stored settings are validated on use; malformed settings disable new delivery rather than silently opting an account into notifications.

During quiet hours, the server stores the notification in a PostgreSQL queue. It is absent from resource lists, links, versions, inbox activity and workspace exports until delivered. There is no extra queue server. The existing in-process worker checks at most 50 due deliveries every 15 seconds while the application runs. Work resumes after restart. Transactional insertion and queue removal prevent duplicate inbox records.

## Permission and rule changes

Delivery checks current workspace membership, current target/project access and current preferences. Lost access, trashed targets and disabled categories cancel pending delivery. A preference change wakes queued rows for re-evaluation; a newly active quiet schedule can postpone them again. Already delivered records retain the ordinary resource permission rules.

Automation deliveries also retain their source rule/version. A deleted, disabled, changed or inaccessible source rule cancels its pending delivery. Delayed daily summaries recompute task counts using current actor and recipient permissions at delivery time, so old aggregate content is not revealed after a scope change. Delivery of an automation notification creates the normal version and activity entries. Its originating automation run records that delivery was queued or suppressed instead of claiming an immediate resource result.

## Settings, drafts and concurrency

The dedicated settings API uses an account-local version. A stale save is rejected unless it exactly repeats the immediately preceding successful save, allowing recovery from a lost response. Generic preference updates cannot overwrite notification settings or their version.

The settings form retains a user-scoped draft, including incomplete time-zone input, across offline reloads. Applying settings requires connectivity; the draft is preserved on failure. After a conflict, the user can explicitly discard the draft and load current server settings. Saving does not silently overwrite another session. The former appearance-only grouping checkbox is removed; the legacy `quietHours` preference is not treated as an enabled delivery schedule.

## Verification and limits

Tests cover category suppression/fallback, account isolation, stale and uncertain saves, quiet-window boundaries, daylight-saving gaps/repetitions, restart delivery, exactly-once resource persistence, target/membership loss, rule changes and permission-scoped summary recomputation. The browser check covers offline incomplete drafts, refused offline application, response loss, conflict recovery and three viewport widths. Synthetic PostgreSQL staging verifies actual background delivery before production replacement.

The queue is durable but does not promise delivery during application downtime or under unmeasured load. It uses bounded batches, not a maximum end-to-end latency guarantee. A database backup includes pending deliveries; a compatible worker is needed to resume them. Review queue and preference compatibility before rollback to a pre-0.14 application. Retention policy, external delivery channels, physical-device acceptance and load limits remain pending work.
