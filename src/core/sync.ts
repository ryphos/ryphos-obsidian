import {
    Action, LocalInfo, RemoteInfo, SyncState, collisionKey, conflictPath, decide, hashMarkdown, isAgentInstructionName,
    makeIgnore, pathProblem, safeDocPath,
} from './docs-core';

/** Máximo de caracteres de markdown que acepta el servidor. */
export const MAX_MARKDOWN = 200_000;

export interface ManifestPage {
    id: string; path: string; title?: string; revision: number; hash: string; updatedAt?: string; deleted?: boolean;
}
export interface Manifest { cursor?: string; truncated?: boolean; /** El `since` enviado es más antiguo que la ventana de tombstones: hay que sincronizar de cero. */ resetRequired?: boolean; pages: ManifestPage[] }
export interface ReadResult { id: string; path: string; title?: string; revision: number; hash: string; markdown: string }
export interface WriteResult {
    status: 'ok' | 'unchanged' | 'conflict';
    id?: string; revision?: number; hash?: string;
    /** Avisos del servidor (p. ej. secretos enmascarados). */
    warnings?: string[];
    current?: { revision: number; hash: string; markdown: string };
}

/** Frontera con el servidor (el plugin usa JSON-RPC a /mcp; los tests, un servidor en memoria). `memoryId` es opaco. */
export interface MemoryRemote {
    manifest(memoryId: string, since?: string): Promise<Manifest>;
    read(memoryId: string, sel: { id?: string; path?: string }): Promise<ReadResult>;
    write(memoryId: string, path: string, markdown: string, baseRevision?: number): Promise<WriteResult>;
    remove(memoryId: string, path: string, baseRevision: number): Promise<unknown>;
}

/**
 * Frontera con el disco/bóveda. Todas las rutas son relativas a la carpeta sincronizada, con '/'.
 * La implementación NUNCA debe salir de esa carpeta (el motor ya valida las rutas, ella lo comprueba otra vez).
 */
export interface LocalFs {
    /** Rutas relativas de todos los ficheros bajo la carpeta (sin entrar en directorios que `skipDir` rechace). */
    list(skipDir: (rel: string) => boolean): Promise<string[]>;
    read(rel: string): Promise<string>;
    /** Crea o sobrescribe (creando carpetas intermedias). */
    write(rel: string, data: string): Promise<void>;
    remove(rel: string): Promise<void>;
    exists(rel: string): Promise<boolean>;
}

export type Mode = 'sync' | 'pull' | 'push';

export interface SyncOptions {
    fs: LocalFs;
    /** Se muta in situ; el llamante lo persiste. */
    state: SyncState;
    memoryId: string;
    remote: MemoryRemote;
    host: string;
    mode?: Mode;
    dryRun?: boolean;
    /** Primera sincronía de esta carpeta: se llama antes de tocar nada; false cancela. */
    fresh?: boolean;
    confirmFirstSync?: (info: { pull: number; push: number; total: number }) => Promise<boolean>;
    log?: (msg: string) => void;
}

export interface FileResult { path: string; action: Action | 'skipped'; note?: string; error?: string }
export interface SyncReport { results: FileResult[]; conflicts: string[]; errors: number; cursor?: string; warnings: string[]; serverWarnings: string[] }

/** Ruta del servidor válida (relativa, sin '..', sin ocultos, .md) o null. */
export function resolveInside(rel: string): string | null {
    return safeDocPath(rel);
}

export async function scanLocal(fs: LocalFs, isIgnored: (rel: string, isDir?: boolean) => boolean, warn: (m: string) => void): Promise<Map<string, LocalInfo>> {
    const out = new Map<string, LocalInfo>();
    const files = await fs.list((rel) => isIgnored(rel, true));
    for (const rel of files) {
        if (isIgnored(rel)) {
            if (rel.toLowerCase().endsWith('.md') && rel.split('/').some((s) => isAgentInstructionName(s))) {
                warn(`omitido (nombre no permitido, p. ej. instrucciones de agentes): ${rel}`);
            }
            continue;
        }
        const prob = pathProblem(rel);
        if (prob) { warn(`omitido (${prob}): ${rel}`); continue; }
        out.set(rel, { hash: hashMarkdown(await fs.read(rel)) });
    }
    return out;
}

/** Pide el manifiesto completo siguiendo `truncated` (tope de vueltas para no ciclar). */
async function fetchManifest(remote: MemoryRemote, memoryId: string, since: string | undefined): Promise<Manifest & { full: boolean }> {
    let pages: ManifestPage[] = [];
    let cursor = since;
    let full = !since;
    let last: Manifest = { pages: [] };
    for (let i = 0; i < 100; i++) {
        last = await remote.manifest(memoryId, cursor);
        if (last.resetRequired && cursor) { // cursor demasiado antiguo: se descarta y se pide el manifiesto completo
            pages = []; cursor = undefined; full = true; continue;
        }
        pages.push(...(last.pages || []));
        if (!last.truncated || !last.cursor || last.cursor === cursor) break;
        cursor = last.cursor;
    }
    return { cursor: last.cursor, truncated: false, pages, full };
}

/** Sincronía a tres bandas (misma lógica que docs-sync.ts del CLI, sobre `LocalFs`). */
export async function runSync(opts: SyncOptions): Promise<SyncReport> {
    const { fs, state, memoryId, remote, host } = opts;
    const mode: Mode = opts.mode || 'sync';
    const log = opts.log || (() => undefined);
    const warnings: string[] = [];
    const serverWarnings: string[] = [];

    if (await fs.exists('.git')) {
        throw new Error('La carpeta sincronizada contiene un .git propio: usa una carpeta dedicada solo a la memoria.');
    }
    let ignoreText = '';
    if (await fs.exists('.ryphosignore')) { try { ignoreText = await fs.read('.ryphosignore'); } catch { /* sin ignore */ } }
    const isIgnored = makeIgnore(ignoreText);
    const local = await scanLocal(fs, isIgnored, (m) => warnings.push(m));

    const hadState = Object.keys(state.files).length > 0;
    const since = hadState ? state.cursor : undefined;
    const manifest = await fetchManifest(remote, memoryId, since);

    const remoteMap = new Map<string, RemoteInfo>();
    const skippedUnsafe: string[] = [];
    for (const pg of manifest.pages || []) {
        if (!safeDocPath(pg.path)) { skippedUnsafe.push(String(pg.path)); continue; }
        if (isIgnored(pg.path)) continue;
        const prev = remoteMap.get(pg.path);
        if (pg.deleted && prev && !prev.deleted) continue; // si hay página viva con esa ruta, manda la viva
        remoteMap.set(pg.path, { id: pg.id, revision: pg.revision, hash: pg.hash, deleted: !!pg.deleted });
    }
    if (manifest.full) { // manifiesto completo (o reinicio por cursor caducado): lo que falta ya no existe en el servidor
        for (const p of Object.keys(state.files)) if (!remoteMap.has(p)) remoteMap.set(p, { revision: 0, hash: '', deleted: true });
    }
    // ruta movida en el servidor: la ruta antigua desaparece
    for (const [p, info] of [...remoteMap]) {
        if (info.deleted || !info.id) continue;
        for (const [q, st] of Object.entries(state.files)) {
            if (q !== p && st.id === info.id && !remoteMap.has(q)) remoteMap.set(q, { id: info.id, revision: 0, hash: '', deleted: true });
        }
    }

    // colisiones sin distinguir mayúsculas / NFC: se omiten con aviso
    const groups = new Map<string, Set<string>>();
    const addG = (p: string): void => {
        const k = collisionKey(p);
        if (!groups.has(k)) groups.set(k, new Set());
        groups.get(k)!.add(p);
    };
    for (const p of local.keys()) addG(p);
    for (const [p, info] of remoteMap) if (!info.deleted) addG(p);
    const colliding = new Set<string>();
    for (const set of groups.values()) {
        if (set.size > 1) {
            warnings.push(`omitidas por colisión de nombres (mayúsculas/Unicode): ${[...set].join(' | ')}`);
            for (const p of set) { colliding.add(p); local.delete(p); remoteMap.delete(p); }
        }
    }

    const results: FileResult[] = [];
    const conflicts: string[] = [];
    let errors = 0;
    for (const p of skippedUnsafe) warnings.push(`ruta del servidor omitida (no permitida): ${p}`);

    async function writeConflict(rel: string, markdown: string): Promise<void> {
        const cp = resolveInside(conflictPath(rel, host));
        if (!cp) throw new Error('ruta de conflicto no permitida');
        await fs.write(cp, markdown);
    }

    async function apply(act: Action, rel: string, rem: RemoteInfo | undefined): Promise<string | undefined> {
        if (!resolveInside(rel)) throw new Error(`ruta no permitida: ${rel}`);
        const st = state.files[rel];
        switch (act) {
            case 'pull': {
                const r = await remote.read(memoryId, rem?.id ? { id: rem.id } : { path: rel });
                if (r.path !== rel) throw new Error(`el servidor devolvió otra ruta (${r.path})`);
                await fs.write(rel, r.markdown);
                state.files[rel] = { id: r.id, revision: r.revision, hash: hashMarkdown(r.markdown) };
                return undefined;
            }
            case 'push': {
                const markdown = await fs.read(rel);
                if (markdown.length > MAX_MARKDOWN) throw new Error(`supera el máximo de ${MAX_MARKDOWN} caracteres`);
                const base = st && !rem?.deleted ? st.revision : undefined;
                const res = await remote.write(memoryId, rel, markdown, base);
                if (Array.isArray(res.warnings)) for (const w of res.warnings) serverWarnings.push(`${rel}: ${String(w)}`);
                if (res.status === 'conflict') {
                    await writeConflict(rel, res.current?.markdown ?? '');
                    conflicts.push(rel);
                    return 'conflicto: el servidor cambió mientras subías';
                }
                let id = res.id;
                let revision = res.revision;
                if (res.status === 'unchanged' || revision === undefined) {
                    const r = await remote.read(memoryId, { path: rel });
                    id = r.id; revision = r.revision;
                }
                state.files[rel] = { id, revision: revision as number, hash: hashMarkdown(markdown) };
                return undefined;
            }
            case 'delete-remote': {
                await remote.remove(memoryId, rel, st!.revision);
                delete state.files[rel];
                return undefined;
            }
            case 'delete-local': {
                await fs.remove(rel);
                delete state.files[rel];
                return undefined;
            }
            case 'adopt': {
                state.files[rel] = { id: rem?.id, revision: rem!.revision, hash: local.get(rel)!.hash };
                return undefined;
            }
            case 'forget': { delete state.files[rel]; return undefined; }
            case 'conflict': {
                const r = await remote.read(memoryId, rem?.id ? { id: rem.id } : { path: rel });
                await writeConflict(rel, r.markdown);
                return 'conflicto: se guardó la versión remota al lado, el fichero local no se tocó';
            }
            default: return undefined;
        }
    }

    const allPaths = [...new Set([...Object.keys(state.files), ...local.keys(), ...remoteMap.keys()])].filter((p) => !colliding.has(p)).sort();
    const plan: Array<{ p: string; action: Action; rem: RemoteInfo | undefined }> = [];
    for (const p of allPaths) {
        const rem = remoteMap.get(p);
        const action = decide(state.files[p], local.get(p), rem);
        if (action === 'noop') continue;
        const pushish = action === 'push' || action === 'delete-remote';
        const pullish = action === 'pull' || action === 'delete-local';
        if ((mode === 'pull' && pushish) || (mode === 'push' && pullish)) { results.push({ path: p, action: 'skipped', note: `pendiente (${action})` }); continue; }
        plan.push({ p, action, rem });
    }
    if (opts.fresh && !opts.dryRun && opts.confirmFirstSync && plan.length) {
        const pull = plan.filter((x) => x.action === 'pull').length;
        const push = plan.filter((x) => x.action === 'push').length;
        if (!(await opts.confirmFirstSync({ pull, push, total: plan.length }))) throw new Error('Cancelado: no se ha tocado nada.');
    }
    for (const { p, action, rem } of plan) {
        if (opts.dryRun) { results.push({ path: p, action }); if (action === 'conflict') conflicts.push(p); continue; }
        try {
            const note = await apply(action, p, rem);
            results.push({ path: p, action, note });
            if (action === 'conflict' && !conflicts.includes(p)) conflicts.push(p);
            log(`${action} ${p}`);
        } catch (e) {
            errors++;
            results.push({ path: p, action, error: (e as Error).message });
        }
    }

    // el cursor solo avanza si todo quedó resuelto (con conflictos se reevalúa el delta)
    if (!opts.dryRun && mode !== 'push' && !conflicts.length && !errors && manifest.cursor) state.cursor = manifest.cursor;
    return { results, conflicts, errors, cursor: state.cursor, warnings, serverWarnings };
}
