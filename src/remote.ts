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

/** Extrae el mensaje JSON-RPC de una respuesta JSON o SSE (`data:`). Devuelve el último objeto con result/error. */
export function parseRpcBody(text: string): any {
    const t = text.trim();
    if (!t) throw new Error('Respuesta vacía del servidor');
    if (t.startsWith('{') || t.startsWith('[')) {
        try { return pickRpc(JSON.parse(t)); } catch (e) { if (t.startsWith('{')) throw new Error('Respuesta no válida del servidor'); throw e; }
    }
    let found: any;
    for (const line of t.split(/\r?\n/)) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        try {
            const j = pickRpc(JSON.parse(payload));
            if (j && (j.result !== undefined || j.error !== undefined)) found = j;
        } catch { /* línea que no es JSON: se ignora */ }
    }
    if (!found) throw new Error('Respuesta no válida del servidor');
    return found;
}

function pickRpc(j: any): any {
    if (Array.isArray(j)) return j.find((x) => x && (x.result !== undefined || x.error !== undefined));
    return j;
}

/** Texto de un resultado de tool; lanza si isError. */
export function toolText(result: any): string {
    const text = result?.content?.find?.((c: any) => c?.type === 'text')?.text ?? result?.content?.[0]?.text ?? '';
    if (result?.isError) throw new Error(String(text || 'La herramienta devolvió un error'));
    return String(text);
}

export class RpcClient {
    private seq = 0;
    constructor(private readonly cfg: { apiUrl: string; key: string }, private readonly post: HttpPost, private readonly timeoutMs = 60_000) {}

    /** Llama a una tool y devuelve su JSON. Nunca incluye la clave en los mensajes de error. */
    async call(name: string, args: Record<string, unknown>): Promise<any> {
        assertSecureApiUrl(this.cfg.apiUrl);
        if (!this.cfg.key) throw new Error('Falta el código de conexión de Ryphos.');
        const body = JSON.stringify({ jsonrpc: '2.0', id: ++this.seq, method: 'tools/call', params: { name, arguments: args } });
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error('Tiempo de espera agotado al hablar con Ryphos')), this.timeoutMs); });
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
        } finally { if (timer) clearTimeout(timer); }
        // requestUrl sigue redirecciones sin dejarnos inspeccionarlas: no podemos garantizar que Authorization no vaya a un destino http,
        // así que cualquier 3xx es error (y, por si acaso, la clave solo se envía a una URL https o localhost)
        if (res.status >= 300 && res.status < 400) throw new Error('El servidor respondió con una redirección; revisa la URL de la API (debe apuntar directamente a la API).');
        if (res.status === 401 || res.status === 403) throw new Error('Código de conexión no válido o sin permisos de memorias.');
        if (res.status >= 400) {
            let msg = `HTTP ${res.status}`;
            try { const j = parseRpcBody(res.text); if (j?.error?.message) msg += `: ${j.error.message}`; } catch { /* sin detalle */ }
            throw new Error(msg);
        }
        const rpc = parseRpcBody(res.text);
        if (rpc.error) throw new Error(String(rpc.error.message || 'Error del servidor'));
        const text = toolText(rpc.result);
        try { return JSON.parse(text); }
        catch { throw new Error(`Respuesta no válida del servidor: ${text.slice(0, 200)}`); }
    }
}

export interface MemoryInfo { id: string; name: string }

/** Implementación real de MemoryRemote sobre las tools ryphos_memory_*. */
export class McpMemoryRemote implements MemoryRemote {
    constructor(private readonly rpc: RpcClient) {}
    manifest(memoryId: string, since?: string): Promise<Manifest> {
        return this.rpc.call('ryphos_memory_manifest', since ? { memoryId, since } : { memoryId });
    }
    read(memoryId: string, sel: { id?: string; path?: string }): Promise<ReadResult> {
        const args: Record<string, unknown> = { memoryId };
        if (sel.id) args['pageId'] = sel.id; else if (sel.path) args['path'] = sel.path;
        return this.rpc.call('ryphos_memory_read', args);
    }
    write(memoryId: string, path: string, markdown: string, baseRevision?: number): Promise<WriteResult> {
        const args: Record<string, unknown> = { memoryId, path, markdown };
        if (baseRevision !== undefined) args['baseRevision'] = baseRevision;
        return this.rpc.call('ryphos_memory_write', args);
    }
    remove(memoryId: string, path: string, baseRevision: number): Promise<unknown> {
        return this.rpc.call('ryphos_memory_delete', { memoryId, path, baseRevision });
    }
    async listMemories(): Promise<MemoryInfo[]> {
        return parseMemories(await this.rpc.call('ryphos_memory_list', {}));
    }
}

/** Tolera `[…]` o `{memories:[…]}`. */
export function parseMemories(json: any): MemoryInfo[] {
    const arr = Array.isArray(json) ? json : (json?.memories ?? json?.items ?? []);
    if (!Array.isArray(arr)) return [];
    return arr.map((m: any) => ({ id: String(m?.id ?? ''), name: String(m?.name ?? '') })).filter((m) => m.id);
}
