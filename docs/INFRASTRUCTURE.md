# AirDows infrastructure and rollback

## Current topology

- Production remains on Railway and is not changed by this branch.
- GitHub Actions validates unit tests, syntax, and the critical two-browser transfer flow.
- Coverage is retained as a GitHub artifact and can also be published to Codecov through OIDC after the repository is connected there.
- Runtime secrets stay outside Git. `.env.example` contains names only.

## Heroku staging gate

The `Procfile` and `app.json` make the app deployable as a separate Heroku staging app. Do not attach `airdows.com`, delete Railway, or reuse a production database until all gates pass:

1. `/healthz` returns HTTP 200.
2. Two real browsers pair by code and QR.
3. A direct WebRTC transfer succeeds in both directions.
4. A forced TURN transfer succeeds and relay usage is visible in private metrics.
5. WebSocket reconnect and session recovery pass after a dyno restart.
6. Admin dashboard authentication, PostgreSQL writes, and optional Telegram alerts are verified with staging-only secrets.
7. DNS TTL and the Railway deployment ID are recorded before any cutover.

After creating the isolated app, run `AIRDOWS_STAGING_URL=https://... npm run test:staging` to validate the public health route and Socket.IO handshake before real-device transfer tests.

## Secret ownership

The Doppler project `airdows` has separate `dev`, `stg`, `prd`, and personal development configurations. The application-owned Railway variables are mirrored in `airdows/prd` as an encrypted recovery copy. Railway remains the runtime source of truth and retains every original value; Doppler is not connected to deployment and saving this inventory does not redeploy the service.

`NODE_ENV`, `ALLOWED_ORIGINS`, and explicit `TURN_*` values are optional runtime configuration, not missing production secrets. Production currently uses the Metered credentials instead of duplicating both TURN configuration families. Net-new staging values must not copy production credentials unless compatibility requires it and the copy is explicitly approved.

## Rollback

If Heroku staging fails, delete only the staging app and keep Railway unchanged. If a later cutover is approved, preserve Railway for at least 72 hours, switch DNS back to the recorded Railway target on any transfer, WebSocket, TURN, database, or latency regression, then invalidate staging-only secrets.
