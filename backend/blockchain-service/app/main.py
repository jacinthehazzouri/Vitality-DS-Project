import asyncio
import hashlib
import json
import logging
import os
import tempfile
from contextlib import asynccontextmanager, suppress
from datetime import datetime, timezone
from pathlib import Path

import aio_pika
import httpx
from fastapi import FastAPI, HTTPException


PEERS = [url.strip().rstrip('/') for url in os.getenv(
    'PEER_URLS', 'http://localhost:8101,http://localhost:8102,http://localhost:8103'
).split(',') if url.strip()]
if len(PEERS) != 3 or len(set(PEERS)) != 3:
    raise ValueError('Configure exactly three different peer URLs')

KEY = os.getenv('PEER_API_KEY', os.getenv('INTERNAL_API_KEY', ''))
RABBIT = os.getenv('RABBITMQ_URL', 'amqp://guest:guest@localhost:5672/')
QUEUE = 'vitality.audit.events'
JOURNAL = Path(os.getenv('PENDING_FILE', '/data/pending.json'))
QUORUM = 2
processing_lock = asyncio.Lock()
logger = logging.getLogger('uvicorn.error')
state = {
    'status': 'starting', 'last_event': None, 'last_error': None,
    'committed': 0, 'pending': int(JOURNAL.exists()), 'pending_event_id': None,
}


def sha(fields):
    encoded = json.dumps(fields, sort_keys=True, separators=(',', ':'), ensure_ascii=False)
    return hashlib.sha256(encoded.encode('utf-8')).hexdigest()


def headers():
    return {'x-peer-api-key': KEY}


def valid_history(blocks):
    if not isinstance(blocks, list) or not blocks:
        return False
    seen = set()
    for index, block in enumerate(blocks):
        if not isinstance(block, dict):
            return False
        event_id = block.get('event_id')
        if not isinstance(event_id, str) or not event_id or event_id in seen:
            return False
        seen.add(event_id)
        previous = '0' * 64 if index == 0 else blocks[index - 1]['hash']
        fields = {key: value for key, value in block.items() if key != 'hash'}
        if block.get('index') != index or block.get('previous_hash') != previous:
            return False
        if sha(fields) != block.get('hash'):
            return False
    return True


def load_pending():
    if not JOURNAL.exists():
        state.update(pending=0, pending_event_id=None)
        return None
    proposal = json.loads(JOURNAL.read_text(encoding='utf-8'))
    base = proposal.get('base_chain')
    block = proposal.get('block')
    if not valid_history(base) or not isinstance(block, dict) or not valid_history(base + [block]):
        raise RuntimeError('Pending proposal is invalid; inspect the coordinator journal before recovery')
    if not isinstance(block.get('payload'), dict) or block['payload'].get('event_id') != block['event_id']:
        raise RuntimeError('Pending proposal payload does not match its event ID')
    state.update(pending=1, pending_event_id=block['event_id'])
    return proposal


def save_pending(base_chain, block):
    # Persist the exact timestamp, hash and parent history before sending any commit.
    JOURNAL.parent.mkdir(parents=True, exist_ok=True)
    descriptor, filename = tempfile.mkstemp(dir=JOURNAL.parent, prefix='pending-')
    try:
        with os.fdopen(descriptor, 'w', encoding='utf-8') as stream:
            json.dump({'base_chain': base_chain, 'block': block}, stream, ensure_ascii=False)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(filename, JOURNAL)
    finally:
        if os.path.exists(filename):
            os.unlink(filename)
    state.update(pending=1, pending_event_id=block['event_id'])


async def request_chain(client, url):
    response = await client.get(url + '/chain', headers=headers(), timeout=3)
    response.raise_for_status()
    data = response.json()
    blocks = data.get('blocks')
    if not data.get('valid') or not valid_history(blocks):
        raise ValueError(f'{url} has an invalid chain')
    return blocks


async def available_chains(client):
    results = await asyncio.gather(
        *(request_chain(client, peer) for peer in PEERS), return_exceptions=True
    )
    return [(peer, chain) for peer, chain in zip(PEERS, results) if not isinstance(chain, Exception)]


async def sync_prefix(client, peer, local_chain, target):
    if len(local_chain) < len(target) and target[:len(local_chain)] == local_chain:
        response = await client.post(peer + '/sync', headers=headers(), json={'blocks': target}, timeout=5)
        response.raise_for_status()


async def canonical_chain(client):
    available = await available_chains(client)
    groups = {}
    for peer, chain in available:
        groups.setdefault((len(chain), chain[-1]['hash']), []).append((peer, chain))
    majority = [group for group in groups.values() if len(group) >= QUORUM]
    if not majority:
        raise RuntimeError('No matching chain held by two peers; waiting for quorum')
    chosen = max(majority, key=lambda group: len(group[0][1]))[0][1]
    for peer, chain in available:
        try:
            await sync_prefix(client, peer, chain, chosen)
        except Exception as error:
            logger.warning('Peer catch-up delayed for %s: %s', peer, error)
    return chosen


async def commit_pending(client, proposal):
    block = proposal['block']
    base = proposal['base_chain']
    # Resume before seeking a majority tip: a partially saved proposal can split the tips.
    for peer, chain in await available_chains(client):
        try:
            await sync_prefix(client, peer, chain, base)
        except Exception as error:
            logger.warning('Parent history synchronization delayed for %s: %s', peer, error)

    votes = await asyncio.gather(*(
        client.post(peer + '/validate', headers=headers(), json=block, timeout=4) for peer in PEERS
    ), return_exceptions=True)
    approved = [peer for peer, vote in zip(PEERS, votes)
                if not isinstance(vote, Exception) and vote.status_code == 200
                and vote.json().get('approved')]
    if len(approved) < QUORUM:
        raise RuntimeError(f'Event {block["event_id"]}: {len(approved)}/3 approvals; proposal retained for retry')

    replies = await asyncio.gather(*(
        client.post(peer + '/commit', headers=headers(), json=block, timeout=4) for peer in approved
    ), return_exceptions=True)
    committed = [peer for peer, reply in zip(approved, replies)
                 if not isinstance(reply, Exception) and reply.status_code == 200
                 and reply.json().get('committed')]
    if len(committed) < QUORUM:
        raise RuntimeError(f'Event {block["event_id"]}: {len(committed)}/3 commit confirmations; exact proposal retained for retry')

    chain = await canonical_chain(client)
    if len(chain) <= block['index'] or chain[block['index']] != block:
        raise RuntimeError('Committed proposal is not present in the majority history')
    JOURNAL.unlink()
    state.update(pending=0, pending_event_id=None)
    result = {
        'event_id': block['event_id'], 'block_index': block['index'], 'hash': block['hash'],
        'approvals': len(approved), 'commits': len(committed),
    }
    logger.info('Audit committed event=%s block=%s commits=%s', block['event_id'], block['index'], len(committed))
    return result


async def process_event(event):
    if not isinstance(event, dict) or not isinstance(event.get('event_id'), str) or not event['event_id']:
        raise ValueError('Event must contain a nonempty string event_id')
    async with processing_lock:
        async with httpx.AsyncClient() as client:
            pending = load_pending()
            if pending:
                result = await commit_pending(client, pending)
                if pending['block']['event_id'] == event['event_id']:
                    if pending['block']['payload'] != event:
                        raise ValueError('Event ID reused with a different payload')
                    return {**result, 'recovered': True}

            chain = await canonical_chain(client)
            existing = next((block for block in chain if block.get('event_id') == event['event_id']), None)
            if existing:
                if existing['payload'] != event:
                    raise ValueError('Event ID reused with a different payload')
                return {'duplicate': True, 'event_id': event['event_id'], 'block_index': existing['index']}

            fields = {
                'index': len(chain), 'timestamp': datetime.now(timezone.utc).isoformat(),
                'event_id': event['event_id'], 'event_type': event.get('event_type', 'UNKNOWN'),
                'payload': event, 'previous_hash': chain[-1]['hash'],
            }
            block = {**fields, 'hash': sha(fields)}
            save_pending(chain, block)
            return await commit_pending(client, {'base_chain': chain, 'block': block})


async def consume():
    while True:
        try:
            connection = await aio_pika.connect_robust(RABBIT)
            async with connection:
                channel = await connection.channel()
                await channel.set_qos(prefetch_count=1)
                queue = await channel.declare_queue(QUEUE, durable=True)
                state['status'] = 'connected'
                async with queue.iterator() as iterator:
                    async for message in iterator:
                        async with message.process(requeue=True):
                            result = await process_event(json.loads(message.body))
                            state.update(last_event=result, last_error=None)
                            state['committed'] += 0 if result.get('duplicate') else 1
        except Exception as error:
            state.update(status='retrying', last_error=str(error))
            logger.warning('Audit processing will retry: %s', error)
            await asyncio.sleep(3)


@asynccontextmanager
async def lifespan(app):
    load_pending()
    task = asyncio.create_task(consume())
    try:
        yield
    finally:
        task.cancel()
        with suppress(asyncio.CancelledError):
            await task


app = FastAPI(title='Vitality Blockchain Audit Service', lifespan=lifespan)


@app.get('/health')
async def health():
    return {'service': 'blockchain-audit', 'status': state['status'], 'last_error': state['last_error']}


@app.get('/status')
async def status():
    async with httpx.AsyncClient() as client:
        results = await asyncio.gather(*(
            client.get(peer + '/health', headers=headers(), timeout=2) for peer in PEERS
        ), return_exceptions=True)
    peers = []
    for peer, response in zip(PEERS, results):
        if isinstance(response, Exception) or response.status_code != 200:
            peers.append({'url': peer, 'status': 'unavailable'})
        else:
            peers.append({'url': peer, **response.json()})
    return {'coordinator': state, 'peers': peers}


@app.get('/chain')
async def chain():
    async with processing_lock:
        async with httpx.AsyncClient() as client:
            try:
                blocks = await canonical_chain(client)
            except (RuntimeError, ValueError) as error:
                raise HTTPException(status_code=503, detail=str(error)) from error
    return {'height': len(blocks) - 1, 'blocks': blocks, 'valid': True}
