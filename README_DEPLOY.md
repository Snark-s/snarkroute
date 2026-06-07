# Boojum Cloud Deploy

## Local Production Check

Create a local production env file:

```bash
cp .env.production.example .env.production
```

For local checks, set these URL values in `.env.production`, then copy the example Caddyfile and verify the production images before starting the stack:

```text
PUBLIC_APP_URL=:80
AUTH_BASE_URL=http://boojum.local
APP_WEB_URL=http://boojum.local
```

```bash
cp Caddyfile.example Caddyfile
docker compose --progress=plain -f docker-compose.prod.yml build api web
docker compose -f docker-compose.prod.yml --profile migrate run --rm migrate
docker compose -f docker-compose.prod.yml up --build
```

Open `http://127.0.0.1` if you keep the default compose ports. The production check command requested for this repository is:

```bash
docker compose -f docker-compose.prod.yml up --build
```

## Production Deploy

1. Copy `.env.production.example` to `.env.production`.
2. Set `PUBLIC_APP_URL`, `AUTH_BASE_URL`, and `APP_WEB_URL` to the public site address, for example `https://boojum.example.com`.
3. Set strong unique values for `POSTGRES_PASSWORD`, `SESSION_SECRET`, and `AUTH_HASH_SECRET`.
4. Copy `Caddyfile.example` to `Caddyfile`.
5. Build and start the stack:

```bash
docker compose -f docker-compose.prod.yml up -d --build
```

6. Run migrations explicitly after Postgres is healthy:

```bash
docker compose -f docker-compose.prod.yml --profile migrate run --rm migrate
```

7. Restart API after migrations if this is the first deploy or a schema-changing release:

```bash
docker compose -f docker-compose.prod.yml up -d api
```

## Environment Variables

Required application variables:

```text
APP_PRODUCT=boojum
APP_MODE=cloud
PUBLIC_APP_URL=https://boojum.example.com
AUTH_BASE_URL=https://boojum.example.com
APP_WEB_URL=https://boojum.example.com
DATABASE_URL=postgresql://boojum:password@postgres:5432/boojum
SESSION_SECRET=<long random secret>
AUTH_HASH_SECRET=<long random secret>
GOOGLE_CLIENT_ID=<optional google oauth client id>
GOOGLE_CLIENT_SECRET=<optional google oauth client secret>
YANDEX_CLIENT_ID=<optional yandex oauth client id>
YANDEX_CLIENT_SECRET=<optional yandex oauth client secret>
OPENROUTER_API_KEY=<optional openrouter key>
POLZA_API_KEY=<optional polza key>
POLZA_AI_API_KEY=<same value as POLZA_API_KEY for legacy provider checks>
REPLICATE_API_KEY=<optional replicate key>
REPLICATE_API_TOKEN=<same value as REPLICATE_API_KEY for legacy provider checks>
BOOJUM_START_CREDITS=25
ARTIFACTS_DIR=/app/data/assets
```

Compose also uses:

```text
POSTGRES_DB=boojum
POSTGRES_USER=boojum
POSTGRES_PASSWORD=<long random postgres password>
```

`DATABASE_URL` must match the Postgres values. With the bundled Postgres service, the host is `postgres` and the port is `5432`.

## Production Safety

For VPS and production deployments, `APP_DEV_UI=false` is mandatory. The production compose file sets it explicitly.

Never run production with `APP_DEV_UI=true`. The server refuses to start when `APP_DEV_UI=true` and `NODE_ENV=production` with:

```text
APP_DEV_UI must not be enabled in production
```

Production should use real authentication and database roles for admin access. Dev identity switching is only for local cloud development.

## Backup

Back up Postgres before deploys and before running schema migrations:

```bash
docker compose -f docker-compose.prod.yml exec -T postgres pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" > boojum-backup.sql
```

Back up generated artifacts separately if they are stored in the named Docker volume:

```bash
docker run --rm -v snarkroute_boojum-artifacts:/data -v "$PWD:/backup" alpine tar czf /backup/boojum-artifacts.tgz -C /data .
```

If your Compose project name is not `snarkroute`, inspect the actual volume name with:

```bash
docker volume ls
```

## Rollback

1. Stop the stack:

```bash
docker compose -f docker-compose.prod.yml down
```

2. Check out or redeploy the previous release.
3. Restore the database only when the rollback requires pre-migration data:

```bash
docker compose -f docker-compose.prod.yml up -d postgres
docker compose -f docker-compose.prod.yml exec -T postgres psql -U "$POSTGRES_USER" "$POSTGRES_DB" < boojum-backup.sql
```

4. Start the previous release:

```bash
docker compose -f docker-compose.prod.yml up -d --build
```
