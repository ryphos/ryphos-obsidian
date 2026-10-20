import ignore from 'ignore';
import { sha256Hex } from './sha256';

/**
 * Lógica PURA de la sincronía a tres bandas (sin E/S). Copia adaptada de ryphos-cli/src/docs-core.ts: el hash usa SHA-256 en JS puro (sin node:crypto) para funcionar en móvil: hash, rutas seguras, ignorados y decisión.
 */

/**
 * Quita el bloque de frontmatter inicial (--- … ---) y normaliza CRLF→LF.
 * Copia EXACTA de `splitFrontmatter` del servidor (pandup-manager-api wiki/util/wiki-markdown.util.ts).
 */
export function stripFrontmatter(markdown: string): string {
    const text = markdown.replace(/\r\n?/g, '\n').replace(/^﻿/, '');
    if (!text.startsWith('---\n')) return text;
    const end = text.indexOf('\n---', 3);
    if (end < 0) return text;
    const after = text.slice(end + 4);
    if (after.length && !after.startsWith('\n')) return text;
    return after.replace(/^\n+/, '');
}

/**
 * Hash de contenido: sha256 hex del cuerpo sin frontmatter, LF y sin blancos en los extremos.
 * DEBE coincidir con `hashMarkdown`/`normalizeMarkdownBody` del servidor (es el `hash` del manifiesto):
 * si cambia allí, se cambia aquí y solo aquí.
 */
export function hashMarkdown(markdown: string): string {
    const stripped = stripFrontmatter(markdown).replace(/^\n+/, '');
    // Equivale a .replace(/\s+$/, '') pero en tiempo lineal (esa regex es cuadrática con muchos blancos: ReDoS).
    let end = stripped.length;
    while (end > 0 && /\s/.test(stripped[end - 1])) end--;
    const body = stripped.slice(0, end);
    return sha256Hex(body);
}

/** Ficheros de instrucciones de agentes de IA: nunca se bajan ni se suben (vector de inyección en el equipo). */
const AGENT_FILES = new Set(['claude.md', 'agents.md', 'gemini.md', 'copilot-instructions.md', '.clinerules', '.cursorrules']);
const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** ¿El nombre (un segmento) es un fichero/carpeta de instrucciones de agentes? Sin distinguir mayúsculas. */
export function isAgentInstructionName(seg: string): boolean {
    const s = seg.toLowerCase();
    return AGENT_FILES.has(s) || s.startsWith('.claude') || s.startsWith('.cursor') || s.startsWith('.github')
        || s.startsWith('.windsurf') || s === '.clinerules';
}

/** Motivo por el que un segmento de ruta no es válido, o null. */
export function segmentProblem(seg: string): string | null {
    if (seg === '' || seg === '.' || seg === '..') return 'segmento vacío o relativo';
    if (seg.startsWith('.')) return 'nombre oculto (empieza por ".")';
    if (isAgentInstructionName(seg)) return 'fichero de instrucciones de agentes';
    // eslint-disable-next-line no-control-regex
    if (/[<>:"|?*\u0000-\u001f]/.test(seg)) return 'caracteres no válidos';
    if (seg.endsWith(' ') || seg.endsWith('.')) return 'termina en espacio o punto';
    if (WIN_RESERVED.test(seg.split('.')[0])) return 'nombre reservado de Windows';
    return null;
}

/** Motivo por el que una ruta de documentación no es válida, o null. */
export function pathProblem(p: unknown): string | null {
    if (typeof p !== 'string' || !p) return 'vacía';
    if (p.length > 300) return 'demasiado larga';
    if (p.includes('\0') || p.includes('\\') || p.startsWith('/') || /^[A-Za-z]:/.test(p)) return 'absoluta o con separadores no válidos';
    for (const seg of p.split('/')) { const r = segmentProblem(seg); if (r) return r; }
    if (!p.toLowerCase().endsWith('.md')) return 'no es .md';
    return null;
}

/** Valida una ruta del servidor: relativa, con '/', sin segmentos ocultos/peligrosos, termina en .md. */
export function safeDocPath(p: unknown): string | null {
    return pathProblem(p) ? null : (p as string);
}

/** Clave de comparación sin distinguir mayúsculas (NFC + minúsculas) para detectar colisiones. */
export function collisionKey(p: string): string {
    return p.normalize('NFC').toLowerCase();
}

const CONFLICT_RE = /\.conflict-[^/]*\.md$/i;

/** Nombre del fichero de conflicto: <nombre>.conflict-<host>.md */
export function conflictPath(rel: string, host: string): string {
    const safeHost = host.replace(/[^A-Za-z0-9_-]/g, '-') || 'host';
    return rel.replace(/\.md$/i, '') + `.conflict-${safeHost}.md`;
}

/**
 * Predicado de ignorados: .obsidian/, .trash/, .ryphos, .git, no .md, *.conflict-*.md y .ryphosignore.
 * `isDir` evita aplicar la regla de extensión a carpetas.
 */
export function makeIgnore(ryphosIgnoreText = ''): (rel: string, isDir?: boolean) => boolean {
    const ig = ignore();
    ig.add(['.ryphos', '.git']);
    ig.add(ryphosIgnoreText);
    return (rel: string, isDir = false) => {
        const segs = rel.split('/');
        if (segs.includes('.obsidian') || segs.includes('.trash')) return true;
        if (segs.some((s) => s.startsWith('.') || isAgentInstructionName(s))) return true; // ocultos y agentes: nunca se sincronizan
        if (isDir) return ig.ignores(`${rel}/`);
        if (!rel.toLowerCase().endsWith('.md')) return true;
        if (CONFLICT_RE.test(rel)) return true;
        return ig.ignores(rel);
    };
}

export interface StateFile { id?: string; revision: number; hash: string }
export interface SyncState { cursor?: string; files: Record<string, StateFile> }
export interface LocalInfo { hash: string }
export interface RemoteInfo { id?: string; revision: number; hash: string; deleted?: boolean }

export type Action =
    | 'noop'
    | 'push'          // subir (crear o actualizar)
    | 'pull'          // bajar
    | 'delete-remote' // borrado local → borrar en servidor
    | 'delete-local'  // borrado remoto → borrar en disco
    | 'adopt'         // ambos iguales → solo registrar estado
    | 'forget'        // borrado en ambos → limpiar estado
    | 'conflict';

/**
 * Decisión a tres bandas para UN fichero.
 * - `state`: lo registrado en la última sincronía (undefined = nunca visto).
 * - `local`: undefined = no existe en disco.
 * - `remote`: undefined = sin cambios/ausente; `deleted:true` = tombstone.
 *   «Remoto cambiado» = revisión distinta de la registrada.
 */
export function decide(state: StateFile | undefined, local: LocalInfo | undefined, remote: RemoteInfo | undefined): Action {
    const remoteDeleted = !!remote?.deleted;
    const remoteLive = remote && !remote.deleted ? remote : undefined;

    if (!state) {
        if (local && remoteLive) return local.hash === remoteLive.hash ? 'adopt' : 'conflict';
        if (local) return 'push';
        if (remoteLive) return 'pull';
        return 'noop';
    }

    const localDeleted = !local;
    const localChanged = !!local && local.hash !== state.hash;
    const remoteChanged = !!remoteLive && remoteLive.revision !== state.revision;

    if (localDeleted && remoteDeleted) return 'forget';
    if (localDeleted) return remoteChanged ? 'pull' : 'delete-remote'; // si el remoto cambió, nadie pierde trabajo: se restaura
    if (remoteDeleted) return localChanged ? 'push' : 'delete-local'; // editado localmente → se vuelve a crear
    if (localChanged && remoteChanged) return local!.hash === remoteLive!.hash ? 'adopt' : 'conflict';
    if (localChanged) return 'push';
    if (remoteChanged) return 'pull';
    return 'noop';
}
