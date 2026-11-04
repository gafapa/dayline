# Local session and sign-out

Dayline keeps a local copy per user in IndexedDB: snapshots, the outbox of unsent changes, drafts of long forms, read caches and Yjs documents.

## Signing out

`signOutEverywhereLocal` (`src/session-coordination.ts`):

1. **Refuses** while this tab has work in progress: an open creation form, a pending server command or a request in flight.
2. **Refuses** while the device still holds unsent work: queued changes in any workspace, saved drafts, or a document whose content the server hasn't confirmed as stored. The person can then sync or discard it, or choose **"Conservar copias locales y cerrar sesión"** to keep it for the next sign-in.
3. Calls `/logout`, then writes a sign-out marker to `localStorage` **before** deleting anything. Other tabs notice through the `storage` event, and sleeping tabs notice on wake, so they return to sign-in. Their local writes are refused from then on.
4. Deletes the user's local databases, unless they asked to keep them.

Read caches (`cache:` keys) never block sign-out.

## Limits

An unsaved edit held only in another tab's memory (not in a draft) is lost when you sign out from a different tab. Long forms keep drafts for that reason.

## Verification

`scripts/session-lifecycle-check.mjs` covers:
- blocked storage upgrades;
- conflicting saves from two tabs;
- refusal with unsent changes in another workspace, with a saved draft, or with an unconfirmed document;
- the retained sign-out and recovering a draft after signing in again;
- sign-out reaching other tabs;
- deletion of local data;
- external database upgrades.
