import type { Manifest, MemoryRemote, ReadResult, WriteResult } from './core/sync';

/** Petición HTTP mínima (el plugin inyecta `requestUrl` de Obsidian; los tests, un falso). */
export type HttpPost = (req: { url: string; headers: Record<string, string>; body: string }) => Promise<{ status: number; text: string }>;

/** La API debe ser https://, salvo desarrollo local: evita enviar la clave en claro. */
export function assertSecureApiUrl(apiUrl: string): void {
    let u: URL;
    try { u = new URL(apiUrl); } catch { throw new Error(`URL de la API no válida: ${apiUrl}`); }
    if (u.protocol === 'https:') return;
    if (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) return;
    throw new Error('La URL de la API debe ser https:// (http:// solo para localhost).');
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Mensaje JSON-RPC ya validado en forma. */
export interface RpcMessage { result?: unknown; error?: Obj }

function hasOutcome(v: unknown): v is RpcMessage {
    return isObj(v) && (v['result'] !== undefined || v['error'] !== undefined);
}

function pickRpc(j: unknown): RpcMessage | undefined {
    if (Array.isArray(j)) return (j as unknown[]).find(hasOutcome);
    return hasOutcome(j) ? j : undefined;
}

function parseJson(text: string): unknown {
    return JSON.parse(text) as unknown;
}

/** Extrae el mensaje JSON-RPC de una respuesta JSON o SSE (`data:`). Devuelve el último objeto con result/error. */
export function parseRpcBody(text: string): RpcMessage {
    const t = text.trim();
    if (!t) throw new Error('Respuesta vacía del servidor');
    if (t.startsWith('{') || t.startsWith('[')) {
        let parsed: unknown;
        try { parsed = parseJson(t); } catch { throw new Error('Respuesta no válida del servidor'); }
        const msg = pickRpc(parsed);
        if (!msg) throw new Error('Respuesta no válida del servidor');
        return msg;
    }
    let found: RpcMessage | undefined;
    for (const line of t.split(/\r?\n/)) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        try {
            const j = pickRpc(parseJson(payload));
            if (j) found = j;
        } catch { /* línea que no es JSON: se ignora */ }
    }
    if (!found) throw new Error('Respuesta no válida del servidor');
    return found;
}

/** Texto de un resultado de tool; lanza si isError. */
export function toolText(result: unknown): string {
    if (!isObj(result)) return '';
    const content = Array.isArray(result['content']) ? (result['content'] as unknown[]) : [];
    const first = content.find((c): c is Obj => isObj(c) && c['type'] === 'text' && typeof c['text'] === 'string')
        ?? content.find((c): c is Obj => isObj(c) && typeof c['text'] === 'string');
    const text = first ? (first['text'] as string) : '';
    if (result['isError']) throw new Error(text || 'La herramienta devolvió un error');
    return text;
}

export class RpcClient {
    private seq = 0;
    constructor(private readonly cfg: { apiUrl: string; key: string }, private readonly post: HttpPost, private readonly timeoutMs = 60_000) {}

    /** Llama a una tool y devuelve su JSON. Nunca incluye la clave en los mensajes de error. */
    async call(name: string, args: Record<string, unknown>): Promise<unknown> {
        assertSecureApiUrl(this.cfg.apiUrl);
        if (!this.cfg.key) throw new Error('Falta el código de conexión de Ryphos.');
        const body = JSON.stringify({ jsonrpc: '2.0', id: ++this.seq, method: 'tools/call', params: { name, arguments: args } });
        let timer: number | undefined;
        const timeout = new Promise<never>((_, rej) => { timer = window.setTimeout(() => rej(new Error('Tiempo de espera agotado al hablar con Ryphos')), this.timeoutMs); });
        let res: { status: number; text: string };
        try {
            res = await Promise.race([
                this.post({
                    url: `${this.cfg.apiUrl.replace(/\/+$/, '')}/mcp`,
                    headers: {
                        Authorization: `Bearer ${this.cfg.key}`,
                        'Content-Type': 'application/json',
                        Accept: 'application/json, text/event-stream',
                    },
                    body,
                }),
                timeout,
            ]);
        } catch (e) {
            throw new Error(`No se pudo contactar con Ryphos (${(e as Error).message.replace(this.cfg.key, '***')})`);
        } finally { if (timer !== undefined) window.clearTimeout(timer); }
        // requestUrl sigue redirecciones sin dejarnos inspeccionarlas: no podemos garantizar que Authorization no vaya a un destino http,
        // así que cualquier 3xx es error (y, por si acaso, la clave solo se envía a una URL https o localhost)
        if (res.status >= 300 && res.status < 400) throw new Error('El servidor respondió con una redirección; revisa la URL de la API (debe apuntar directamente a la API).');
        if (res.status === 401 || res.status === 403) throw new Error('Código de conexión no válido o sin permisos de memorias.');
        if (res.status >= 400) {
            let msg = `HTTP ${res.status}`;
            try {
                const m = parseRpcBody(res.text).error?.['message'];
                if (typeof m === 'string' && m) msg += `: ${m}`;
            } catch { /* sin detalle */ }
            throw new Error(msg);
        }
        const rpc = parseRpcBody(res.text);
        if (rpc.error) {
            const m = rpc.error['message'];
            throw new Error(typeof m === 'string' && m ? m : 'Error del servidor');
        }
        const text = toolText(rpc.result);
        try { return parseJson(text); }
        catch { throw new Error(`Respuesta no válida del servidor: ${text.slice(0, 200)}`); }
    }
}

export interface MemoryInfo { id: string; name: string }

/** Implementación real de MemoryRemote sobre las tools ryphos_memory_*. */
export class McpMemoryRemote implements MemoryRemote {
    constructor(private readonly rpc: RpcClient) {}
    async manifest(memoryId: string, since?: string): Promise<Manifest> {
        return (await this.rpc.call('ryphos_memory_manifest', since ? { memoryId, since } : { memoryId })) as Manifest;
    }
    async read(memoryId: string, sel: { id?: string; path?: string }): Promise<ReadResult> {
        const args: Record<string, unknown> = { memoryId };
        if (sel.id) args['pageId'] = sel.id; else if (sel.path) args['path'] = sel.path;
        return (await this.rpc.call('ryphos_memory_read', args)) as ReadResult;
    }
    async write(memoryId: string, path: string, markdown: string, baseRevision?: number): Promise<WriteResult> {
        const args: Record<string, unknown> = { memoryId, path, markdown };
        if (baseRevision !== undefined) args['baseRevision'] = baseRevision;
        return (await this.rpc.call('ryphos_memory_write', args)) as WriteResult;
    }
    remove(memoryId: string, path: string, baseRevision: number): Promise<unknown> {
        return this.rpc.call('ryphos_memory_delete', { memoryId, path, baseRevision });
    }
    async listMemories(): Promise<MemoryInfo[]> {
        return parseMemories(await this.rpc.call('ryphos_memory_list', {}));
    }
}

/** Tolera `[…]` o `{memories:[…]}`. */
export function parseMemories(json: unknown): MemoryInfo[] {
    let arr: unknown = json;
    if (isObj(json)) arr = json['memories'] ?? json['items'] ?? [];
    if (!Array.isArray(arr)) return [];
    const out: MemoryInfo[] = [];
    for (const m of arr as unknown[]) {
        if (!isObj(m)) continue;
        const id = typeof m['id'] === 'string' || typeof m['id'] === 'number' ? String(m['id']) : '';
        if (!id) continue;
        out.push({ id, name: typeof m['name'] === 'string' ? m['name'] : '' });
    }
    return out;
}
