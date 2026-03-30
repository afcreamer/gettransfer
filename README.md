# GetTransfer Journey Extractor

Small Node toolkit for fetching GetTransfer carrier jobs, refreshing auth, receiving OTPs, and serving a dashboard UI.

The dashboard can now be protected with WebAuthn passkeys or hardware keys.
This secures your own GetTransfer dashboard and admin actions. It does not replace
GetTransfer's upstream OTP-based login, which still runs underneath when the tool
needs to authenticate to GetTransfer itself.

## What It Handles

The CLI expects the same response shape you captured:

- top-level `data.transfers`
- each transfer containing fields like `id`, `date_to_local`, `from`, `to`, `pax`, `distance`, `time`, and `transport_type_ids`

It can:

- reuse a saved session from a prior login capture
- request a login code and complete login via Gmail IMAP or phone OTP
- fetch the live request with your authenticated browser cookies
- fall back to a real Chromium context when direct cookie replay is rejected
- serve a dashboard with job filters, scrape/auth status, cookie ages, 2FA source, and scheduler controls
- parse a saved JSON response body offline
- export normalized journeys as `pretty`, `json`, or `csv`

## Dashboard

Start the dashboard locally:

```bash
npm run dashboard
```

Or:

```bash
node src/dashboard-server.js
```

By default it listens on `http://0.0.0.0:8765`.

The dashboard exposes:

- `/` for the UI
- `/keys` for access-key management
- `/audit` for the human-readable audit trail
- `/health` for health checks
- `/otp` for Tasker/phone OTP delivery
- `/api/status` for scrape/auth/session metadata
- `/api/jobs` for normalized job data
- `/api/audit` for structured audit events and session-continuity summaries
- `/api/refresh` for manual refresh
- `/api/login-refresh` for forced re-login followed by refresh
- `/api/gotify-test` for a manual Gotify delivery test
- `/api/schedule` for scheduler settings
- `/api/auth/status`, `/auth/register-options`, `/auth/register-verify`, `/auth/login-options`, `/auth/login-verify`, `/auth/logout` for local WebAuthn auth

The UI includes:

- passkey / YubiKey login and first-user setup
- separate access-keys page for viewing and deleting registered keys
- separate audit page for readable refresh, login, OTP, and notification history
- live jobs table with search and filter controls
- default job filters for `one_way`, `Economy Or Any`, and nearby jobs within the configured postcode radius
- Gotify notifications for newly seen jobs matching those default criteria
- scrape status, last refresh result, last error, and job totals
- session age plus `rack.session` and `cf_clearance` expiry details
- last 2FA method and latest OTP source/title
- manual `Refresh Data` and `Login + Refresh` buttons
- configurable daily or weekly auto-pull schedule

Dashboard state files are stored in the working directory:

- `./.dashboard-config.json`
- `./.dashboard-state.json`
- `./.dashboard-audit.jsonl`
- `./.latest-jobs.json`
- `./.latest-provider-payload.json`

On container startup, the dashboard now waits briefly, tries a normal data refresh first,
and only falls back to login if the fetch is rejected. You can control that with:

- `DASHBOARD_STARTUP_REFRESH=true|false`
- `DASHBOARD_STARTUP_REFRESH_DELAY_MS=1500`

WebAuthn settings can be left to auto-detect from the request host behind your reverse proxy,
or pinned explicitly with:

- `WEBAUTHN_RP_NAME=GetTransfer Dashboard`
- `WEBAUTHN_RP_ID=gettransfer.summerhouse.dscloud.me`
- `WEBAUTHN_ORIGIN=https://gettransfer.summerhouse.dscloud.me`
- `WEBAUTHN_SESSION_MAX_AGE_SECONDS=604800`

Distance filter settings:

- `DASHBOARD_REFERENCE_POSTCODE=EH4 4DN`
- `DASHBOARD_REFERENCE_RADIUS_MILES=15`

The dashboard resolves the reference postcode via the open [Postcodes.io API](https://postcodes.io/docs/api/)
and then calculates job distances locally from the `from_point` / `to_point` coordinates already present
in the GetTransfer payload.

Gotify settings:

- `GOTIFY_URL=http://172.23.0.10/message`
- `GOTIFY_KEY=...`

The dashboard sends Gotify alerts for newly seen jobs matching the default filters:

- `type === one_way`
- transport is blank or includes `economy`
- start or end is within the configured postcode radius when a distance is known

For phone OTP login, the browser-assisted path now runs headless by default.
Use `--headful` only if you explicitly want to see the browser window.

If both `GETTRANSFER_PHONE` and `GETTRANSFER_EMAIL` are configured, `login` now tries:

1. phone first
2. email second if phone login fails

If you pass `--phone` or `--email` explicitly, only the explicit target is used.

## Usage

Request a login using the configured fallback order:

```bash
node src/gettransfer.js login
```

Request a fresh code, poll Gmail, and save a refreshed session using email only:

```bash
node src/gettransfer.js login \
  --email you@example.com \
  --timeout 180
```

The login flow uses:

- `POST /api/account` with `request_code: true`
- Gmail IMAP lookup for the `Confirmation code` email
- `POST /api/account/login` with the numeric code as the `password` field

The Gmail helper reads `GMAIL_USER` / `GMAIL_PASS` from the environment first, then falls back to common local `.env` files.

Request a fresh code to your phone and wait for an OTP posted into `./.latest-otp.json`:

```bash
node src/gettransfer.js login \
  --phone <your-phone> \
  --timeout 180
```

If you want to see the browser during login for debugging:

```bash
node src/gettransfer.js login \
  --phone <your-phone> \
  --timeout 180 \
  --headful
```

Run against a saved response:

```bash
node src/gettransfer.js extract \
  --input fixtures/sample-response.json \
  --format pretty
```

Run against the live endpoint:

```bash
node src/gettransfer.js fetch \
  --format csv \
  --output journeys.csv \
  --raw-output raw-response.json
```

If the saved cookie jar is rejected, the CLI will automatically fall back to the captured Playwright storage state in `./capture/storage-state.json` and make the request from a real Chromium context instead.

You can force that path explicitly:

```bash
node src/gettransfer.js fetch \
  --browser \
  --storage-state ./capture/storage-state.json \
  --format pretty
```

If you prefer to point at a specific captured session:

```bash
node src/gettransfer.js fetch \
  --session-file ./capture/session.json \
  --format json
```

The CLI now loads the newest saved session automatically from:

1. `./.gettransfer-session.json`
2. `./capture/session.json`

If neither exists, you can still pass `--cookie` or `--cookie-file` directly.

The CLI now defaults to this endpoint shape:

```text
https://gettransfer.com/api/transfers?page=1&role=carrier&filtering%5Bdate_since%5D=&filtering%5Bdate_till%5D=&filtering%5Boffers%5D=except_my&filtering%5Bpax_max%5D=4&filtering%5Bpax_min%5D=0&filtering%5Basap%5D=false&filtering%5Bhidden%5D=false&filtering%5Bsearch%5D=&sorting%5Bfield%5D=created_at&sorting%5Border_by%5D=desc
```

You can override the main filters directly:

```bash
node src/gettransfer.js fetch \
  --session-file ./capture/session.json \
  --page 2 \
  --offers except_my \
  --pax-max 6 \
  --search Aberdeen \
  --format pretty
```

## Finding the Right Request

1. Open the carrier requests page in your browser.
2. Open DevTools and go to the `Network` tab.
3. Filter by `fetch` or `xhr`.
4. Find the request to `/api/transfers` whose response body contains `data.transfers`.
5. Save the authenticated session.
   The Playwright capture helper already writes [session.json](/home/creamer/Downloads/claude/gettransfer/capture/session.json).
6. Save the matching browser storage state.
   The same capture helper writes [storage-state.json](/home/creamer/Downloads/claude/gettransfer/capture/storage-state.json).
7. Run `fetch` and let the CLI reuse that session automatically. If raw cookie replay fails, it can retry with the captured storage state in a browser context.

## Notes

- Cloudflare and session cookies expire, so live fetches may stop working until you refresh the saved session.
- If GetTransfer changes the `/api/transfers` query shape, you can still override the whole request with `--url`.
- The tool currently assumes the response is JSON. If GetTransfer changes the shape, update `extractTransfers()` and `normalizeJourney()` in [src/gettransfer.js](/home/creamer/Downloads/claude/gettransfer/src/gettransfer.js).
- The server does not serve arbitrary files, `.env` files, or raw OTP bodies. `/otp` only returns a redacted summary.
- State and OTP files are created with private permissions inside the container via `umask 077`.
- `/health` and `POST /otp` remain intentionally unauthenticated so the scheduler probe and Tasker delivery keep working.
- access-key deletion is guarded server-side so the last remaining key cannot be removed.
- For reverse-proxy deployment, make sure the proxy forwards the original host and protocol headers so WebAuthn can derive the correct relying party and secure cookie behavior.
- The current stack is pinned for Traefik at `https://gettransfer.summerhouse.dscloud.me`, so `WEBAUTHN_RP_ID` and `WEBAUTHN_ORIGIN` are set explicitly in the stack.

## Portainer

This repo now includes:

- [Dockerfile](/home/creamer/Downloads/claude/gettransfer/Dockerfile)
- [portainer-stack.yml](/home/creamer/Downloads/claude/gettransfer/portainer-stack.yml)

The container:

- runs the dashboard by default
- keeps state under `/data`
- includes headless Chromium for browser-assisted login/fetch
- listens internally on `8765/tcp`
- joins the external Docker network `traefik`
- is configured in the stack to bind-mount `/volume2/docker/gettransfer/data` from your Synology host

Portainer stack deployment:

1. Upload or clone this repo into Portainer.
2. Deploy [portainer-stack.yml](/home/creamer/Downloads/claude/gettransfer/portainer-stack.yml) as the stack file.

After the stack is up behind Traefik, the dashboard is expected at:

```text
https://gettransfer.summerhouse.dscloud.me/
```

Tasker can keep posting OTPs to the same container at:

```text
https://gettransfer.summerhouse.dscloud.me/otp
```

To run one-off commands in the container:

```bash
docker exec -it gettransfer /usr/local/bin/gettransfer-entrypoint.sh login --phone <your-phone> --timeout 180
docker exec -it gettransfer /usr/local/bin/gettransfer-entrypoint.sh fetch --format pretty
docker exec -it gettransfer /usr/local/bin/gettransfer-entrypoint.sh dashboard
```

Inside Portainer’s console, the equivalent commands are:

```bash
/usr/local/bin/gettransfer-entrypoint.sh login --phone <your-phone> --timeout 180
/usr/local/bin/gettransfer-entrypoint.sh fetch --format pretty
/usr/local/bin/gettransfer-entrypoint.sh dashboard
```
