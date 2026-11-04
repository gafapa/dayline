# Dayline: notes for contributors and coding agents

- Follow **[docs/architecture.md](docs/architecture.md)**: simple first, one way to do each thing, one responsibility per module, domain rules in `shared/`, and the server as the authority.
- UI text is in Spanish. Code, comments and docs are in English.
- Before committing, run `npm run check`. For UI flows, run `npm run preview:test` and then `npm run e2e:quick`.
- Never commit personal or deployment data: emails, server addresses, hostnames, credentials or production evidence. Deployment tooling lives outside this repository.
