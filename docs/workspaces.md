# Workspace management

**Configuración → Espacios** lists every workspace the signed-in person belongs to, with their role, member count and creation date.

- **Create**: a new workspace makes its creator the administrator and opens it.
- **Rename**: administrators rename a workspace in place; the selector updates immediately.
- **Hide from the selector**: a personal preference (`hiddenWorkspaces`). The open workspace always stays in the selector; hidden workspaces remain listed here and can be opened or shown again.
- **Leave**: removes the person's own membership. The server refuses to remove the last administrator or the person's only workspace, and locks the workspace row so two administrators cannot leave at the same time. Leaving revokes access to that workspace's projects, documents and personal notes; rejoining needs a new invitation.

Members and roles are still managed under **Equipo**. Creating, renaming and leaving need a connection; opening and hiding work offline.

Deleting or archiving a workspace for everyone is not available yet: background workers, collaboration and several permission paths read memberships directly, so it needs its own qualification.

`tests/workspaces.test.ts` covers listing, rename permissions and validation, last-administrator and only-workspace protection, invitation into a second workspace, leaving and loss of access. `scripts/workspaces-check.mjs` covers the screen, renaming, hiding across reload, opening a hidden workspace, creation and 1440/768/390 pixel layouts.
