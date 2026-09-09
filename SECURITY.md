# Security Policy

## Reporting a vulnerability

Do **not** open a public issue for a security report. Use GitHub's **"Report a vulnerability"** button on the Security tab of this repository — reports go to the maintainers privately and are triaged before any public disclosure. If GitHub advisories are unavailable, contact the maintainers through a private channel listed on the repository profile.

Please include: affected package and version, a minimal reproduction, and your assessment of impact. Maintainers will acknowledge reports as soon as practicable and provide status updates when material progress is available.

## Supported versions

| Version            | Supported                                  |
| ------------------ | ------------------------------------------ |
| latest 0.x release | yes                                        |
| older 0.x releases | no — 0.x is pre-1.0; upgrade to the latest |

## Scope and classification (read before reporting)

Moult is an **orchestration and ownership library, not a sandbox**. A plugin with JavaScript execution privileges can access any object reachable from its imports or context; Moult does not attempt to isolate untrusted code. This is a documented, deliberate non-goal (`docs/notes/01-thesis-and-boundaries.md`, `docs/notes/05-adapters-and-host-integration.md` § Security).

Therefore the following are **not** security vulnerabilities in Moult:

- a plugin escaping "isolation" — there is none to escape;
- a plugin accessing host state it can already reach from JavaScript;
- resource exhaustion caused by a plugin's own unbounded work (the runtime caps only its own diagnostics).

What _is_ in scope: a guarantee in `docs/notes/01` / the invariant registry (INV-01…INV-15) failing to hold, transaction boundaries leaking staged state, or disposal semantics that lose ownership of runtime-managed resources.

## Coordinated disclosure

We credit reporters in the release notes of the fix unless they prefer to remain anonymous. Fixes are released before or with the advisory publication.
