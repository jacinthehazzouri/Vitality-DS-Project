"""Offline regression tests using real coordinator and peer logic with simulated HTTP.

Run from the project root with Python 3.10+:
    python scripts/test_blockchain_recovery.py

These tests use temporary chain files and never contact the running containers.
Third-party HTTP, framework and model boundaries are replaced by small test doubles.
"""

import ast
import asyncio
import json
import tempfile
import types
import unittest
import time
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from pathlib import Path
from urllib.parse import urlsplit


ROOT = Path(__file__).resolve().parents[1]


class TestHTTPException(Exception):
    def __init__(self, status_code, detail):
        super().__init__(detail)
        self.status_code = status_code


class TestModel:
    def __init__(self, **fields):
        self.fields = fields
        self.__dict__.update(fields)

    def model_dump(self):
        return deepcopy(self.fields)


class TestApp:
    def __init__(self, **kwargs):
        pass

    def get(self, path):
        return lambda function: function

    post = get


def load_logic(path):
    """Execute production functions while replacing only external dependencies."""
    tree = ast.parse(path.read_text(encoding='utf-8'), filename=str(path))
    external = {'fastapi', 'pydantic', 'httpx', 'aio_pika'}
    statements = []
    for node in tree.body:
        if isinstance(node, ast.Import):
            node.names = [name for name in node.names if name.name not in external]
            if not node.names:
                continue
        if isinstance(node, ast.ImportFrom) and node.module in external:
            continue
        statements.append(node)
    tree.body = statements
    namespace = {
        '__name__': 'offline_test_module', 'FastAPI': TestApp, 'Header': lambda **kwargs: None,
        'HTTPException': TestHTTPException, 'BaseModel': TestModel,
        'httpx': types.SimpleNamespace(), 'aio_pika': types.SimpleNamespace(),
    }
    exec(compile(tree, str(path), 'exec'), namespace)
    return types.SimpleNamespace(**namespace), namespace


class Response:
    def __init__(self, data, status=200):
        self.data = deepcopy(data)
        self.status_code = status

    def json(self):
        return deepcopy(self.data)

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f'Simulated HTTP {self.status_code}')


class Cluster:
    def __init__(self, directory):
        self.directory = directory
        self.down = set()
        self.reject_commit = set()
        self.lose_reply = set()
        self.peers = {}
        for number in range(1, 4):
            peer, namespace = load_logic(ROOT / f'backend/blockchain-nodes/peer-{number}/main.py')
            namespace['DATA'] = directory / f'peer-{number}.json'
            namespace['API_KEY'] = 'test-key'
            self.peers[f'peer-{number}'] = peer
        self.coordinator = self.restart_coordinator()

    def restart_coordinator(self):
        module, namespace = load_logic(ROOT / 'backend/blockchain-service/app/main.py')
        namespace.update(
            PEERS=[f'http://peer-{number}' for number in range(1, 4)],
            KEY='test-key', JOURNAL=self.directory / 'pending.json', processing_lock=asyncio.Lock(),
        )
        namespace['httpx'].AsyncClient = lambda: Client(self)
        self.coordinator = module
        return module

    def chains(self):
        return [peer.read_chain() for peer in self.peers.values()]


class Client:
    def __init__(self, cluster):
        self.cluster = cluster

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    async def get(self, url, **kwargs):
        host = urlsplit(url).hostname
        if host in self.cluster.down:
            raise ConnectionError('Simulated peer outage')
        peer = self.cluster.peers[host]
        return Response(peer.health() if url.endswith('/health') else peer.chain())

    async def post(self, url, json, **kwargs):
        host = urlsplit(url).hostname
        if host in self.cluster.down:
            raise ConnectionError('Simulated peer outage')
        peer = self.cluster.peers[host]
        key = kwargs['headers']['x-peer-api-key']
        try:
            if url.endswith('/sync'):
                return Response(peer.sync(TestModel(**json), key))
            if url.endswith('/validate'):
                return Response(peer.validate(TestModel(**json), key))
            if url.endswith('/commit'):
                if not (self.cluster.directory / 'pending.json').exists():
                    raise AssertionError('Commit was attempted without a persistent journal')
                if host in self.cluster.reject_commit:
                    raise ConnectionError('Simulated failure before saving block')
                result = peer.commit(TestModel(**json), key)
                if host in self.cluster.lose_reply:
                    raise ConnectionError('Block saved but response was lost')
                return Response(result)
        except TestHTTPException as error:
            return Response({'detail': str(error)}, error.status_code)
        raise AssertionError(f'Unexpected URL {url}')


class RecoveryTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='vitality-recovery-')
        self.directory = Path(self.temp.name)
        self.cluster = Cluster(self.directory)
        self.event = {'event_id': 'test-event-1', 'event_type': 'CLASS_CREATED', 'class_id': 'demo'}

    async def asyncTearDown(self):
        self.temp.cleanup()

    def assert_equal_chains(self, height):
        chains = self.cluster.chains()
        self.assertEqual([len(chain) - 1 for chain in chains], [height] * 3)
        self.assertEqual(chains[0], chains[1])
        self.assertEqual(chains[0], chains[2])
        for peer in self.cluster.peers.values():
            self.assertTrue(peer.valid_chain(peer.read_chain()))

    async def test_normal_commit_and_exact_duplicate(self):
        first = await self.cluster.coordinator.process_event(self.event)
        second = await self.cluster.coordinator.process_event(self.event)
        self.assertEqual(first['commits'], 3)
        self.assertTrue(second['duplicate'])
        self.assert_equal_chains(1)
        self.assertFalse((self.directory / 'pending.json').exists())

    async def test_partial_commit_resumes_after_coordinator_restart(self):
        self.cluster.reject_commit = {'peer-2', 'peer-3'}
        with self.assertRaisesRegex(RuntimeError, '1/3 commit confirmations'):
            await self.cluster.coordinator.process_event(self.event)
        self.assertEqual([len(chain) - 1 for chain in self.cluster.chains()], [1, 0, 0])
        saved = json.loads((self.directory / 'pending.json').read_text())['block']
        self.cluster.restart_coordinator()
        self.cluster.reject_commit.clear()
        result = await self.cluster.coordinator.process_event(self.event)
        self.assertTrue(result['recovered'])
        self.assertEqual(result['hash'], saved['hash'])
        self.assert_equal_chains(1)

    async def test_partial_commit_recovers_with_third_peer_still_offline(self):
        self.cluster.down = {'peer-3'}
        self.cluster.reject_commit = {'peer-2'}
        with self.assertRaisesRegex(RuntimeError, '1/3 commit confirmations'):
            await self.cluster.coordinator.process_event(self.event)
        self.cluster.restart_coordinator()
        self.cluster.reject_commit.clear()
        result = await self.cluster.coordinator.process_event(self.event)
        self.assertEqual(result['commits'], 2)
        self.assertEqual([len(chain) - 1 for chain in self.cluster.chains()], [1, 1, 0])
        self.cluster.down.clear()
        await self.cluster.coordinator.chain()
        self.assert_equal_chains(1)

    async def test_majority_saved_but_acknowledgements_lost(self):
        self.cluster.lose_reply = {'peer-2', 'peer-3'}
        with self.assertRaises(RuntimeError):
            await self.cluster.coordinator.process_event(self.event)
        self.assert_equal_chains(1)
        original_hash = self.cluster.chains()[0][-1]['hash']
        self.cluster.restart_coordinator()
        self.cluster.lose_reply.clear()
        result = await self.cluster.coordinator.process_event(self.event)
        self.assertEqual(result['hash'], original_hash)
        self.assert_equal_chains(1)

    async def test_different_incoming_event_first_finishes_pending_proposal(self):
        self.cluster.reject_commit = {'peer-2', 'peer-3'}
        with self.assertRaises(RuntimeError):
            await self.cluster.coordinator.process_event(self.event)
        self.cluster.reject_commit.clear()
        await self.cluster.coordinator.process_event({**self.event, 'event_id': 'test-event-2'})
        self.assert_equal_chains(2)
        duplicate = await self.cluster.coordinator.process_event(self.event)
        self.assertTrue(duplicate['duplicate'])

    async def test_quorum_loss_defers_then_recovers(self):
        self.cluster.down = {'peer-2', 'peer-3'}
        with self.assertRaisesRegex(RuntimeError, 'waiting for quorum'):
            await self.cluster.coordinator.process_event(self.event)
        self.assert_equal_chains(0)
        self.cluster.down.clear()
        await self.cluster.coordinator.process_event(self.event)
        self.assert_equal_chains(1)

    async def test_lagging_peer_gets_saved_parent_before_resuming(self):
        self.cluster.down = {'peer-3'}
        await self.cluster.coordinator.process_event(self.event)
        self.cluster.reject_commit = {'peer-2'}
        second = {**self.event, 'event_id': 'test-event-2'}
        with self.assertRaises(RuntimeError):
            await self.cluster.coordinator.process_event(second)
        self.cluster.restart_coordinator()
        self.cluster.down.clear()
        self.cluster.reject_commit.clear()
        await self.cluster.coordinator.process_event(second)
        self.assert_equal_chains(2)

    async def test_conflicting_payload_does_not_extend_history(self):
        await self.cluster.coordinator.process_event(self.event)
        with self.assertRaisesRegex(ValueError, 'different payload'):
            await self.cluster.coordinator.process_event({**self.event, 'class_id': 'different'})
        self.assert_equal_chains(1)

    async def test_corrupt_journal_stops_recovery(self):
        (self.directory / 'pending.json').write_text('{"base_chain":[],"block":{}}')
        with self.assertRaisesRegex(RuntimeError, 'Pending proposal is invalid'):
            await self.cluster.coordinator.process_event(self.event)
        self.assert_equal_chains(0)

    async def test_peer_serializes_competing_writes(self):
        peer = self.cluster.peers['peer-1']
        original_read = peer.read_chain
        genesis = original_read()

        def delayed_read():
            chain = original_read()
            time.sleep(0.03)
            return chain

        peer.commit.__wrapped__.__globals__['read_chain'] = delayed_read
        blocks = []
        for event_id in ['competing-a', 'competing-b']:
            fields = {'index': 1, 'timestamp': '2026-11-23T00:00:00+00:00',
                      'event_id': event_id, 'event_type': 'CLASS_CREATED',
                      'payload': {'event_id': event_id}, 'previous_hash': genesis[-1]['hash']}
            blocks.append({**fields, 'hash': peer.digest(fields)})

        def submit(block):
            try:
                return peer.commit(TestModel(**block), 'test-key')['committed']
            except TestHTTPException as error:
                return error.status_code

        try:
            with ThreadPoolExecutor(max_workers=2) as executor:
                replies = list(executor.map(submit, blocks))
        finally:
            peer.commit.__wrapped__.__globals__['read_chain'] = original_read
        self.assertEqual(replies.count(True), 1)
        self.assertEqual(replies.count(409), 1)
        self.assertEqual(len(original_read()), 2)


if __name__ == '__main__':
    unittest.main(verbosity=2)
