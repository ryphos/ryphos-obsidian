import { App, TFile, TFolder, normalizePath } from 'obsidian';
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
        const root = this.app.vault.getFolderByPath(this.folder);
        if (!root) return out;
        const walk = (dir: TFolder, prefix: string): void => {
            for (const child of dir.children) {
                const rel = prefix ? `${prefix}/${child.name}` : child.name;
                if (child instanceof TFolder) { if (!skipDir(rel)) walk(child, rel); }
                else if (child instanceof TFile) out.push(rel);
            }
        };
        walk(root, '');
        return out;
    }

    async read(rel: string): Promise<string> {
        const full = this.full(rel);
        const f = this.app.vault.getFileByPath(full);
        if (!f) throw new Error(`no existe: ${rel}`);
        return this.app.vault.read(f);
    }

    async write(rel: string, data: string): Promise<void> {
        const full = this.full(rel);
        const parts = full.split('/');
        for (let i = 1; i < parts.length; i++) {
            const dir = parts.slice(0, i).join('/');
            if (!this.app.vault.getAbstractFileByPath(dir)) {
                try { await this.app.vault.createFolder(dir); } catch { /* ya existe (carrera) */ }
            }
        }
        const f = this.app.vault.getFileByPath(full);
        if (f) await this.app.vault.process(f, () => data);
        else await this.app.vault.create(full, data);
    }

    async remove(rel: string): Promise<void> {
        const full = this.full(rel);
        const f = this.app.vault.getFileByPath(full);
        if (f) await this.app.fileManager.trashFile(f); // respeta la papelera elegida por el usuario
    }

    async exists(rel: string): Promise<boolean> {
        // La Vault API no indexa ficheros ocultos (.git, .ryphosignore): para ellos devuelve false, y es lo esperado.
        return this.app.vault.getAbstractFileByPath(this.full(rel)) !== null;
    }
}
