# Self-hosting Dayline

Dayline runs as one Node.js service, which serves the web app, the API and real-time collaboration, plus a PostgreSQL database. The included `docker-compose.yml` puts Caddy in front of it, so you get automatic HTTPS when you use a domain.

## Requirements

- Docker with Compose v2.
- A machine with about 1 GB of free memory.
- For a public installation, a domain whose DNS points to that machine, with ports 80 and 443 open.

## 1. Configure

```bash
git clone https://github.com/gafapa/dayline.git
cd dayline
cp .env.example .env
```

Fill in `.env`:

| Variable | What it is |
|---|---|
| `APP_ORIGIN` | The address people open in the browser, e.g. `https://dayline.example.com`. For a local test, `http://localhost`. |
| `DAYLINE_ADDRESS` | What Caddy listens on: your domain for automatic HTTPS, or `:80` for plain HTTP. |
| `POSTGRES_PASSWORD` | Password for the bundled database: `openssl rand -hex 24`. |
| `SETUP_TOKEN` | One-time code the installation wizard asks for: `openssl rand -hex 24`. |
| `ENCRYPTION_KEY` | 64 hex characters: `openssl rand -hex 32`. It encrypts two-step verification secrets and AI provider keys. **Keep a copy.** Without it those secrets can't be read back. |

## 2. Start

```bash
docker compose up -d
docker compose logs -f app   # wait for "Dayline API is ready."
```

## 3. Run the installation wizard

Open `APP_ORIGIN`. The first visit shows the installation wizard:

1. **Servidor:** checks the database, the encryption key and the public address, and warns you if `APP_ORIGIN` doesn't match the address you're using.
2. **Tu cuenta:** creates the first account, which becomes the platform administrator.
3. **Tu espacio:** names your first workspace and asks for the `SETUP_TOKEN`.
4. **Listo:** shows the next steps (invite your team, create a project, quick capture).

The wizard only appears while no account exists. After that, people join by invitation.

## Updating

```bash
git pull
docker compose up -d --build
```

Database migrations run automatically on start.

## Backups

Everything lives in the `database` volume. A simple daily dump:

```bash
docker compose exec -T database pg_dump -U dayline -d dayline --format=custom > dayline-$(date +%F).dump
```

Restore into an empty database with `pg_restore --clean --if-exists`. Store dumps and your `.env` (it holds `ENCRYPTION_KEY`) somewhere safe and off the machine.

## Without Docker

```bash
npm ci
npm run build
NODE_ENV=production DATABASE_URL=postgresql://… APP_ORIGIN=https://… \
SETUP_TOKEN=… ENCRYPTION_KEY=… HOST=0.0.0.0 npm start
```

Put a reverse proxy in front of it:
- Route `/collaboration` (WebSocket) to port `4311`.
- Route everything else to port `4310`.
- Set `TRUSTED_PROXY_IP` to the proxy's exact IP so rate limits see real client addresses.

## Plain HTTP

In production, session cookies are `Secure`. Browsers accept them over plain HTTP only on `localhost`. To use the app from other devices, use a domain with HTTPS.
