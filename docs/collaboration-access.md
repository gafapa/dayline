# Collaboration access lifecycle

The collaboration listener checks the current session, workspace membership, document deletion state and inherited resource permissions. Viewers receive read-only connections. Access is checked before each incoming frame and again before returning durability confirmations.

The production entry point wires `createApp.onAccessChange` to `revalidateConnections`. Before an API write response is sent, the listener rechecks established connections, closes connections that have lost access and updates reader/editor modes. This includes logout, explicit session revocation, membership changes, personal document ownership, project privacy and deletion. Revalidation also runs every 15 seconds for idle connections, including sessions that expire without an HTTP request; database latency can delay that interval.

Authorization reads carry an access generation. A recheck invalidates reads already in flight, so a delayed membership result cannot overwrite a newer reader role. Overlapping sweep requests request another complete pass before their shared promise resolves. Finishing a sweep clears its active slot before its promise resolves, so a request arriving at that boundary starts a fresh sweep. Sweeps stop during listener shutdown and the timer does not keep the process alive.

The editor consumes authenticated scope and access-mode notifications independently of its workspace snapshot. A stale snapshot therefore cannot keep an already downgraded editor writable. An explicit access-revoked close disables editing and displays a recovery message. Reopening the document performs fresh authorization. Local copies are retained; this release does not claim remote erasure of content already downloaded or complete shared-device cache cleanup.

Changes admitted before revocation may finish persisting afterward. Revocation prevents subsequent authorized document traffic; it does not roll back previously accepted edits or remove their history. Complete historical/export permission acceptance, content schema negotiation, multiple dirty tabs and logout across all application tabs remain separately tracked.

## Verification

`tests/collaboration.test.ts` uses real loopback WebSocket connections and the production provider protocol with an in-memory PostgreSQL engine. It covers reader downgrade and restoration, rejected writes, inherited project privacy, document deletion, membership removal, logout, session revocation, idle expiry and an intentionally delayed membership read. The tests use Node 24's built-in WebSocket client with an Origin header; no additional production service or package is required.

`scripts/collaboration-access-check.mjs` verifies the rendered editor at 390px while deliberately retaining an outdated HTTP snapshot. It verifies role changes, disabled editing after access loss, retained local content and explicit reopen after access restoration. All fixtures are synthetic and local.

The isolated PostgreSQL staging check uses the exact release image and real WebSocket frames to verify sync, reader/editor mode changes, document privacy revocation and logout. It attaches no production volumes.
