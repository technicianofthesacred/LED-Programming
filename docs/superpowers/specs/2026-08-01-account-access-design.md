# Lightweaver Account Access — Minimal Design

## Goal

Replace the email allowlist with a small, private account system for a few trusted people. Only the owner can create accounts. There is no public registration.

## Roles

- **Owner:** full library access; creates, disables, and resets accounts; assigns customer projects; reviews customer drafts; may permanently delete.
- **Worker:** sees the shared library and may create, edit, duplicate, import, export, and archive projects; may not manage accounts or permanently delete.
- **Customer:** sees only assigned projects and works in a separate draft; may not change the official project, browse the shared library, manage accounts, archive, permanently delete, or download/restore the master library backup.

## Account flow

The owner creates a username, display name, role, and temporary password in an owner-only Accounts panel. The new user signs in with that username and password and must choose a new password before using the Studio.

There is no signup, email verification, invitation system, organization model, or automated password recovery. The owner resets a forgotten password by issuing another temporary password; doing so revokes the user's existing sessions. The owner can also disable an account immediately.

## Authentication and storage

D1 gains three small data sets:

- `accounts`: normalized unique username, display name, password hash, fixed role, active/disabled state, temporary-password flag, and minimal failed-login backoff state.
- `account_sessions`: hashed random session token, account ID, and expiry/revocation timestamps.
- `project_assignments`: customer account ID and the official project it may access.

Passwords are stored only as versioned, salted hashes. Authentication uses a random `Secure`, `HttpOnly`, `SameSite` session cookie. Login returns the same error for an unknown username and an incorrect password. Repeated failures cause a short account lockout. Sessions expire and are revoked when an account is disabled, reset, or changes role.

No plaintext password, session token, or temporary password is logged or stored after account creation.

## Customer drafts

Customer drafts reuse the existing project, revision, and private R2 storage rather than introducing a second editing system. A draft project records its official parent project and customer owner.

Opening an assigned project opens or creates that customer's draft. Autosave and revision history affect only the draft. The owner sees the draft beside the official project and can promote its current state into the official project as a new revision. Promotion never destroys prior official revisions.

## Authorization

Every library request resolves the session to an active account and enforces the role on the server. The browser UI hides unavailable actions, but server checks remain authoritative.

- Owner and worker requests use the shared library.
- Customer queries are filtered to assigned projects and their own drafts.
- Permanent deletion remains owner-only.
- Account management and draft promotion remain owner-only.

## Interface

Signed-out users see a compact Lightweaver username/password form in the Library section. Signed-in users see their display name, role, and a Sign out action.

Owners also see an Accounts panel with: create account, reset password, enable/disable, change role, and assign customer projects. This is one simple table and one small form, not a separate administration application.

Customers see only an Assigned projects list and clear copy that they are editing a draft. Owners see a Review draft action on projects with customer work.

## Safe rollout

1. Add the D1 migration, native authentication, role checks, and UI while the current Cloudflare Access protection remains active.
2. Use the existing verified owner session to create the first native Owner account.
3. Verify owner, worker, and customer behavior in preview, including denied access and customer draft isolation.
4. Switch the library API from Access authentication to native session authentication only after those checks pass.
5. Verify production signed-out denial and all three roles. Keep the previous deployment available for rollback.

At no point should an unauthenticated request be able to read or modify project data.

## Validation

Automated tests cover login, forced password change, logout, expiry, reset, disable, role enforcement, worker delete denial, customer project filtering, draft isolation, draft promotion, and unauthenticated denial. Production smoke tests confirm the public Studio remains reachable while library data requires a valid Lightweaver session.

## Explicit non-goals

- Public registration or self-service account creation
- Email-based identity or recovery
- Two-factor authentication
- User groups, custom permission builders, organizations, billing, or customer sharing
- Real-time collaborative editing
- Multiple simultaneous customer drafts for the same customer/project pair
