# Vitality Distributed Gym Management System

Vitality includes a React frontend, an administrator panel, independent member and booking services, RabbitMQ audit delivery, and a custom three-peer blockchain audit service.

## Prerequisites

- Docker Desktop running Linux containers.
- An existing PostgreSQL container with port 5432 published.
- Node.js 20 or later for the frontend.
- PostgreSQL credentials and database administrator access for initialization.

Compose reuses the existing PostgreSQL instance through host.docker.internal. It does not create or reset that container.

## Start the project

Open PowerShell in the directory containing docker-compose.yml. Create backend/.env from backend/.env.example if needed. Set the two PostgreSQL URLs, consistent RabbitMQ credentials, a JWT secret, an internal API key, and separate administrator credentials. Keep the actual .env private.

Apply the schemas to an existing PostgreSQL container named postgres using its administrator account. Substitute your container and account names if different.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\scripts\create-vitality-databases.ps1" -Container postgres -AdminUser postgres -AdminDatabase postgres
docker compose up --build -d
docker compose ps -a
docker compose run --rm --no-deps member-service npm run create-admin
```

The administrator helper creates a new account or promotes an existing account. For an existing email, it preserves the existing password.

Start the frontend in a second terminal.

```powershell
cd frontend
npm ci
npm run dev
```

Open http://localhost:5173. Sign in with the configured admin account and open /admin. Create a test member, grant a membership, create a class and schedule a future session. In a separate browser session, sign in as the member to book it.

## Service endpoints

| Address | Purpose |
| --- | --- |
| http://localhost:5173 | Member frontend and /admin |
| http://localhost:4000/health | Gateway liveness |
| http://localhost:4001/health | Member Service database health |
| http://localhost:4002/health | Booking Service database health |
| http://localhost:15672 | RabbitMQ dashboard |
| http://localhost:8100/status | Coordinator and peer status |
| http://localhost:8100/chain | Majority ledger and peer catch-up |

RabbitMQ uses the credentials in backend/.env. Its audit queue is vitality.audit.events. Ready counts waiting messages, Unacked counts delivered messages awaiting acknowledgement, and Total is their sum.

## Tests and evidence

- scripts/Test-VitalityConcurrency.ps1 submits two eligible members' requests for the last seat. It creates a real reservation.
- scripts/test_blockchain_recovery.py runs isolated logic regressions.
- scripts/test_blockchain_http_recovery.py exercises real HTTP with isolated peer processes.
- scripts/verify-project.mjs runs API acceptance tests and small load batches against the live system.
- scripts/benchmark-audit.mjs runs a controlled database audit versus blockchain-outbox transaction comparison.
- verification-results contains sanitized results from the completed verification.

See docs/architecture.md for responsibilities, failure behavior and limitations. See backend/README.md for database configuration details.

## Submission and persistence

Submit the source, dependency manifests and lockfiles, SQL schemas, Dockerfiles, Compose file, example environment configuration, startup instructions, and test evidence. Exclude actual .env files, node_modules, build output, caches and private credentials.

Operational records are stored in PostgreSQL. Peer histories and the coordinator journal use separate Docker volumes. Preserve those volumes when restarting the demo. Do not use docker compose down -v when you need the recorded ledger.
