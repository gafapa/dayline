# Platform administration

**Configuración → Plataforma** is visible only to platform administrators. It manages accounts across the whole server, independently of workspace roles. The first account created on a server is its platform administrator; when upgrading an existing server, the oldest account receives the role if nobody has it.

## Accounts

The list shows every account (search by name or email): workspaces and roles, last sign-in, open sessions, whether an authenticator is configured, platform administration and suspension.

| Action | Effect |
| --- | --- |
| Cerrar sesiones | Deletes every session; open tabs and collaboration connections lose access at their next check. |
| Crear enlace de nueva contraseña | Creates a single-use link valid for 24 hours, shown once to the administrator. Only the newest link works. Using it sets a new password (8+ characters), closes all sessions and keeps the authenticator. |
| Restablecer autenticador | Removes the authenticator and recovery codes and closes all sessions; the person signs in with their password and can configure MFA again. |
| Suspender / Reactivar | Suspension closes sessions, invalidates pending reset links, refuses sign-in and invitation acceptance, and stops automations authored by the account. Data and memberships are kept. Reactivation restores sign-in. |
| Administración de la plataforma | Grants or removes the platform role. |

Rules: administrators cannot suspend themselves or remove their own platform role, and at least one active platform administrator always remains. Actions are serialized so two administrators cannot remove the last active role concurrently.

## Audit

Every action, including a completed password reset, is recorded in `platform_audit` with actor, target, time and non-secret details, and listed under **Historial de administración**. Reset links are never stored in plain text or in the audit.

## Limits

Permanent account deletion is not available: documents, personal notes and history the account created need an ownership decision first. Reset links are delivered by the administrator; there is no email delivery yet. Suspension does not remove memberships, so workspace member lists still show the person.

## Evidence

`tests/platform.test.ts` covers authorization, account listing and search, suspension (sessions, sign-in, automations, reactivation), session revocation, MFA reset, single-use and superseded reset links, the last-administrator rule and the audit trail. `scripts/platform-check.mjs` covers the screen for an administrator and a member, suspension and refused sign-in, reactivation, a reset link used in a separate browser, session revocation, the audit list and 1440/768/390 pixel layouts. Isolated PostgreSQL staging repeats the authorization, suspension, single-use reset and audit gates.
