import { App, TFile, normalizePath } from 'obsidian';
import type { LocalFs } from './core/sync';
import { pathProblem } from './core/docs-core';
import { relativeInside } from './folder';

/** LocalFs sobre la Vault API de Obsidian, confinado a `folder`. Nunca lee ni escribe fuera de ella. */
export class ObsidianVaultFs implements LocalFs {
    constructor(private readonly app: App, private readonly folder: string) {}

    private full(rel: string): string {
        const segs = rel.split('/');
        const special = rel === '.git' || rel === '.ryphosignore';
        if (!special && (pathProblem(rel) || segs.some((s) => s === '..'))) throw new Error(`ruta no permitida: ${rel}`);
        const full = normalizePath(`${this.folder}/${rel}`);
        if (relativeInside(this.folder, full) === null) throw new Error(`ruta fuera de la carpeta sincronizada: ${rel}`);
        return full;
    }

    async list(skipDir: (rel: string) => boolean): Promise<string[]> {
        const out: string[] = [];
        for (const f of this.app.vault.getFiles()) {
            const rel = relativeInside(this.folder, f.path);
            if (rel === null) continue;
            const segs = rel.split('/');
            let skip = false;
            for (let i = 1; i < segs.length; i++) if (skipDir(segs.slice(0, i).join('/'))) { skip = true; break; }
            if (!skip) out.push(rel);
        }
        return out;
    }

    async read(rel: string): Promise<string> {
        const full = this.full(rel);
        const f = this.app.vault.getAbstractFileByPath(full);
        if (f instanceof TFile) return this.app.vault.read(f);
        return this.app.vault.adapter.read(full);
    }

    async write(rel: string, data: string): Promise<void> {
        const full = this.full(rel);
        const parts = full.split('/');
        for (let i = 1; i < parts.length; i++) {
            const dir = parts.slice(0, i).join('/');
            if (!(await this.app.vault.adapter.exists(dir))) {
                try { await this.app.vault.createFolder(dir); } catch { /* ya existe (carrera) */ }
            }
        }
        const f = this.app.vault.getAbstractFileByPath(full);
        if (f instanceof TFile) await this.app.vault.modify(f, data);
        else await this.app.vault.create(full, data);
    }

    async remove(rel: string): Promise<void> {
        const full = this.full(rel);
        const f = this.app.vault.getAbstractFileByPath(full);
        if (f instanceof TFile) await this.app.fileManager.trashFile(f); // respeta la papelera elegida por el usuario
    }

    async exists(rel: string): Promise<boolean> {
        return this.app.vault.adapter.exists(this.full(rel));
    }
}
