/** Valida y normaliza la carpeta de la bóveda donde se sincroniza la memoria (relativa, sin '..', sin ocultos). */
export function normalizeFolder(input: string): string {
    const norm = String(input ?? '').replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/+|\/+$/g, '');
    if (!norm) throw new Error('Indica una carpeta de la bóveda (no puede ser la raíz de la bóveda).');
    if (/^[A-Za-z]:/.test(norm)) throw new Error('La carpeta debe ser relativa a la bóveda.');
    for (const seg of norm.split('/')) {
        // eslint-disable-next-line no-control-regex
        if (seg === '.' || seg === '..' || seg.startsWith('.') || /[<>:"|?*\u0000-\u001f]/.test(seg) || seg.endsWith(' ') || seg.endsWith('.')) {
            throw new Error(`Carpeta no permitida: "${input}" (relativa, sin "..", sin nombres ocultos ni caracteres no válidos).`);
        }
    }
    return norm;
}

/** Carpeta por defecto: Ryphos/<memoria> con el nombre saneado. */
export function defaultFolder(memoryName: string): string {
    // eslint-disable-next-line no-control-regex
    const safe = memoryName.replace(/[<>:"|?*\\/\u0000-\u001f]/g, '-').replace(/^\.+/, '').replace(/[ .]+$/, '').trim() || 'Memoria';
    return `Ryphos/${safe}`;
}

/** ¿`path` (de la bóveda) está dentro de `folder`? Devuelve la ruta relativa o null. */
export function relativeInside(folder: string, path: string): string | null {
    const p = path.replace(/\\/g, '/');
    return p.startsWith(folder + '/') ? p.slice(folder.length + 1) : null;
}

/** Texto «hace X» para la barra de estado. */
export function agoText(ms: number, now = Date.now()): string {
    const s = Math.max(0, Math.round((now - ms) / 1000));
    if (s < 10) return 'ahora mismo';
    if (s < 60) return `hace ${s} s`;
    const m = Math.round(s / 60);
    if (m < 60) return `hace ${m} min`;
    const h = Math.round(m / 60);
    if (h < 48) return `hace ${h} h`;
    return `hace ${Math.round(h / 24)} d`;
}
