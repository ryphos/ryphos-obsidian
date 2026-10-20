import { hashMarkdown } from '../src/core/docs-core';
import { LocalFs, Manifest, MemoryRemote, ReadResult, WriteResult } from '../src/core/sync';

/** Bóveda en memoria (solo ficheros; las carpetas son implícitas). */
export class FakeVault implements LocalFs {
    files = new Map<string, string>();
    async list(skipDir: (rel: string) => boolean): Promise<string[]> {
        return [...this.files.keys()].filter((rel) => {
            const segs = rel.split('/');
            for (let i = 1; i < segs.length; i++) if (skipDir(segs.slice(0, i).join('/'))) return false;
            return true;
        });
    }
    async read(rel: string): Promise<string> {
        const v = this.files.get(rel);
        if (v === undefined) throw new Error(`no existe ${rel}`);
        return v;
    }
    async write(rel: string, data: string): Promise<void> { this.files.set(rel, data); }
    async remove(rel: string): Promise<void> { this.files.delete(rel); }
    async exists(rel: string): Promise<boolean> {
        return this.files.has(rel) || [...this.files.keys()].some((k) => k.startsWith(rel + '/'));
    }
}

export interface Page { id: string; path: string; revision: number; markdown: string; deleted: boolean; clock: number }

/** Servidor falso con la semántica del contrato ryphos_memory_* (revision, hash, tombstones, conflicto). */
export class FakeRemote implements MemoryRemote {
    pages = new Map<string, Page>();
    pageSize = Infinity;
    manifestCalls = 0;
    /** Si since existe y es < resetBefore, responde resetRequired. */
    resetBefore = 0;
    sawReset = false;
    private clock = 0;
    private seq = 0;
    private live(p: string): Page | undefined {
        const pg = this.pages.get(p);
        return pg && !pg.deleted ? pg : undefined;
    }
    /** Edición desde la web de Ryphos. */
    webEdit(path: string, markdown: string): void {
        const pg = this.live(path)!;
        pg.markdown = markdown; pg.revision++; pg.clock = ++this.clock;
    }
    async manifest(_m: string, since?: string): Promise<Manifest> {
        this.manifestCalls++;
        if (since !== undefined && Number(since) < this.resetBefore) { this.sawReset = true; return { resetRequired: true, pages: [] }; }
        const s = since ? Number(since) : 0;
        let list = [...this.pages.values()].filter((pg) => (since ? pg.clock > s : !pg.deleted)).sort((a, b) => a.clock - b.clock);
        const truncated = list.length > this.pageSize;
        if (truncated) list = list.slice(0, this.pageSize);
        const cursor = String(truncated ? list[list.length - 1].clock : this.clock);
        return {
            cursor, truncated,
            pages: list.map((pg) => ({ id: pg.id, path: pg.path, title: pg.path, revision: pg.revision, hash: hashMarkdown(pg.markdown), updatedAt: String(pg.clock), deleted: pg.deleted })),
        };
    }
    async read(_m: string, sel: { id?: string; path?: string }): Promise<ReadResult> {
        const pg = [...this.pages.values()].find((x) => !x.deleted && (sel.id ? x.id === sel.id : x.path === sel.path));
        if (!pg) throw new Error('Página no encontrada');
        return { id: pg.id, path: pg.path, title: pg.path, revision: pg.revision, hash: hashMarkdown(pg.markdown), markdown: pg.markdown };
    }
    async write(_m: string, path: string, markdown: string, baseRevision?: number): Promise<WriteResult> {
        const pg = this.live(path);
        if (!pg) {
            if (baseRevision) return { status: 'conflict', current: { revision: 0, hash: '', markdown: '' } };
            const n: Page = { id: `id${++this.seq}`, path, revision: 1, markdown, deleted: false, clock: ++this.clock };
            this.pages.set(path, n);
            return { status: 'ok', id: n.id, revision: 1, hash: hashMarkdown(markdown) };
        }
        if ((baseRevision ?? 0) !== pg.revision) return { status: 'conflict', current: { revision: pg.revision, hash: hashMarkdown(pg.markdown), markdown: pg.markdown } };
        if (hashMarkdown(pg.markdown) === hashMarkdown(markdown)) return { status: 'unchanged' };
        pg.markdown = markdown; pg.revision++; pg.clock = ++this.clock;
        return { status: 'ok', id: pg.id, revision: pg.revision, hash: hashMarkdown(markdown) };
    }
    async remove(_m: string, path: string, baseRevision: number): Promise<unknown> {
        const pg = this.live(path);
        if (!pg) throw new Error('Página no encontrada');
        if (pg.revision !== baseRevision) throw new Error('conflicto de revisión');
        pg.deleted = true; pg.revision++; pg.clock = ++this.clock;
        return { status: 'ok' };
    }
}
