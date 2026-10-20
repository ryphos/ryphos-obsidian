import test from 'node:test';
import assert from 'node:assert/strict';
import { conflictPath, decide, hashMarkdown, makeIgnore, safeDocPath, stripFrontmatter } from '../src/core/docs-core';

test('hash: ignora frontmatter y CRLF', () => {
    const a = '---\nryphos_id: x\ntitle: T\n---\n# Hola\n\ncuerpo\n';
    const b = '# Hola\r\n\r\ncuerpo\r\n';
    assert.equal(hashMarkdown(a), hashMarkdown(b));
    assert.notEqual(hashMarkdown(a), hashMarkdown(a + 'x'));
    assert.equal(stripFrontmatter('---\n---\nhola'), 'hola');
    assert.match(hashMarkdown(''), /^[0-9a-f]{64}$/);
});

test('safeDocPath rechaza rutas peligrosas', () => {
    for (const bad of ['../x.md', 'a/../../x.md', '/etc/x.md', 'C:/x.md', 'a\\b.md', 'a//b.md', 'x.txt', '', './x.md', 'a/\0.md']) {
        assert.equal(safeDocPath(bad), null, bad);
    }
    assert.equal(safeDocPath('a/b c.md'), 'a/b c.md');
});

test('ignorados', () => {
    const ig = makeIgnore('borradores/\n*.tmp.md\n');
    assert.equal(ig('.obsidian/app.md'), true);
    assert.equal(ig('a/.trash/x.md'), true);
    assert.equal(ig('img.png'), true);
    assert.equal(ig('notas.txt'), true);
    assert.equal(ig('a.conflict-pc.md'), true);
    assert.equal(ig('borradores/x.md'), true);
    assert.equal(ig('x.tmp.md'), true);
    assert.equal(ig('.git/x.md'), true);
    assert.equal(ig('ok/a.md'), false);
    assert.equal(ig('ok', true), false);
    assert.equal(ig('.obsidian', true), true);
    assert.equal(conflictPath('a/b.md', 'mi pc'), 'a/b.conflict-mi-pc.md');
});

test('decide: tabla de casos', () => {
    const st = { id: 'i', revision: 1, hash: 'h1' };
    const R = (revision: number, hash: string, deleted = false) => ({ id: 'i', revision, hash, deleted });
    assert.equal(decide(undefined, { hash: 'a' }, undefined), 'push');
    assert.equal(decide(undefined, undefined, R(1, 'a')), 'pull');
    assert.equal(decide(undefined, { hash: 'a' }, R(1, 'a')), 'adopt');
    assert.equal(decide(undefined, { hash: 'a' }, R(1, 'b')), 'conflict');
    assert.equal(decide(st, { hash: 'h1' }, undefined), 'noop');
    assert.equal(decide(st, { hash: 'h1' }, R(1, 'h1')), 'noop');
    assert.equal(decide(st, { hash: 'h2' }, undefined), 'push');
    assert.equal(decide(st, { hash: 'h1' }, R(2, 'h3')), 'pull');
    assert.equal(decide(st, { hash: 'h2' }, R(2, 'h3')), 'conflict');
    assert.equal(decide(st, { hash: 'h3' }, R(2, 'h3')), 'adopt');
    assert.equal(decide(st, undefined, undefined), 'delete-remote');
    assert.equal(decide(st, undefined, R(0, '', true)), 'forget');
    assert.equal(decide(st, undefined, R(2, 'h3')), 'pull');
    assert.equal(decide(st, { hash: 'h1' }, R(2, '', true)), 'delete-local');
    assert.equal(decide(st, { hash: 'h2' }, R(2, '', true)), 'push');
    assert.equal(decide(undefined, undefined, R(1, '', true)), 'noop');
});
