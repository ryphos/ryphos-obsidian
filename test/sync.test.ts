import test from 'node:test';
import assert from 'node:assert/strict';
import { SyncState } from '../src/core/docs-core';
import { Mode, SyncReport, runSync } from '../src/core/sync';
import { FakeRemote, FakeVault, Page } from './fakes';

interface Dev { v: FakeVault; state: SyncState; host: string }
const mkDev = (host: string): Dev => ({ v: new FakeVault(), state: { files: {} }, host });
const sync = (d: Dev, remote: FakeRemote, mode: Mode = 'sync', dryRun = false): Promise<SyncReport> =>
    runSync({ fs: d.v, state: d.state, memoryId: 'm1', remote, host: d.host, mode, dryRun });
const actions = (r: SyncReport): string[] => r.results.map((x) => x.action);

test('dos dispositivos convergen (push, pull, edición, edición web)', async () => {
    const remote = new FakeRemote(); const A = mkDev('a'); const B = mkDev('b');
    A.v.files.set('Proy/arq.md', '# Arq\n'); A.v.files.set('Proy/sub/api.md', 'API');
    assert.deepEqual(actions(await sync(A, remote)), ['push', 'push']);
    assert.deepEqual(actions(await sync(B, remote)), ['pull', 'pull']);
    assert.equal(B.v.files.get('Proy/sub/api.md'), 'API');
    assert.equal((await sync(A, remote)).results.length, 0);
    assert.equal((await sync(B, remote)).results.length, 0);
    A.v.files.set('Proy/arq.md', '# Arq v2\n');
    await sync(A, remote); await sync(B, remote);
    assert.equal(B.v.files.get('Proy/arq.md'), '# Arq v2\n');
    remote.webEdit('Proy/arq.md', '# Arq web\n');
    await sync(A, remote);
    assert.equal(A.v.files.get('Proy/arq.md'), '# Arq web\n');
    await sync(B, remote);
    assert.deepEqual([...A.v.files.entries()].sort(), [...B.v.files.entries()].sort());
});

test('conflicto: edición simultánea genera conflict-<dispositivo>.md sin perder nada', async () => {
    const remote = new FakeRemote(); const A = mkDev('a'); const B = mkDev('movil-1');
    A.v.files.set('n.md', 'base'); await sync(A, remote); await sync(B, remote);
    A.v.files.set('n.md', 'cambio A'); B.v.files.set('n.md', 'cambio B');
    await sync(A, remote);
    const rb = await sync(B, remote);
    assert.deepEqual(rb.conflicts, ['n.md']);
    assert.equal(B.v.files.get('n.md'), 'cambio B');
    assert.equal(B.v.files.get('n.conflict-movil-1.md'), 'cambio A');
    assert.equal(remote.pages.get('n.md')!.markdown, 'cambio A');
    assert.deepEqual((await sync(B, remote)).conflicts, ['n.md']);
    assert.equal(remote.pages.has('n.conflict-movil-1.md'), false, 'el fichero de conflicto nunca se sube');
    B.v.files.set('n.md', 'cambio A');
    const fin = await sync(B, remote);
    assert.deepEqual(actions(fin), ['adopt']);
});

test('conflicto detectado por el servidor al subir (baseRevision)', async () => {
    const remote = new FakeRemote(); const A = mkDev('a');
    A.v.files.set('n.md', 'base'); await sync(A, remote);
    A.v.files.set('n.md', 'local');
    remote.webEdit('n.md', 'remoto');
    A.state.cursor = '999999';
    const r = await sync(A, remote);
    assert.deepEqual(r.conflicts, ['n.md']);
    assert.equal(A.v.files.get('n.md'), 'local');
    assert.equal(A.v.files.get('n.conflict-a.md'), 'remoto');
});

test('borrados en ambos sentidos y recreación', async () => {
    const remote = new FakeRemote(); const A = mkDev('a'); const B = mkDev('b');
    A.v.files.set('d1.md', '1'); A.v.files.set('d2.md', '2'); A.v.files.set('r.md', 'v1');
    await sync(A, remote); await sync(B, remote);
    A.v.files.delete('d1.md');
    assert.deepEqual(actions(await sync(A, remote)), ['delete-remote']);
    assert.deepEqual(actions(await sync(B, remote)), ['delete-local']);
    assert.equal(B.v.files.has('d1.md'), false);
    const pg = remote.pages.get('d2.md')!;
    await remote.remove('m1', 'd2.md', pg.revision);
    await sync(A, remote); await sync(B, remote);
    assert.equal(A.v.files.has('d2.md'), false); assert.equal(B.v.files.has('d2.md'), false);
    // borrado remoto + edición local = se recrea
    A.v.files.delete('r.md'); await sync(A, remote);
    B.v.files.set('r.md', 'v1 editado');
    assert.deepEqual(actions(await sync(B, remote)), ['push']);
    assert.equal(remote.pages.get('r.md')!.markdown, 'v1 editado');
    // borrado en ambos
    A.v.files.set('z.md', 'z'); await sync(A, remote); await sync(B, remote);
    A.v.files.delete('z.md'); B.v.files.delete('z.md');
    await sync(A, remote);
    const rf = await sync(B, remote);
    assert.deepEqual(actions(rf), ['forget']); assert.equal(rf.errors, 0);
});

test('renombrar localmente = borrar la ruta antigua y subir la nueva; el otro dispositivo converge', async () => {
    const remote = new FakeRemote(); const A = mkDev('a'); const B = mkDev('b');
    A.v.files.set('viejo.md', 'contenido'); await sync(A, remote); await sync(B, remote);
    A.v.files.set('nuevo.md', A.v.files.get('viejo.md')!); A.v.files.delete('viejo.md');
    assert.deepEqual(actions(await sync(A, remote)).sort(), ['delete-remote', 'push']);
    assert.deepEqual(actions(await sync(B, remote)).sort(), ['delete-local', 'pull']);
    assert.equal(B.v.files.has('viejo.md'), false);
    assert.equal(B.v.files.get('nuevo.md'), 'contenido');
});

test('ruta movida en el servidor: la antigua desaparece', async () => {
    const remote = new FakeRemote(); const A = mkDev('a');
    A.v.files.set('viejo.md', 'm'); await sync(A, remote);
    const pg = remote.pages.get('viejo.md')!;
    remote.pages.delete('viejo.md'); pg.path = 'nuevo.md'; pg.revision++; pg.clock = 99; remote.pages.set('nuevo.md', pg);
    A.state.cursor = '0';
    await sync(A, remote);
    assert.equal(A.v.files.has('viejo.md'), false);
    assert.equal(A.v.files.get('nuevo.md'), 'm');
});

test('ignorados: .obsidian, no .md, conflict, .ryphosignore, ocultos y agentes no se suben', async () => {
    const remote = new FakeRemote(); const A = mkDev('a');
    for (const f of ['.obsidian/w.md', '.trash/o.md', 'foto.png', 'notas.txt', 'a.conflict-pc.md', 'privado/s.md', 'CLAUDE.md', '.oculto.md']) A.v.files.set(f, 'x');
    A.v.files.set('ok.md', 'ok'); A.v.files.set('.ryphosignore', 'privado/\n');
    const r = await sync(A, remote);
    assert.deepEqual([...remote.pages.keys()], ['ok.md']);
    assert.ok(r.warnings.some((w) => w.includes('CLAUDE.md')));
});

test('seguridad: rutas inseguras del servidor nunca se escriben', async () => {
    const remote = new FakeRemote(); const A = mkDev('a');
    const evil = ['../evil.md', '/abs/evil.md', 'a/../../evil.md', 'C:/evil.md', '.claude/x.md', 'AGENTS.md', 'a\\b.md'];
    for (const p of evil) remote.pages.set(p, { id: p, path: p, revision: 1, markdown: 'pwn', deleted: false, clock: 1 } as Page);
    const r = await sync(A, remote);
    assert.ok(r.warnings.length >= 5);
    assert.equal(A.v.files.size, 0);
});

test('colisión por mayúsculas: se omite con aviso', async () => {
    const remote = new FakeRemote(); const A = mkDev('a');
    remote.pages.set('Nota.md', { id: '1', path: 'Nota.md', revision: 1, markdown: 'a', deleted: false, clock: 1 });
    remote.pages.set('nota.md', { id: '2', path: 'nota.md', revision: 1, markdown: 'b', deleted: false, clock: 1 });
    const r = await sync(A, remote);
    assert.equal(A.v.files.size, 0);
    assert.ok(r.warnings.some((w) => w.includes('colisión')));
});

test('modos pull/push, dryRun no toca nada, y .git propio aborta', async () => {
    const remote = new FakeRemote(); const A = mkDev('a'); const B = mkDev('b');
    A.v.files.set('a.md', 'A'); B.v.files.set('b.md', 'B');
    const dry = await sync(B, remote, 'sync', true);
    assert.deepEqual(actions(dry), ['push']); assert.equal(remote.pages.size, 0); assert.deepEqual(B.state, { files: {} });
    await sync(A, remote);
    const pull = await sync(B, remote, 'pull');
    assert.equal(B.v.files.get('a.md'), 'A'); assert.equal(remote.pages.has('b.md'), false);
    assert.ok(pull.results.some((r) => r.action === 'skipped'));
    await sync(B, remote, 'push'); assert.equal(remote.pages.has('b.md'), true);
    const C = mkDev('c'); C.v.files.set('.git/HEAD', 'x');
    await assert.rejects(sync(C, remote), /\.git/);
});

test('primera sincronía pide confirmación y cancelar no toca nada', async () => {
    const remote = new FakeRemote(); const A = mkDev('a');
    A.v.files.set('a.md', 'A');
    await assert.rejects(runSync({ fs: A.v, state: A.state, memoryId: 'm', remote, host: 'a', fresh: true, confirmFirstSync: async () => false }), /Cancelado/);
    assert.equal(remote.pages.size, 0);
    let info: unknown;
    await runSync({ fs: A.v, state: A.state, memoryId: 'm', remote, host: 'a', fresh: true, confirmFirstSync: async (i) => { info = i; return true; } });
    assert.deepEqual(info, { pull: 0, push: 1, total: 1 });
    assert.equal(remote.pages.size, 1);
});

test('manifiesto truncado: se sigue pidiendo hasta completar', async () => {
    const remote = new FakeRemote(); const A = mkDev('a'); const B = mkDev('b');
    for (let i = 0; i < 7; i++) A.v.files.set(`p${i}.md`, `c${i}`);
    await sync(A, remote);
    remote.pageSize = 3; remote.manifestCalls = 0;
    await sync(B, remote);
    assert.equal(B.v.files.size, 7);
    assert.ok(remote.manifestCalls >= 3);
});

test('avisos del servidor en write se devuelven', async () => {
    const remote = new FakeRemote(); const A = mkDev('a');
    const orig = remote.write.bind(remote);
    remote.write = async (...args) => ({ ...(await orig(...args)), warnings: ['secreto enmascarado'] });
    A.v.files.set('s.md', 'token'); 
    const r = await sync(A, remote);
    assert.deepEqual(r.serverWarnings, ['s.md: secreto enmascarado']);
});

test('resetRequired: cursor caducado → sync completa; borrado remoto sin cambios locales se borra, con cambios se vuelve a subir', async () => {
    const remote = new FakeRemote(); const A = mkDev('a');
    A.v.files.set('keep.md', 'k'); A.v.files.set('gone.md', 'g'); A.v.files.set('edited.md', 'e');
    await sync(A, remote);
    // el servidor "olvida" tombstones: borra gone/edited sin dejar rastro y exige reinicio
    remote.pages.delete('gone.md'); remote.pages.delete('edited.md');
    remote.resetBefore = 1;
    A.v.files.set('edited.md', 'e editado');
    A.state.cursor = '0';
    const r = await sync(A, remote);
    assert.equal(remote.sawReset, true);
    assert.equal(A.v.files.has('gone.md'), false);
    assert.equal(A.v.files.get('edited.md'), 'e editado');
    assert.equal(remote.pages.get('edited.md')!.markdown, 'e editado');
    assert.deepEqual(r.results.map((x) => x.action).sort(), ['delete-local', 'push']);
    assert.equal(A.state.files['gone.md'], undefined);
});
