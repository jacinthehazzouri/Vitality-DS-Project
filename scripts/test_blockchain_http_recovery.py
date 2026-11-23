"""Exercise partial-commit recovery over real HTTP using isolated peer processes.

Install the packages in backend/blockchain-service/requirements.txt first.
Run with Python 3.10+ from the project root. Existing chains and RabbitMQ are untouched.
"""

import asyncio
import importlib.util
import json
import os
import socket
import subprocess
import sys
import tempfile
import types
from pathlib import Path

import httpx


ROOT = Path(__file__).resolve().parents[1]


def load_coordinator():
    spec = importlib.util.spec_from_file_location('isolated_coordinator', ROOT / 'backend/blockchain-service/app/main.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def unused_port():
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        return listener.getsockname()[1]


async def main():
    results = {'kind': 'isolated_real_http_recovery', 'checks': []}
    processes = []
    temporary = tempfile.TemporaryDirectory(prefix='vitality-http-recovery-')
    directory = Path(temporary.name)
    ports = []
    while len(ports) < 3:
        port = unused_port()
        if port not in ports:
            ports.append(port)
    urls = [f'http://127.0.0.1:{port}' for port in ports]
    os.environ['PEER_URLS'] = ','.join(urls)
    os.environ['PENDING_FILE'] = str(directory / 'pending.json')
    os.environ['PEER_API_KEY'] = 'isolated-test-key'

    def start_peer(number):
        environment = os.environ.copy()
        environment.update(PEER_ID=f'isolated-peer-{number + 1}', DATA_FILE=str(directory / f'peer-{number + 1}.json'))
        log = open(directory / f'peer-{number + 1}.log', 'ab')
        try:
            process = subprocess.Popen([
                sys.executable, '-m', 'uvicorn', 'main:app', '--host', '127.0.0.1',
                '--port', str(ports[number]), '--log-level', 'warning',
            ], cwd=ROOT / f'backend/blockchain-nodes/peer-{number + 1}', env=environment,
                stdout=log, stderr=log, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        finally:
            log.close()
        processes.append(process)
        return process

    async def ready(number):
        async with httpx.AsyncClient() as client:
            for _ in range(100):
                try:
                    response = await client.get(urls[number] + '/health', timeout=1)
                    if response.status_code == 200:
                        return
                except httpx.HTTPError:
                    pass
                await asyncio.sleep(0.1)
        raise RuntimeError(f'Isolated peer {number + 1} did not start')

    def passed(name, **details):
        results['checks'].append({'name': name, 'passed': True, **details})
        print('PASS', name, json.dumps(details), flush=True)

    reject_second_commit = True

    class FailureTransport(httpx.AsyncBaseTransport):
        def __init__(self):
            self.delegate = httpx.AsyncHTTPTransport()

        async def handle_async_request(self, request):
            if reject_second_commit and request.url.port == ports[1] and request.url.path == '/commit':
                return httpx.Response(503, json={'detail': 'Deliberately interrupted commit'}, request=request)
            return await self.delegate.handle_async_request(request)

        async def aclose(self):
            await self.delegate.aclose()

    def wire(module):
        module.httpx = types.SimpleNamespace(AsyncClient=lambda: httpx.AsyncClient(transport=FailureTransport()))

    try:
        peers = [start_peer(number) for number in range(3)]
        await asyncio.gather(*(ready(number) for number in range(3)))
        coordinator = load_coordinator()
        wire(coordinator)
        peers[2].terminate()
        await asyncio.to_thread(peers[2].wait, 10)
        event = {'event_id': 'isolated-partial-commit-demo', 'event_type': 'CLASS_CREATED', 'class_id': 'isolated-only'}
        try:
            await coordinator.process_event(event)
            raise AssertionError('The injected partial commit unexpectedly succeeded')
        except RuntimeError as error:
            assert '1/3 commit confirmations' in str(error), str(error)
        saved = json.loads((directory / 'pending.json').read_text(encoding='utf-8'))['block']
        async with httpx.AsyncClient() as client:
            before = [(await client.get(urls[number] + '/health')).json()['height'] for number in [0, 1]]
        assert before == [1, 0], before
        passed('One peer saved the block and one did not; proposal persisted', heights=before, hash=saved['hash'])

        # A fresh module has no memory of the prior attempt and must use the journal.
        coordinator = load_coordinator()
        wire(coordinator)
        reject_second_commit = False
        result = await coordinator.process_event(event)
        assert result['recovered'] and result['hash'] == saved['hash'] and result['commits'] == 2, result
        passed('Fresh coordinator recovered the same proposal with third peer offline', hash=result['hash'], commits=result['commits'])

        start_peer(2)
        await ready(2)
        chain = await coordinator.chain()
        async with httpx.AsyncClient() as client:
            status = [(await client.get(url + '/health')).json() for url in urls]
        assert len({item['latest_hash'] for item in status}) == 1
        assert all(item['height'] == 1 and item['valid'] for item in status)
        passed('Restored peer caught up over HTTP', heights=[item['height'] for item in status])
        duplicate = await coordinator.process_event(event)
        assert duplicate['duplicate'] and (await coordinator.chain())['height'] == chain['height']
        passed('Duplicate delivery did not add a block', height=chain['height'])
    finally:
        for process in processes:
            if process.poll() is None:
                process.terminate()
                try:
                    await asyncio.to_thread(process.wait, 10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
        target = Path(os.getenv('VITALITY_HTTP_RESULTS', str(ROOT / 'verification-results/http-recovery.json')))
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(results, indent=2), encoding='utf-8')
        temporary.cleanup()
        print('Evidence saved:', target, flush=True)


if __name__ == '__main__':
    asyncio.run(main())
