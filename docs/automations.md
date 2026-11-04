# Automations and recurring tasks

## Rules

Open **Planificación**, add an **Automatización**, choose its project and configure its event, action and optional label/status filters. Enable the rule after completing its configuration. Only its author or an administrator can edit it. Members must select a project; workspace-wide rules require an administrator. Up to 100 live rules are accepted per workspace.

Supported events are task creation, task metadata updates, due tasks and daily summaries. Actions assign a current member, change task status or create an internal notification. Daily summaries always create a notification. Recipient visibility is checked again at execution. These actions do not send email, call webhooks or contact external services.

Updates performed by rules do not trigger other rules. Completing a recurring task through a rule still queues its next occurrence. Disabled, archived or deleted rules cannot execute. If a queued rule was edited before execution, its old event is cancelled; an authorized manual retry explicitly applies the current configuration.

## Durable execution

The application process checks its PostgreSQL queue every 15 seconds, including after startup. No Redis, cron daemon or separate worker is required. Each event has a unique workspace-scoped key. Job state and resource effects commit together. Workspace locks serialize metadata writes across different users and independent worker instances.

Unexpected failures roll back partial effects and retry after one and two minutes, up to three attempts per cycle. After that the run stops as failed. Authorized retries preserve the immutable attempt journal and total attempt count. Permission changes, missing targets and changed conditions cancel a run without side effects. The history UI exposes accessible runs, individual attempts and paged attempt history. Heartbeats distinguish an active worker from an unstarted or failing worker.

Each tick scans up to 100 scheduled rules, queues up to 100 eligible due tasks per rule and executes up to 50 pending jobs. The scheduled-rule cursor rotates across workspaces. These limits bound individual passes; a large queue may take multiple passes. History retention and queue/load acceptance at large scale remain tracked separately.

## Dates and recurrence

Scheduled rules interpret their hour in an IANA time zone such as `Europe/Madrid`. A due rule runs once per task and due date, on or after that day at the configured hour. Completed, cancelled and archived tasks are excluded. Daily summaries run once per local calendar day after the configured time and include only tasks visible to both rule author and recipient. Missed past summaries are not replayed.

Task recurrence is completion-based: completing a daily, weekly or monthly task creates one next task at the next future date. A completion event cannot create a second occurrence after reopening/completing the same source. Late completion skips missed dates. An optional series end date prevents creation beyond that day.

The next task preserves its title and planning metadata, resets the checklist, clears sprint scope, dependencies and related links, and shifts its start date by the due-date offset. Attachments and comment threads remain with the completed source. Monthly recurrence retains its original anchor day: January 31 becomes February 28, then March 31. Recipient memberships and related-resource permissions must still be valid; otherwise the run is cancelled for review.

## Deployment and verification

Release staging runs the exact application image against the deployed PostgreSQL image in a temporary internal network. Both containers have memory/CPU caps, the staging database uses tmpfs and no production volume is attached. It checks simultaneous writes from two accounts, the actual background worker, recurrence and attempt history. The upgrade proceeds only after staging passes, then preserves all existing containers except the application being replaced.

HTTP static assets do not consume API rate-limit quotas. Authenticated API quotas are keyed to verified accounts. Login/recovery quotas use the client address, trusting forwarded addresses only from the configured exact `TRUSTED_PROXY_IP`. The upgrade discovers Traefik's current proxy-network address. Refresh that setting and recreate the application if Traefik's address changes; never trust an entire container network by default.

Local browser evidence uses synthetic accounts and checks rule configuration, activation, background effects, recurrence, attempt history and mobile layout. Production browser checks are read-only apart from login/logout and verify the worker heartbeat without creating sample projects or tasks.
