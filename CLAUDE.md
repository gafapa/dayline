# Dayline: notes for contributors and coding agents

- Follow **[docs/architecture.md](docs/architecture.md)**: simple first, one way to do each thing, one responsibility per module, domain rules in `shared/`, and the server as the authority.
- UI text is in Spanish. Code, comments and docs are in English.
- Before committing, run `npm run check` (types, unit tests and build at once). For UI changes, `npm run verify -- --quick` (or `npm run verify -- <name>-check …`) also starts a fresh preview and runs those browser checks; CI runs all of them on every push.
- `npm run preview:test` starts with an empty database each time (`KEEP_DB=1` keeps it); `browser-check` sets the synthetic account up again.
- Never commit personal or deployment data: emails, server addresses, hostnames, credentials or production evidence. Deployment tooling lives outside this repository.
