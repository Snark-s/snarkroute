# Boojum Local And Cloud Dev

The same Studio, canvas, node editor, and executor are used for local and cloud-oriented development. Select the product surface and mode with environment variables:

```text
APP_PRODUCT=boojum
APP_MODE=local
```

`APP_PRODUCT` accepts `boojum` or `snark`.
`APP_MODE` accepts `local`, `cloud`, or `self_hosted`.

## Boojum Local

Use local mode for the existing BoojumRoute Lab behavior, including local filesystem import/export, local route save, local node package paths, and local API key entry:

```powershell
$env:APP_PRODUCT="boojum"
$env:APP_MODE="local"
corepack pnpm run dev:boojumroute
```

The Studio defaults to `http://127.0.0.1:4317` for the API unless `VITE_API_BASE_URL` is set.

## Boojum Cloud Dev

Use cloud mode to exercise the cloud capability gates without creating a second implementation:

```powershell
corepack pnpm run cloud-dev
```

This starts the local Postgres service from `docker-compose.dev.yml`, applies cloud storage migrations, and runs the shared server plus Studio with:

```text
APP_PRODUCT=boojum
APP_MODE=cloud
DATABASE_URL=postgresql://snarkroute:snarkroute@127.0.0.1:5432/snarkroute
DEV_USER_ID=00000000-0000-4000-8000-000000000001
BOOJUM_START_CREDITS=100
BOOJUM_BILLING_MODE=server
```

You can also run the steps separately:

```powershell
corepack pnpm run db:dev:up
corepack pnpm run db:migrate:cloud
corepack pnpm run dev:boojumroute:cloud
```

Cloud dev currently keeps the shared Studio/canvas/editor/executor, hides local filesystem controls, saves routes to Postgres, and uses `DevAuthAdapter` to expose the fixed `DEV_USER_ID` as the current user. New dev users receive `BOOJUM_START_CREDITS` once through the credit transaction ledger.

`BOOJUM_BILLING_MODE=server` reserves and commits Boojum credits around a run. `BOOJUM_BILLING_MODE=byok` keeps provider cost estimates visible but charges `0` Boojum credits.

Google and Yandex auth are intentionally not connected yet. Cloud-stored user keys and public sharing remain capability placeholders until those backends are implemented.
