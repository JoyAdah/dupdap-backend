# DupDub Backend

> Crypto-to-fiat settlement API — merchants accept USDC on Stellar, customers pay from a wallet, and the platform settles fiat to the merchant's bank account.

This is the backend service for the DupDub payment platform. It exposes a REST API (NestJS), watches the Stellar network for incoming payments, drives the payment/settlement lifecycle, and talks to the on-chain Soroban contracts that hold funds in escrow.

Related repos:
- [`dupdap-frontend`](../dupdap-frontend) — merchant dashboard & customer payment portal (Next.js)
- [`dupdapp_stellar`](../dupdapp_stellar) — the Soroban smart contracts (`payment_escrow`, `merchant_registry`, `settlement_ledger`, etc.) this service reads from and writes to

## Why Stellar

This service is built Stellar-native, not multi-chain:

- **Fast finality** — ~5 second ledger close times mean a customer payment can be confirmed and reflected in the merchant dashboard almost immediately, instead of waiting on multiple block confirmations.
- **Low, predictable fees** — base fees are fractions of a cent, which matters for a settlement platform that needs to be viable on small transactions.
- **Native asset issuance + SEP-41** — USDC on Stellar is a first-class asset, and SEP-41 gives a standard token-contract interface that Soroban can monitor for transfer events, rather than relying on custom ERC-20-style event parsing.
- **Soroban smart contracts for escrow** — the `payment_escrow` contract (see [`dupdapp_stellar`](../dupdapp_stellar)) holds customer funds until settlement conditions are met, giving the platform an on-chain, auditable escrow step instead of trusting a hot wallet alone.
- **Purpose-built for cross-border remittance** — Stellar's anchor/asset-issuance model was designed for moving value between fiat rails, which lines up with this platform's crypto-in, fiat-out settlement flow.

## Architecture

### How a payment flows through the system

```
Merchant creates payment request (POST /api/v1/payments)
        │
        ▼
Customer approves + deposits USDC into the payment_escrow
Soroban contract (via frontend + Stellar wallet)
        │
        ▼
StellarMonitorService polls Horizon (deposit address) every 30s
SorobanEventIndexerService watches Soroban RPC for contract events
        │
        ▼
Payment confirmed → dispatch `payment.confirmed` webhook
        │
        ▼
SettlementsService converts crypto → fiat via the partner
liquidity provider API, dispatches `payment.settling`
        │
        ▼
Partner settlement callback (POST /settlements/partner-callback)
        │
        ▼
`payment.settled` (or `payment.failed`) webhook dispatched,
merchant sees the settlement in the dashboard
```

### Module layout (`src/`)

| Module | Responsibility |
|---|---|
| `payments/`, `payment/` | Payment request lifecycle, QR codes, receipts, batch payments |
| `stellar/` | Horizon polling (`StellarMonitorService`), Soroban event indexing, `StellarService` (SDK wrapper, `invokeContract`) |
| `soroban/` | Lower-level Soroban RPC client used by wallet provisioning and contract calls |
| `blockchain-wallet/` | Server-side Stellar keypair provisioning per user (AES-256-GCM encrypted secret storage), balance sync, slippage handling |
| `settlements/` | Crypto→fiat settlement orchestration, partner callback handling |
| `merchants/` | Merchant profile, API key issuance/scoping, notification preferences |
| `webhooks/` | Webhook registration, signed delivery, retry/backoff, failure alerting |
| `waitlist/` | Public waitlist signup/lookup/stats |
| `auth/` | Registration/login, JWT + API key guards |
| `admin/` | Internal admin operations and reporting |
| `analytics/` | Merchant-facing and platform-wide analytics |
| `aml/` | Anti-money-laundering checks |
| `groups/` | Merchant grouping/org structures |
| `notifications/`, `email/` | Notification preferences and email delivery (SMTP/SendGrid) |
| `queues/`, `queue/`, `retry/` | Bull/Redis queue definitions and per-queue retry policies |
| `cache/` | Redis-backed caching (with in-memory fallback) |
| `cron/` | Scheduled jobs |
| `backup/` | Database backup to S3 |
| `audit/` | Audit logging for compliance |
| `security/` | Security-related guards/utilities |
| `prometheus/`, `sentry/`, `telemetry/` | Metrics export, error tracking, OpenTelemetry tracing |
| `health/` | Liveness/readiness endpoints |
| `common/`, `core/`, `config/`, `database/`, `runtime-config/` | Shared interceptors/filters, TypeORM setup + migrations, config loading |

### Data flow at a glance

Postgres (via TypeORM) is the system of record for payments, merchants, settlements, and webhooks. Redis backs both the cache layer and the Bull job queues (Stellar monitoring, webhook delivery, settlement retries, email). Stellar Horizon + Soroban RPC are the only blockchain dependencies — there is no EVM/ethers.js integration in this codebase today.

## Tech stack

- **Framework**: NestJS (TypeScript)
- **Database**: PostgreSQL + TypeORM (migration-based schema management)
- **Queues/Cache**: Redis via Bull (jobs) and `@nestjs/cache-manager`
- **Blockchain**: `@stellar/stellar-sdk` — Horizon for classic-asset payments, Soroban RPC for contract calls/events
- **Auth**: JWT (`@nestjs/jwt`/passport) and scoped API keys
- **API docs**: `@nestjs/swagger` (OpenAPI), served at `/docs`
- **Observability**: Prometheus metrics, Sentry error tracking, OpenTelemetry tracing, Winston structured logging
- **Email**: Nodemailer over SMTP or SendGrid

## Getting started

### Prerequisites

- Node.js 20+ and pnpm (CI uses pnpm 10; npm also works for local dev)
- PostgreSQL 16+
- Redis 6+

### Setup

```bash
# Install dependencies
pnpm install

# Set up environment variables
cp .env.example .env
# Edit .env with your configuration — see below

# Run database migrations
pnpm migration:run

# Start development server
pnpm start:dev

# Run tests
pnpm test
pnpm test:e2e
```

Once running, the API is at `http://localhost:3000/api/v1` and interactive API docs (Swagger UI) are at `http://localhost:3000/docs`.

### Useful scripts

| Script | Purpose |
|---|---|
| `pnpm migration:generate` / `migration:run` / `migration:revert` / `migration:show` | TypeORM migrations |
| `pnpm db:seed` / `db:seed:test` / `db:reset` | Local DB seeding/reset |
| `pnpm migration:check` / `migration:rollback:check` / `migration:uncommitted:check` | CI safety checks on migrations |
| `pnpm test:cov` | Unit tests with coverage |
| `pnpm test:integration` | Integration specs (`*.integration-spec.ts`) |
| `pnpm test:e2e` | End-to-end specs (`*.e2e-spec.ts`) |
| `pnpm explain:queries` | Run `EXPLAIN` on the list/query endpoints |

## Environment variables

Full list lives in [`.env.example`](.env.example); the categories below cover what each group is for.

#### Server & CORS
```bash
PORT=3000
API_PREFIX=api/v1
NODE_ENV=development
ALLOWED_ORIGINS=https://app.dupdub.xyz,https://dupdub.xyz   # comma-separated, production only
```

#### Database
```bash
DB_HOST=localhost
DB_PORT=5432
DB_USER=postgres
DB_PASSWORD=your_secure_password
DB_NAME=dupdub
DB_POOL_MIN=2
DB_POOL_MAX=20
DB_ACQUIRE_TIMEOUT_MS=10000
DB_IDLE_TIMEOUT_MS=60000
```

#### Auth
```bash
JWT_SECRET=your_jwt_secret_key_min_32_chars
JWT_EXPIRES_IN=7d
API_KEY_SALT=your_api_key_salt
```

#### Stellar / Soroban
```bash
STELLAR_NETWORK=TESTNET                 # or PUBLIC
STELLAR_ACCOUNT_SECRET=SXXX...          # platform deposit account
STELLAR_ACCOUNT_PUBLIC=GXXX...
STELLAR_USDC_ISSUER=GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5
STELLAR_HORIZON_URL=https://horizon-testnet.stellar.org

SOROBAN_RPC_URL=https://soroban-testnet.stellar.org
SOROBAN_SOURCE_PUBLIC_KEY=GXXX...
SOROBAN_SOURCE_SECRET=SXXX...
SOROBAN_NETWORK_PASSPHRASE=

SOROBAN_CONTRACT_ID=                    # payment_escrow contract, used by StellarService.invokeContract()
STELLAR_USDC_CONTRACT_ID=               # SEP-41 USDC contract; blank disables the Soroban fallback monitor
SOROBAN_ESCROW_CONTRACT_ID=             # written by dupdapp_stellar's payment_escrow deploy script
SOROBAN_ESCROW_CONTRACT_ID_TESTNET=
SOROBAN_ESCROW_CONTRACT_ID_MAINNET=

STELLAR_WALLET_ENCRYPTION_KEY=          # AES-256-GCM key used to encrypt per-user Stellar secret keys at rest
```

> After deploying/redeploying `payment_escrow` from the `dupdapp_stellar` repo, copy the contract ID it prints into `SOROBAN_ESCROW_CONTRACT_ID*` here.

#### Fiat settlement partner
```bash
PARTNER_API_URL=https://partner-api.example.com/v1
PARTNER_API_KEY=your_partner_api_key
PARTNER_WEBHOOK_SECRET=your_partner_webhook_secret
```

#### Webhooks (outbound, to merchants)
```bash
WEBHOOK_SECRET=your_webhook_signing_secret
WEBHOOK_RETRY_COUNT=5
WEBHOOK_RETRY_DELAYS_MS=60000,300000,1800000,7200000,43200000
```

#### Queues & retries (Bull/Redis)
```bash
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=

QUEUE_MAX_RETRIES=5
SETTLEMENT_RETRY_COUNT=3
SETTLEMENT_RETRY_DELAYS_MS=60000,300000,1800000
EMAIL_RETRY_COUNT=1
EMAIL_RETRY_DELAYS_MS=300000
STELLAR_MONITOR_RETRY_COUNT=1
STELLAR_MONITOR_RETRY_DELAYS_MS=0
```

#### Email
```bash
EMAIL_PROVIDER=smtp                     # smtp or sendgrid
EMAIL_SMTP_HOST=smtp.sendgrid.net
EMAIL_SMTP_PORT=587
EMAIL_SMTP_SECURE=false
EMAIL_SMTP_USER=apikey
EMAIL_SMTP_PASS=your_sendgrid_api_key_or_smtp_password
EMAIL_FROM=noreply@dupdub.xyz
EMAIL_FROM_NAME=DupDub
SENDGRID_API_KEY=
```

> Two email paths read different SMTP variables. `src/email/nodemailer.service.ts` uses the `EMAIL_SMTP_*` set above. The notifications queue (`src/notifications/email.processor.ts`, used by `NotificationsService.enqueueEmail` for AML alerts etc.) reads `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER` and `SMTP_PASS`; set these too or queued emails will not be delivered. Both read `EMAIL_FROM`.

#### Monitoring, alerting & observability
```bash
SENTRY_DSN=https://xxx@sentry.io/xxx

UPTIMEROBOT_API_KEY=
BETTER_UPTIME_API_TOKEN=
BETTER_UPTIME_HEARTBEAT_URL=https://betteruptime.com/api/v1/heartbeat/xxxxx

ADMIN_ALERT_SLACK_WEBHOOK_URL=https://hooks.slack.com/services/xxx/yyy/zzz
ADMIN_ALERT_EMAIL=oncall@dupdub.xyz
ADMIN_ALERT_COOLDOWN_MINUTES=30
ADMIN_ALERT_FAILURE_THRESHOLD=1
ADMIN_ALERT_STELLAR_FAILURE_THRESHOLD=1
GRAFANA_SLACK_WEBHOOK_URL=https://hooks.slack.com/services/xxx/yyy/zzz

OTEL_ENABLED=false
OTEL_SERVICE_NAME=dupdub-backend
OTEL_EXPORTER_OTLP_ENDPOINT=
OTEL_TRACE_CONSOLE=false
```

#### Admin & backups
```bash
ADMIN_ALLOWED_IPS=127.0.0.1,::1
ADMIN_IP_BYPASS_IN_DEV=true

BACKUP_S3_BUCKET=dupdub-db-backups
BACKUP_S3_REGION=us-east-1
BACKUP_S3_ENDPOINT=
BACKUP_S3_ACCESS_KEY_ID=your_access_key_id
BACKUP_S3_SECRET_ACCESS_KEY=your_secret_access_key
BACKUP_RETENTION_DAYS=30
```

## API documentation

- **Interactive docs**: `GET /docs` (Swagger UI), raw OpenAPI JSON at `GET /docs-json`
- **Base path**: all routes below are under `/api/v1` unless noted
- **Auth**: `Authorization: Bearer <JWT>` (from `/auth/login`) or `X-API-Key: <merchant API key>` — both schemes are wired up in Swagger's "Authorize" button

| Area | Endpoints |
|---|---|
| Auth | `POST /auth/register`, `POST /auth/login` |
| Payments | `POST /payments`, `POST /payments/batch`, `GET /payments`, `GET /payments/stats`, `GET /payments/:id`, `POST /payments/:id/refund`, `GET /pay/:reference` |
| Payments (QR/receipts) | `POST /payments`, `GET /payments/:id/status`, `GET /payments/:id/qr-code`, `POST /payments/:id/cancel`, `GET /payments/reference/:reference`, `GET /payments/:id/receipt` |
| Settlements | `GET /settlements`, `POST /settlements/partner-callback` (partner-facing) |
| Merchants | `GET /merchants/me`, `PATCH /merchants/me`, `POST /merchants/api-keys`, `GET`/`PATCH /merchants/me/notification-prefs` |
| Webhooks | `GET /webhooks`, `POST /webhooks`, `DELETE /webhooks/:id` |
| Wallet | `GET /wallet`, `GET /wallet/balance` |
| Waitlist | `POST /waitlist/join`, `GET /waitlist/check/:username`, `GET /waitlist/stats` |
| Health | `GET /health`, `GET /health/ready` (excluded from the `/api/v1` prefix) |

Treat Swagger (`/docs`) as the source of truth for request/response shapes — the table above is a map of what exists, not the full contract.

### Outbound webhooks

Merchants register a URL via `POST /webhooks`; deliveries are HMAC-signed with `WEBHOOK_SECRET` and retried on the schedule in `WEBHOOK_RETRY_DELAYS_MS`. Events currently dispatched:

- `payment.confirmed` — deposit detected and confirmed on Stellar
- `payment.expired` — payment request expired before a deposit arrived
- `payment.settling` — settlement to fiat has started
- `payment.settled` — merchant has received fiat
- `payment.failed` — settlement failed
- `payment.refunded` — a payment was refunded

## Testing

```bash
pnpm test          # unit tests
pnpm test:cov      # unit tests with coverage
pnpm test:e2e      # e2e specs (spins up against a real Postgres — see test/*.e2e-spec.ts)
pnpm test:integration
```

CI also runs migration safety/rollback checks, an uncommitted-migration check, and a raw-SQL-injection scan (`ci-sql-injection-check` equivalent) — see the workflows in this repo's CI config.

## Monitoring & ops

- Prometheus metrics + Grafana dashboards, Loki/Promtail log shipping — see the `dupdapp_stellar` repo's `grafana/` and `docker-compose.yml` for the local observability stack (backend log volume must be pointed at this repo's `logs/` directory if you wire that up locally).
- Uptime/status page config: see `monitoring/` in `dupdapp_stellar`.
- `AdminAlertService` pushes Slack/email alerts on repeated Stellar-monitor or settlement failures (`ADMIN_ALERT_*` env vars).

## Handsoff notes

<!-- handsoff-issue-340 -->
- #340: RuntimeConfigService.get() passes a raw number instead of {ttlSeconds} to CacheService.set, silently caching config for 24h instead of 60s
