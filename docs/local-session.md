# Local session and storage lifecycle

## Coordinated sign-out

Signing out through the interface checks the entire user's local outbox, not just the selected workspace. It also checks durable drafts, uncertain server commands, cached documents without a verified server acknowledgement, open resource forms, comments, creation forms and active requests. A failed check preserves the session and local work and explains what must be reviewed. When the blocker is durable local work, an explicit alternative signs out while retaining those copies on the device. Recovery requires authenticating as the same user; the old remembered session cannot open the workspace offline. This alternative still checks every participating tab for unsaved in-memory forms and active requests, and never silently discards drafts.

Each authenticated tab holds a named Web Lock. Sign-out inventories those locks and asks the other tabs to pause and acknowledge their local guards over BroadcastChannel. An unresponsive or newly opened tab prevents sign-out. Concurrent sign-out attempts cannot bypass the check. The interface pauses while the check runs; ordinary background reads cannot create a permanent draft-recovery error merely because a check was cancelled.

An exclusive session gate covers sign-out and cache cleanup. Session initialization takes the corresponding shared gate, so signing back in cannot write into a database while its previous session is still deleting that database. Successful server sign-out writes a persistent per-user generation fence before cleanup. Other tabs leave the workspace, pending old-generation storage writes are refused, and a cached remembered session from that generation cannot restore the workspace offline. New sessions establish their generation only after authentication and the cleanup gate.

The protocol coordinates tabs running this application version. Mixed-version tabs that predate the protocol require separate upgrade acceptance and must be closed before relying on coordinated cleanup.

The guard requires Web Locks, lock inventory, BroadcastChannel and IndexedDB database enumeration in the target browser. Missing capabilities produce a clear refusal rather than silently assuming that other tabs or document databases do not exist. This is a browser capability boundary; physical-device qualification remains pending.

## Durable work protection

Document updates set an `unsynced` marker in their existing IndexedDB custom store. The marker clears only after the server's durability digest matches the current document revision. An intervening update retains the marker. A closed document with an unconfirmed marker prevents cache deletion, even if its editor is no longer mounted. Legacy document caches without this marker require reopening and server confirmation before sign-out. This prevents treating an old offline cache as disposable.

Sprint, hierarchy, template, delivery, custom-field and dashboard drafts carry retention markers in the existing user metadata store. Clearing a draft removes its value and marker in one transaction. Unclassified legacy draft values and uncertain commands also prevent cleanup. Known report/planning/review read caches and denied-navigation markers do not count as unsaved work. No new database version, service or periodic heartbeat is required.

## Storage contention and incompatible tabs

Application-owned IndexedDB opens report blocked upgrades/deletions. The notice asks users to save their work and close the blocking tabs, preserves the database and automatically disappears when the operation resumes. It does not offer a destructive browser-data reset.

An established connection closes on a version-change request. The affected application instance refuses to reopen that obsolete database and displays an update notice while retaining its current in-memory forms and export controls. Opening an already newer database also reports this state. Document persistence disconnects and preserves the cache when its database changes version. Notices render inside the active native dialog when one is open, so keyboard and screen-reader users can reach them.

The notice can be dismissed to reach the preserved form and export controls; dismissing it does not re-enable writes to the obsolete database. `node scripts/storage-notice-check.mjs` verifies this path and exports the retained synthetic draft.

Updating a stale tab still requires explicit confirmation. The application does not automatically reload dirty forms. A future database format needs its compatible application release; reloading the same obsolete build does not migrate unknown data backwards.

## Verification

`node scripts/session-lifecycle-check.mjs` uses synthetic local data and an independent login session. It checks blocked-upgrade recovery, the mobile notice, an unresponsive lock holder, a dirty peer, simultaneous task metadata edits with a retained stale-write conflict, outbox protection outside the active workspace, a closed dashboard draft, offline document recovery, explicit retained-copy sign-out and same-page authenticated recovery, session initialization waiting for a cleanup gate, coordinated sign-out, deletion of user/document databases, offline session refusal and external/newer database versions. Evidence is written to `docs/evidence/session-lifecycle-check.json` and storage screenshots.

This does not prove full draft isolation for every pair of editors, browser-crash recovery for every form, cross-device cleanup, production load limits or physical native-device support. Server-initiated session revocation retains the existing authorization and document-access behavior; this protocol concerns explicit interface sign-out and local cleanup.
