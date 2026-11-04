# Resource navigation

Resource links use `/?resource=<uuid>` on the application origin. Copy controls are available in resource details, with a selectable text fallback when clipboard access is unavailable. Links contain neither credentials nor document contents. Sharing a URL does not grant access.

An authenticated location endpoint checks current workspace membership and the complete resource permission graph before returning the workspace identifier, name and role. Missing, deleted and inaccessible targets return the same opaque response. The client subsequently obtains an authorized workspace snapshot and verifies that the target remains present. Location and snapshot responses are not stored in HTTP caches.

Opening a link can switch workspaces and open a document, task or delivery record. Browser Back and Forward retain the surrounding page context. Page URLs retain the selected workspace, project filter and view across reloads. An initial resource URL survives sign-in. Unsaved resource metadata has a navigation guard; broader draft and multiple dirty-tab lifecycle acceptance remains pending.

Offline navigation uses snapshots and pending creations scoped to the signed-in user. A transport failure can use those local copies, while an explicit server denial cannot. A known denied resource link remains blocked offline until a successful online resolution clears that denial. This is not a claim that every formerly authorized cached document has been erased: complete revocation, logout and open-tab cache lifecycle qualification remains pending.

Workspace reads reserve monotonically increasing IndexedDB sequence numbers. Snapshot commits reject an older sequence after a newer response has committed. A confirmed outbox mutation updates its cached resource, removes the acknowledged command and advances the read barrier in one transaction. UI updates also check the active user/workspace and request generation so that an old workspace response cannot replace the newly selected context.

Read requests receiving HTTP 429 can retry once after an integer server `Retry-After` of at most 60 seconds. Cancellation aborts that wait. Mutation and authentication requests are not automatically retried by this mechanism, and server quotas are unchanged.

## Verification

`tests/navigation.test.ts` covers strict URL parsing, current role metadata, opaque denial, archived/deleted resources, personal ownership and membership revocation. `scripts/navigation-check.mjs` exercises cross-workspace document links, sign-in, browser history, dirty metadata protection, offline cached links, copied-link fallback, a denied reader, restored access, delayed cross-workspace responses, two-tab snapshot ordering and acknowledged outbox ordering. The suite uses synthetic local accounts. Production qualification does not create user content.
