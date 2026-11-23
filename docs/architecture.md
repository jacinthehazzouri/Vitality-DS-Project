# Vitality architecture

Vitality separates membership management, reservations and audit processing into networked services. The current deployment runs these containers on one laptop. Separate containers demonstrate process and network boundaries, while the host remains a shared failure domain.

## Components and data ownership

| Component | Responsibility |
| --- | --- |
| React frontend on 5173 | Member pages and the administrator panel |
| API Gateway on 4000 | Routes browser requests to the business services and audit service |
| Member Service on 4001 | Accounts, memberships and the member outbox in vitality_members |
| Booking Service on 4002 | Classes, sessions, reservations and the booking outbox in vitality_bookings |
| Two outbox workers | Publish their database's pending events to vitality.audit.events |
| RabbitMQ | Durable queue and persistent messages between workers and the coordinator |
| Blockchain coordinator on 8100 | Orders consumed events, journals proposals, and coordinates peer commits |
| Three peers on 8101 through 8103 | Validate hash-linked blocks and keep separate chain files in Docker volumes |

The two application databases currently share one PostgreSQL container, managed separately from this Compose project. Booking member IDs are application references across databases. Membership checks go through the Member Service API.

## Booking sequence

1. The browser calls the gateway with a member token and session ID.
2. The Booking Service asks the Member Service whether the membership is active, with a bounded timeout.
3. The booking transaction locks the session row, checks capacity and duplicate reservations, then saves the booking and outbox event together.
4. The member receives booking confirmation with an event ID and pending audit status.
5. The worker publishes the saved event as a persistent RabbitMQ message and waits for publisher confirmation before marking it published.
6. The coordinator proposes a block and requires two validation approvals and two commit confirmations.
7. The coordinator acknowledges the RabbitMQ message after successful processing.

Bookings are operationally confirmed before blockchain finalization. This trades immediate audit finality for availability during a temporary audit outage.

## Blockchain protocol

This is a custom permissioned audit blockchain with a single trusted coordinator and a two-of-three educational quorum. SHA-256 hashes link block contents to their preceding block. The genesis record is fixed across peers.

The coordinator writes the exact proposal and its parent chain to a persistent journal before sending commit requests. If a partial commit or lost reply occurs, retry resumes the same timestamp and hash. A returning peer accepts a valid history only when it extends its local prefix. Each peer serializes commit and synchronization writes.

Exact duplicate events are detected by event ID and payload. An existing ID with different contents is rejected. The coordinator defines ledger order by processing messages sequentially. That order can differ from original business transaction order, especially across the two source databases.

## Failures and boundaries

- A broker outage leaves events in PostgreSQL until the workers can publish.
- A coordinator outage leaves messages awaiting processing in RabbitMQ.
- One unavailable peer permits progress if the other two agree.
- Without quorum, auditing waits. Business writes can continue with pending audit records.
- The journal is required to recover a proposal interrupted under the new protocol. Losing its volume, conflicting existing histories, or a corrupt peer chain can require manual investigation.
- The system assumes trusted application services, a single active coordinator and one server process per peer. It does not implement Raft, leader election or Byzantine fault tolerance.
- Hash validation detects inconsistent edits. A party controlling all peers and their storage could rewrite histories.
- The RabbitMQ outage demo uses stop/start on the same broker container. Broker data storage is currently not an explicitly named Compose volume, so it does not establish recovery after deliberate broker storage removal.
- Membership validation and booking commit are separate service operations. This is not a distributed transaction covering concurrent membership revocation.
- The full chain is retrieved and scanned for event lookups. The current design targets an academic demonstration rather than large-scale throughput.

## Verification

Run commands from the project root. The regression and real-HTTP recovery tests use isolated chain files. The acceptance and performance scripts create clearly named verification data in the running application.

```powershell
docker run --rm --network none -v "${PWD}:/project:ro" -w /project python:3.12-slim python scripts/test_blockchain_recovery.py
```

For the real-HTTP recovery test, install the Python requirements in an isolated environment, then run scripts/test_blockchain_http_recovery.py. It starts three temporary peer processes, injects a failed commit, reloads the coordinator, and verifies catch-up and deduplication. It never connects to the live audit queue.

For API acceptance and load tests, install the existing backend workspace dependencies with npm install --prefix backend, then run node scripts/verify-project.mjs. It reads credentials from backend/.env without saving them in results. Results default to verification-results. Set VITALITY_SKIP_LOAD=1 for acceptance checks only. The standalone scripts/benchmark-audit.mjs compares the same booking SQL using a logged database audit table and a blockchain outbox.

Measurements are small local experiments. They do not establish multi-host horizontal scalability or production performance.
