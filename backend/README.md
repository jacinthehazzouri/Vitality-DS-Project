# Vitality backend

## Architecture
- Node.js/Express API Gateway, Member Service and Booking Service.
- PostgreSQL is reused from the existing Docker Desktop container; Compose does NOT create or delete a PostgreSQL container.
- RabbitMQ transports durable audit events from the transactional outbox.
- Python/FastAPI blockchain coordinator consumes events and coordinates three independent peers.
- Each peer has a separate Docker volume containing its chain.

## 1. Inspect the existing PostgreSQL container
In PowerShell:

```powershell
docker ps -a
docker inspect postgres --format '{{range .Config.Env}}{{println .}}{{end}}'
```

If the container name is not `postgres`, replace it in the commands. Start it in Docker Desktop first (the play icon means stopped). Record `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, and confirm the host port mapping is `5432:5432`.

## 2. Create the two Vitality databases and tables
From the repository root, run:

```powershell
.\scripts\create-vitality-databases.ps1 -Container postgres -AdminUser YOUR_POSTGRES_USER -AdminDatabase YOUR_POSTGRES_DB
```

The script uses `docker exec` and does not remove, recreate, or reset your existing PostgreSQL container or data.

## 3. Configure secrets and database URLs
Copy `backend/.env.example` to `backend/.env`. Set the two PostgreSQL URLs using the credentials inspected above. Also set `RABBITMQ_PASSWORD`, `RABBITMQ_DEFAULT_PASS`, and `RABBITMQ_URL` consistently to the same broker password:

```env
MEMBER_DATABASE_URL=postgresql://USER:PASSWORD@host.docker.internal:5432/vitality_members
BOOKING_DATABASE_URL=postgresql://USER:PASSWORD@host.docker.internal:5432/vitality_bookings
```

URL-encode special characters in the password (for example `@` becomes `%40`). Set distinct random values for `JWT_SECRET`, `INTERNAL_API_KEY`, and `RABBITMQ_PASSWORD`. Do not commit `.env`.

`host.docker.internal` lets Docker Desktop containers reach the PostgreSQL port published on the Windows host. If the connection is refused, check that PostgreSQL is running and its container publishes `5432:5432`.

## 4. Start the system
From the repository root:

```powershell
docker compose up --build -d
```

Check:

```powershell
docker compose ps
docker compose logs -f member-service booking-service blockchain-service
```

Health endpoints:
- Gateway: http://localhost:4000/health
- Member: http://localhost:4001/health
- Booking: http://localhost:4002/health
- Blockchain coordinator: http://localhost:8100/health
- Blockchain status: http://localhost:8100/status
- Peer 1: http://localhost:8101/health
- Peer 2: http://localhost:8102/health
- Peer 3: http://localhost:8103/health
- RabbitMQ UI: http://localhost:15672

## 5. Create an administrator
Set `ADMIN_EMAIL`, `ADMIN_PASSWORD` (at least 12 characters), `ADMIN_NAME`, and `MEMBER_DATABASE_URL` in your PowerShell session, then run:

```powershell
cd backend/member-service
npm install
$env:ADMIN_EMAIL='admin@example.com'
$env:ADMIN_PASSWORD='Use-A-Long-Unique-Password'
$env:MEMBER_DATABASE_URL='postgresql://USER:PASSWORD@localhost:5432/vitality_members'
npm run create-admin
```

Alternatively, execute the helper inside the running container after setting those variables using your preferred secure method.

## 6. Test API flow
Register a member:

```http
POST http://localhost:4000/api/auth/register
Content-Type: application/json
{"fullName":"Test Member","email":"member@example.com","password":"MemberPass123!"}
```

Login:

```http
POST http://localhost:4000/api/auth/login
Content-Type: application/json
{"email":"member@example.com","password":"MemberPass123!"}
```

Use the returned token as `Authorization: Bearer TOKEN` for protected endpoints. An admin token can create memberships, classes and sessions. See the API route source for request fields.

## Important notes
- This is an academic MVP, not production-hardened software.
- The coordinator is a single event-ordering coordinator. Peer validation uses a 2-of-3 educational quorum; it is not PBFT/Raft and does not provide Byzantine fault tolerance.
- Without quorum, audit processing waits and RabbitMQ messages are retried. A persistent coordinator journal resumes partial commits using the same proposal. See docs/architecture.md for recovery assumptions.
- The React frontend runs on localhost:5173. It includes registration, login, a live schedule, member bookings, and an admin panel at /admin. Both databases have transactional outboxes and separate workers.
- Do not run `docker compose down -v` if you want to preserve blockchain peer volumes. It does not remove the separately managed PostgreSQL container, but it would delete Compose-managed peer data volumes.
