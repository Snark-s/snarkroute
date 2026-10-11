"""Exercise a real MCP tool after transport restart using an obsolete session ID."""
import argparse
import asyncio
from contextlib import asynccontextmanager
import importlib.util
import json
from pathlib import Path
import sys

import httpx
from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client

sys.path.insert(0, str(Path(__file__).parent))
from stack_paths import home

bridge_root = home('snarkbridge')
sys.path.insert(0, str(bridge_root))
spec = importlib.util.spec_from_file_location('audited_bridge_server', bridge_root / 'server.py')
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)


def result_payload(response):
    assert response.status_code == 200, (response.status_code, response.text)
    if response.headers['content-type'].startswith('text/event-stream'):
        payload = json.loads(next(line[6:] for line in response.text.splitlines()
                                  if line.startswith('data: ')))
    else:
        payload = response.json()
    return payload['result']


@asynccontextmanager
async def probe_client(live):
    app = server.mcp.streamable_http_app()
    if live:
        async with httpx.AsyncClient(base_url=f'http://127.0.0.1:{server.PORT}',
                                     timeout=15) as client:
            yield client
        return
    # The ASGI app uses the real installed MCP implementation; no sockets or models.
    async with server.mcp.session_manager.run():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                                    base_url=f'http://127.0.0.1:{server.PORT}') as client:
            yield client


async def main(live=False):
    async with probe_client(live) as client:
        headers = {
                'Accept': 'application/json, text/event-stream',
                'Mcp-Protocol-Version': '2025-03-26',
                'Mcp-Session-Id': 'obsolete-session-from-before-restart',
        }
        call = {'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call',
                'params': {'name': 'bridge_status', 'arguments': {}}}
        result = result_payload(await client.post('/mcp', headers=headers, json=call))
        assert not result.get('isError'), result
        status = json.loads(result['content'][0]['text'])
        assert status['status'] == 'ok' and status['version'] == '0.4.1', status

        host = await client.post('/mcp', headers={**headers, 'Host': 'untrusted.invalid'}, json=call)
        assert host.status_code == 421, (host.status_code, host.text)
        origin = await client.post('/mcp', headers={**headers, 'Origin': 'https://untrusted.invalid'}, json=call)
        assert origin.status_code == 403, (origin.status_code, origin.text)
        oversized = await client.post('/mcp', headers={**headers, 'Content-Type': 'application/json'},
                                      content=b' ' * (1_048_576 + 1))
        assert oversized.status_code == 413, (oversized.status_code, oversized.text)
        protected_paths = []
        for path, expected in [('../../', 'Outside SnarkBridge workspace'), ('.env', 'Protected path')]:
            blocked = result_payload(await client.post('/mcp', headers=headers, json={
                **call, 'params': {'name': 'read_text', 'arguments': {'path': path}}}))
            assert blocked.get('isError'), blocked
            assert expected in blocked['content'][0]['text'], blocked
            protected_paths.append(path)
        print(json.dumps({'test': 'MCP-obsolete-session-after-restart', 'passed': True,
                          'transport': 'live loopback HTTP' if live else 'real FastMCP ASGI',
                          'tool': 'bridge_status', 'version': status['version'],
                          'security': {'wrongHost': host.status_code, 'wrongOrigin': origin.status_code,
                                       'oversizedBody': oversized.status_code,
                                       'blockedPaths': protected_paths}}, ensure_ascii=False))
    if live:
        async with streamablehttp_client(f'http://127.0.0.1:{server.PORT}/mcp') as (read, write, _):
            async with ClientSession(read, write) as session:
                await session.initialize()
                tools = {tool.name for tool in (await session.list_tools()).tools}
                assert 'bridge_status' in tools
                result = await session.call_tool('bridge_status', {})
                assert not result.isError, result
                status = json.loads(result.content[0].text)
                assert status['status'] == 'ok' and status['version'] == '0.4.1', status
                print(json.dumps({'test': 'MCP-fresh-SDK-session', 'passed': True,
                                  'initialized': True, 'toolsListed': len(tools),
                                  'tool': 'bridge_status', 'version': status['version']}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--live', action='store_true', help='Test the existing loopback listener')
    asyncio.run(main(parser.parse_args().live))
