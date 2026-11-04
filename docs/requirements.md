# Product requirements and acceptance ledger

The complete scope is the functionality inventory requested in the conversation. A feature is complete only when its durable behavior, permission boundaries and user interface have been verified. This ledger deliberately distinguishes planned work from tested delivery.

Each feature's verified behaviour is described in its own note in this folder.

## Architecture decisions

- TypeScript, React, Vite, Fastify and PostgreSQL.
- PGlite is a development/test PostgreSQL engine, never the production deployment database.
- A modular application with a separate collaboration listener; no mandatory Redis, search server or model runtime.
- Responsive installable web application; mobile application packaging remains a separate acceptance requirement.
- Document content uses Yjs; transactional project metadata uses versioned server commands.
- All external AI requests are opt-in, permission scoped and initiated through the server.
- English documentation, identifiers and comments; Spanish initial product interface.

## Full scope

All items below are planned until linked evidence proves otherwise.

1. Workspaces, teams, invitations, projects, folders, subprojects, favorites, recent items, templates, archive and portfolio.
2. Block documents, project/task links, autosave, version restore, page trees, backlinks, reusable blocks, document templates, table of contents, Mermaid, mathematics, version comparison and Markdown/HTML/PDF export.
3. Typed tasks, descriptions, workflow, priority, assignees, labels, dates, subtasks, checklists, acceptance criteria, ordered backlog, list/board, estimates, relationships, recurrence, custom fields, bulk editing and saved views.
4. Sprint lifecycle, goals, planning, blockers, rollover choices, immutable closure snapshots, capacity, future planning, scope changes, definition of done, planning poker, review and retrospective.
5. Milestones, releases, roadmap, dependencies, decisions, risks, technical debt, regressions, release checklists and repository links/events.
6. Comments, mentions, activity, collaborative editing, presence, anchored comments, threads, resolution, following, review requests, catch-up and guests.
7. Personal tasks, quick capture, today/week, reminders, private notes, calendar, optional time tracking and daily summary.
8. Scoped search, filters, shortcuts, command palette, saved searches, document/local search and optional semantic search.
9. Responsive PWA, offline reads/writes, durable outbox, reconnect, visible durability states, conflicts, downloads/storage control, mobile capture, push and Capacitor packaging.
10. AI providers, credentials, model, enablement, budget, selected context, summaries, task/acceptance/sprint suggestions, duplicate detection, referenced questions, reports, translation, reviewed application and audit.
11. Roles, read/write, privacy, server authorization, trash/restore, export, backups/restores, MFA, sessions, granular permissions, audit, retention and expiring share links.
12. Inbox, notification preferences, quiet hours, GitHub/GitLab, calendars, email, webhooks, public API and Markdown/CSV/Notion/Trello imports.
13. Event rules, automatic assignment, recurrence, due reminders, repository workflow, periodic summaries, project templates and execution/retry history.
14. Progress, burndown/burnup, cycle/lead time, scope/blockers, workload, configurable dashboards/reports, storage/AI usage, workflow/custom-field administration, locale/time zone/theme.
15. Keyboard/screen reader/touch accessibility, progressive rendering, large collections, interrupted-write recovery, clear errors, themes/reduced motion and tested browser/device support.

## Deployment requirements

- Self-hostable with Docker Compose or any Node.js 24 host with PostgreSQL ([self-hosting guide](self-hosting.md)).
- Probe authenticated live state before changes; preserve unrelated services.
- Review TLS routing, DNS, database isolation, private configuration and durable volumes.
- Package hashes, rollback, backup verification, public HTTPS verification and authenticated application checks.
- Do not label an untested feature or deployment complete.
