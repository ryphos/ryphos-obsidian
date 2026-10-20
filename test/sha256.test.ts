import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { sha256Hex } from '../src/core/sha256';

test('sha256 JS puro coincide con node:crypto (bloques, multibyte, tamaños límite)', () => {
    const samples = ['', 'abc', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(63), 'a'.repeat(64), 'a'.repeat(65), 'ñandú 日本語 😀 '.repeat(50), 'x'.repeat(10_000), 'lone \ud800 surrogate'];
    for (const s of samples) assert.equal(sha256Hex(s), createHash('sha256').update(s, 'utf8').digest('hex'), s.slice(0, 10));
    for (let i = 0; i < 200; i++) {
        const s = Array.from({ length: i * 3 }, (_, k) => String.fromCharCode(32 + ((k * 31 + i) % 2000))).join('');
        assert.equal(sha256Hex(s), createHash('sha256').update(s, 'utf8').digest('hex'));
    }
});
