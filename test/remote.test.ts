import test from 'node:test';
import assert from 'node:assert/strict';
import { McpMemoryRemote, RpcClient, HttpPost, assertSecureApiUrl, parseMemories, parseRpcBody } from '../src/remote';

const ok = (payload: unknown) => ({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } });

function rpcWith(post: HttpPost): RpcClient { return new RpcClient({ apiUrl: 'https://api.test/', key: 'rk_secretkey123' }, post, 200); }

test('envía JSON-RPC tools/call con Bearer y Accept; parsea JSON', async () => {
    let seen: any;
    const rpc = rpcWith(async (req) => { seen = req; return { status: 200, text: JSON.stringify(ok({ cursor: '5', pages: [] })) }; });
    const m = await new McpMemoryRemote(rpc).manifest('mem1', 'c0');
    assert.deepEqual(m, { cursor: '5', pages: [] });
    assert.equal(seen.url, 'https://api.test/mcp');
    assert.equal(seen.headers.Authorization, 'Bearer rk_secretkey123');
    assert.equal(seen.headers.Accept, 'application/json, text/event-stream');
    const body = JSON.parse(seen.body);
    assert.equal(body.jsonrpc, '2.0'); assert.equal(body.method, 'tools/call');
    assert.deepEqual(body.params, { name: 'ryphos_memory_manifest', arguments: { memoryId: 'mem1', since: 'c0' } });
});

test('tolera respuesta SSE (líneas data:)', async () => {
    const sse = `event: message\ndata: ${JSON.stringify(ok({ id: 'p', path: 'a.md', revision: 2, hash: 'h', markdown: 'x' }))}\n\n`;
    const rpc = rpcWith(async () => ({ status: 200, text: sse }));
    const r = await new McpMemoryRemote(rpc).read('m', { path: 'a.md' });
    assert.equal(r.markdown, 'x');
});

test('read por id usa pageId; write incluye baseRevision solo si existe', async () => {
    const calls: any[] = [];
    const rpc = rpcWith(async (req) => { calls.push(JSON.parse(req.body).params); return { status: 200, text: JSON.stringify(ok({ status: 'ok' })) }; });
    const r = new McpMemoryRemote(rpc);
    await r.read('m', { id: 'P1' }); await r.write('m', 'a.md', 'x'); await r.write('m', 'a.md', 'x', 3); await r.remove('m', 'a.md', 4);
    assert.deepEqual(calls.map((c) => c.arguments), [
        { memoryId: 'm', pageId: 'P1' }, { memoryId: 'm', path: 'a.md', markdown: 'x' },
        { memoryId: 'm', path: 'a.md', markdown: 'x', baseRevision: 3 }, { memoryId: 'm', path: 'a.md', baseRevision: 4 },
    ]);
    assert.equal(calls[3].name, 'ryphos_memory_delete');
});

test('isError, error JSON-RPC y HTTP 401 se convierten en Error sin filtrar la clave', async () => {
    const isErr = rpcWith(async () => ({ status: 200, text: JSON.stringify({ jsonrpc: '2.0', id: 1, result: { isError: true, content: [{ type: 'text', text: 'Memoria no encontrada' }] } }) }));
    await assert.rejects(isErr.call('ryphos_memory_list', {}), /Memoria no encontrada/);
    const rpcErr = rpcWith(async () => ({ status: 200, text: JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'boom' } }) }));
    await assert.rejects(rpcErr.call('x', {}), /boom/);
    const unauth = rpcWith(async () => ({ status: 401, text: '' }));
    await assert.rejects(unauth.call('x', {}), /no válido/);
    const net = rpcWith(async () => { throw new Error('fallo con rk_secretkey123 dentro'); });
    await assert.rejects(net.call('x', {}), (e: Error) => !e.message.includes('rk_secretkey123') && /No se pudo contactar/.test(e.message));
});

test('timeout', async () => {
    const rpc = new RpcClient({ apiUrl: 'https://a.b', key: 'rk_x' }, () => new Promise(() => undefined), 50);
    await assert.rejects(rpc.call('x', {}), /Tiempo de espera/);
});

test('assertSecureApiUrl, parseMemories y cuerpo inválido', () => {
    assertSecureApiUrl('https://api.ryphos.com'); assertSecureApiUrl('http://localhost:3140');
    assert.throws(() => assertSecureApiUrl('http://evil.com'));
    assert.throws(() => assertSecureApiUrl('ftp://x'));
    assert.deepEqual(parseMemories([{ id: 'a', name: 'A', projects: [] }]), [{ id: 'a', name: 'A' }]);
    assert.deepEqual(parseMemories({ memories: [{ id: 'b', name: 'B' }, { name: 'sin id' }] }), [{ id: 'b', name: 'B' }]);
    assert.throws(() => parseRpcBody('basura'), /no válida/);
});

test('cualquier 3xx es error', async () => {
    const rpc = rpcWith(async () => ({ status: 307, text: '' }));
    await assert.rejects(rpc.call('x', {}), /redirección/);
});
