# Architecture and design guidelines

Dayline is a self-hosted app for **small teams on one small server**. Every design choice is measured against that: prefer the simplest thing that keeps people's work safe.

## Principles

1. **Simple first.** Add a mechanism when a real problem needs it, not "in case". Don't add versioning, negotiation or handshakes until a second version or a second party actually exists.
2. **One way to do each thing.**
   - One way to save drafts (`useDraft`).
   - One way to send changes (the outbox).
   - One drag-and-drop system (`src/dnd.tsx`).

   Before adding a new mechanism, extend the existing one.
3. **One responsibility per module.**
   - A screen is one file under `src/`. `App.tsx` only composes the shell, navigation and session.
   - The server registers one module per area (`register*Routes`).
   - Rules shared by client and server live in `shared/`.
4. **Domain rules live in `shared/`, not in components.** Components call pure functions (`boardColumns`, `applyStateOption`, `placeInOrder`…) that have unit tests.
5. **Server is the authority.** It validates every write with zod, checks permissions (`canRead`/role) and uses `expectedVersion` for concurrency. The client never relies on its own checks for safety.
6. **Protect what's worth protecting.** Keep:
   - the offline outbox with conflicts;
   - collaborative editing;
   - permissions;
   - idempotent operations (`operationId`);
   - document content validation;
   - rate limits, MFA and audit.

   Don't add more layers around them.
7. **Explicit over clever.** Name things after what they do, not where they were first used (for example `useDraft`, not `useSprintDraft`). Avoid abstractions with a single caller.
8. **Small files, small functions.** As guidance, a component over about 400 lines or a function over about 60 lines is a signal to split it.

## Patterns to use

| Need | Pattern |
|---|---|
| A new screen | One lazy-loaded component file with props in and callbacks out. No hidden globals. |
| Saving a resource | `save(resource)`, which goes through the outbox and works offline. |
| A multi-step server action | One server endpoint in a transaction, with `expectedVersion`, `operationId` and a 409 on conflict. |
| Drag and drop | `useDrag` / `useDrop` from `src/dnd.tsx`. The drop target declares `accepts` and `drop`. |
| Unsaved long form | `useDraft`. Only for long forms where losing input hurts (sprint planning, templates, delivery). Settings screens save directly. |
| Shared rule (client and server) | A pure function in `shared/`, plus a test in `tests/`. |

## Tests: fast and safe

- `npm run check`: typecheck plus unit tests. Run it before every commit.
- `npm run preview:test`, then `npm run e2e:quick`: the core browser flows in a few minutes.
- `npm run e2e` runs every browser check. CI runs it on every push.
- Write a browser check when a flow crosses several screens; otherwise prefer a unit test. Keep checks short and focused on behaviour, not on pixel details.
- Browser checks share one synthetic account. A check that changes a preference must restore it.

## Before adding complexity, ask

1. Which real failure does this prevent, and how often does it happen for a small team?
2. Does an existing mechanism already cover it?
3. Can it be removed easily later if it proves unnecessary?

If the answers are "rare", "yes" or "no", don't add it.
