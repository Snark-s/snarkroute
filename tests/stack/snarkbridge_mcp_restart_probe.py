"""Exercise a real MCP tool after transport restart using an obsolete session ID."""
import asyncio
import importlib.util
import json
from pathlib import Path
import sys

import httpx

sys.path.insert(0, str(Path(__file__).parent))
from stack_paths import home

bridge_root = home('snarkbridge')
sys.path.insert(0, str(bridge_root))
spec = importlib.util.spec_from_file_location('audited_bridge_server', bridge_root / 'server.py')
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)


async def main():
    app = server.mcp.streamable_http_app()
    # The ASGI app uses the real installed MCP implementation; no sockets or models.
    async with server.mcp.session_manager.run():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                                    base_url=f'http://127.0.0.1:{server.PORT}') as client:
            response = await client.post('/mcp', headers={
                'Accept': 'application/json, text/event-stream',
                'Mcp-Protocol-Version': '2025-03-26',
                'Mcp-Session-Id': 'obsolete-session-from-before-restart',
            }, json={'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call',
                     'params': {'name': 'bridge_status', 'arguments': {}}})
            assert response.status_code == 200, (response.status_code, response.text)
            if response.headers['content-type'].startswith('text/event-stream'):
                payload = json.loads(next(line[6:] for line in response.text.splitlines()
                                          if line.startswith('data: ')))
            else:
                payload = response.json()
            result = payload['result']
            assert not result.get('isError'), result
            status = json.loads(result['content'][0]['text'])
            assert status['status'] == 'ok' and status['version'] == '0.4.1', status
            print(json.dumps({'test': 'MCP-obsolete-session-after-restart', 'passed': True,
                              'transport': 'real FastMCP ASGI', 'tool': 'bridge_status',
                              'version': status['version']}, ensure_ascii=False))


asyncio.run(main())
