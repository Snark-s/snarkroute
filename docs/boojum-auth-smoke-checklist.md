# Boojum Cloud Real OAuth Smoke Checklist

Use this checklist after configuring real Google/Yandex OAuth credentials.

## Config

1. Set `APP_MODE=cloud`.
2. Set `NODE_ENV=production` for production-like guard checks, or `development` for local callback testing.
3. Set `AUTH_HASH_SECRET` to a long random value, at least 32 characters.
4. Set `AUTH_BASE_URL` to the public API origin.
   - Local: `http://127.0.0.1:4317`
   - Production: `https://api.example.com`
5. Set `APP_WEB_URL` to the public Studio origin.
   - Local: `http://127.0.0.1:5173`
   - Production: `https://app.example.com`
6. For Google, set `GOOGLE_AUTH_ENABLED=true`, `GOOGLE_CLIENT_ID`, and `GOOGLE_CLIENT_SECRET`.
7. For Yandex, set `YANDEX_AUTH_ENABLED=true`, `YANDEX_CLIENT_ID`, and `YANDEX_CLIENT_SECRET`.
8. Run:

```powershell
corepack pnpm run smoke:auth-config
```

## Provider Redirect URIs

Register these callback URLs with providers:

- Google local: `http://127.0.0.1:4317/api/auth/google/callback`
- Yandex local: `http://127.0.0.1:4317/api/auth/yandex/callback`
- Google production: `https://api.example.com/api/auth/google/callback`
- Yandex production: `https://api.example.com/api/auth/yandex/callback`

## Browser Flow

1. Before login:

```powershell
Invoke-WebRequest -Uri "$env:AUTH_BASE_URL/api/auth/me" -UseBasicParsing
```

Expected: JSON has `"user": null`.

2. Open one start URL in a browser:

- `$env:AUTH_BASE_URL/api/auth/google/start`
- `$env:AUTH_BASE_URL/api/auth/yandex/start`

Expected:

- Browser redirects to provider login.
- Response creates `boojum_oauth_state` cookie.
- Google path also creates `boojum_oauth_nonce` cookie.
- Both cookies are `HttpOnly`, `SameSite=Lax`, and `Secure` in production.

3. Complete provider login.

Expected callback result:

- Backend validates `state`.
- Google backend validates `nonce`.
- Backend creates `boojum_session`.
- `boojum_session` is `HttpOnly`, `SameSite=Lax`, has `Max-Age`, and is `Secure` in production.
- Browser redirects to `APP_WEB_URL`.

4. After login:

```powershell
Invoke-WebRequest -Uri "$env:AUTH_BASE_URL/api/auth/me" -UseBasicParsing
```

Expected: JSON has a user object with `id` and `role`; it does not include email/name/avatar.

5. Logout:

```powershell
Invoke-WebRequest -Method Post -Uri "$env:AUTH_BASE_URL/api/auth/logout" -UseBasicParsing
```

Expected:

- Server deletes the session row.
- Response clears `boojum_session`.

6. After logout:

```powershell
Invoke-WebRequest -Uri "$env:AUTH_BASE_URL/api/auth/me" -UseBasicParsing
```

Expected: JSON has `"user": null`.

## DB Privacy

Run these checks after a real Google/Yandex login:

```sql
select provider, provider_subject, provider_subject_hash
from auth_identities
where provider in ('google', 'yandex');
```

Expected:

- `provider_subject` is null.
- `provider_subject_hash` is present.
- No raw Google `sub`, Yandex `uid`, or Yandex `psuid` is stored.

```sql
select users.id, users.email, users.display_name
from auth_identities
join users on users.id = auth_identities.user_id
where auth_identities.provider in ('google', 'yandex');
```

Expected:

- `email` is null.
- `display_name` is null.

Also run:

```powershell
corepack pnpm run smoke:auth-config
```

It checks config, production URL guards, provider credential presence, provider hash stability, and DB privacy for real OAuth identities when `DATABASE_URL` is set.
