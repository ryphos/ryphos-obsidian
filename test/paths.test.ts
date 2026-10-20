import test from 'node:test';
import assert from 'node:assert/strict';
import { isAgentInstructionName, safeDocPath } from '../src/core/docs-core';
import { agoText, defaultFolder, normalizeFolder, relativeInside } from '../src/folder';

test('safeDocPath: ocultos, agentes, caracteres Windows, reservados', () => {
    const bad = ['.hidden/a.md', 'a/.x.md', 'CLAUDE.md', 'docs/Agents.md', 'a/GEMINI.md', 'copilot-instructions.md',
        '.claude/x.md', '.cursor/rules.md', '.github/a.md', '.windsurf/a.md', 'a:b.md', 'a<b.md', 'a|b.md', 'a?.md', 'a*.md', 'a"b.md',
        'dir /a.md', 'dir./a.md', 'con.md', 'NUL.md', 'com1.md', 'lpt9.x.md', 'aux/a.md', '../x.md', '/x.md', 'a\\b.md', 'x.txt'];
    for (const b of bad) assert.equal(safeDocPath(b), null, b);
    for (const ok of ['a/b.md', 'Notas de hoy.md', 'console.md', 'x/claude-notes.md']) assert.equal(safeDocPath(ok), ok, ok);
    assert.equal(isAgentInstructionName('.CursorRules'), true);
});

test('normalizeFolder: solo relativas y seguras', () => {
    assert.equal(normalizeFolder('Ryphos/Mi memoria/'), 'Ryphos/Mi memoria');
    assert.equal(normalizeFolder('\\Ryphos\\x'), 'Ryphos/x');
    for (const bad of ['', '/', '..', 'a/../b', '.obsidian/x', 'C:/x', 'a/.git', 'a:b', 'x.']) assert.throws(() => normalizeFolder(bad), bad);
});

test('defaultFolder y relativeInside', () => {
    assert.equal(defaultFolder('Trabajo: 2026/Q1'), 'Ryphos/Trabajo- 2026-Q1');
    assert.equal(defaultFolder('...'), 'Ryphos/Memoria');
    assert.equal(relativeInside('Ryphos/M', 'Ryphos/M/a/b.md'), 'a/b.md');
    assert.equal(relativeInside('Ryphos/M', 'Ryphos/Mx/a.md'), null);
    assert.equal(relativeInside('Ryphos/M', 'Otra/a.md'), null);
});

test('agoText', () => {
    const now = 1_000_000_000;
    assert.equal(agoText(now - 3000, now), 'ahora mismo');
    assert.equal(agoText(now - 30_000, now), 'hace 30 s');
    assert.equal(agoText(now - 5 * 60_000, now), 'hace 5 min');
    assert.equal(agoText(now - 3 * 3600_000, now), 'hace 3 h');
});
