import {
    App, ButtonComponent, Modal, Notice, Platform, Plugin, PluginSettingTab, Setting, TAbstractFile, requestUrl,
} from 'obsidian';
import type { SyncState } from './core/docs-core';
import { makeIgnore } from './core/docs-core';
import { runSync, SyncReport } from './core/sync';
import { McpMemoryRemote, MemoryInfo, RpcClient, assertSecureApiUrl } from './remote';
import { ObsidianVaultFs } from './vault-fs';
import { agoText, defaultFolder, normalizeFolder, relativeInside } from './folder';

interface RyphosSettings {
    apiUrl: string;
    /** Código de conexión (clave rk_ personal). Solo en data.json; nunca se escribe en logs. */
    key: string;
    memoryId: string;
    memoryName: string;
    folder: string;
    intervalSec: number;
    deviceName: string;
}

interface SyncStore {
    memoryId: string;
    folder: string;
    state: SyncState;
    lastSync?: number;
}

interface PluginData { settings: RyphosSettings; sync?: SyncStore }

const DEFAULTS: RyphosSettings = {
    apiUrl: 'https://api.ryphos.com', key: '', memoryId: '', memoryName: '', folder: '', intervalSec: 30, deviceName: '',
};
const SECRET_ID = 'ryphos-connection-code';
const DEBOUNCE_MS = 1500;
const MIN_INTERVAL = 15;

export default class RyphosPlugin extends Plugin {
    settings: RyphosSettings = { ...DEFAULTS };
    store: SyncStore | undefined;
    private statusEl: HTMLElement | null = null;
    private running = false;
    private again = false;
    private debounce: ReturnType<typeof setTimeout> | null = null;
    private pollId: number | null = null;
    private lastError = '';
    private lastConflicts = 0;

    async onload(): Promise<void> {
        await this.loadPluginData();
        this.statusEl = this.addStatusBarItem();
        this.addSettingTab(new RyphosSettingTab(this.app, this));
        this.addCommand({ id: 'sync-now', name: 'Sincronizar ahora', callback: () => { void this.syncNow(true); } });
        this.registerInterval(window.setInterval(() => this.renderStatus(), 30_000));
        this.app.workspace.onLayoutReady(() => {
            const onChange = (f: TAbstractFile, old?: string): void => this.onVaultEvent(f.path, old);
            this.registerEvent(this.app.vault.on('modify', (f) => onChange(f)));
            this.registerEvent(this.app.vault.on('create', (f) => onChange(f)));
            this.registerEvent(this.app.vault.on('delete', (f) => onChange(f)));
            this.registerEvent(this.app.vault.on('rename', (f, old) => onChange(f, old)));
            this.restartPolling();
            if (this.configured()) this.kick('inicio', 2000);
        });
        this.renderStatus();
    }

    onunload(): void {
        if (this.debounce) clearTimeout(this.debounce);
        if (this.pollId !== null) window.clearInterval(this.pollId);
    }

    // ---------- datos ----------
    private async loadPluginData(): Promise<void> {
        const raw = (await this.loadData()) as Partial<PluginData> | null;
        this.settings = { ...DEFAULTS, ...(raw?.settings || {}) };
        this.store = raw?.sync;
        if (this.settings.key && this.secrets()) { const k = this.settings.key; await this.setKey(k); await this.persist(); }
        if (!this.settings.deviceName) {
            this.settings.deviceName = `${Platform.isMobile ? 'movil' : 'escritorio'}-${Math.random().toString(36).slice(2, 6)}`;
            await this.persist();
        }
    }

    async persist(): Promise<void> {
        await this.saveData({ settings: this.settings, sync: this.store } satisfies PluginData);
    }

    /** Almacén de secretos de Obsidian (>= 1.11.4) si existe; si no, null y la clave va en data.json. */
    private secrets(): { setSecret(id: string, v: string): void; getSecret(id: string): string | null } | null {
        const st = (this.app as unknown as { secretStorage?: { setSecret?: unknown; getSecret?: unknown } }).secretStorage;
        return st && typeof st.setSecret === 'function' && typeof st.getSecret === 'function' ? (st as never) : null;
    }
    usesSecretStorage(): boolean { return this.secrets() !== null; }

    getKey(): string {
        const st = this.secrets();
        if (st) {
            try { const v = st.getSecret(SECRET_ID); if (v) return v; } catch { /* sin secreto */ }
        }
        return this.settings.key;
    }

    async setKey(key: string): Promise<void> {
        const st = this.secrets();
        if (st) {
            try { st.setSecret(SECRET_ID, key); this.settings.key = ''; return; } catch { /* cae a data.json */ }
        }
        this.settings.key = key;
    }

    configured(): boolean {
        return !!(this.getKey() && this.settings.memoryId && this.settings.folder);
    }

    /** Aplica ajustes: si cambia memoria o carpeta, el estado de sync se reinicia (primera sync con confirmación). */
    async applySettings(): Promise<void> {
        if (this.store && (this.store.memoryId !== this.settings.memoryId || this.store.folder !== this.settings.folder)) this.store = undefined;
        await this.persist();
        this.restartPolling();
        this.renderStatus();
    }

    rpc(): RpcClient {
        return new RpcClient(
            { apiUrl: this.settings.apiUrl, key: this.getKey() },
            async (req) => {
                const r = await requestUrl({ url: req.url, method: 'POST', headers: req.headers, body: req.body, throw: false });
                return { status: r.status, text: r.text };
            },
        );
    }

    async listMemories(): Promise<MemoryInfo[]> {
        return new McpMemoryRemote(this.rpc()).listMemories();
    }

    // ---------- programación ----------
    private restartPolling(): void {
        if (this.pollId !== null) window.clearInterval(this.pollId);
        this.pollId = null;
        const sec = Math.max(MIN_INTERVAL, Number(this.settings.intervalSec) || 30);
        this.pollId = window.setInterval(() => this.kick('sondeo', 0), sec * 1000);
        this.registerInterval(this.pollId);
    }

    private onVaultEvent(path: string, oldPath?: string): void {
        if (!this.configured()) return;
        const rels = [path, oldPath].filter((p): p is string => !!p).map((p) => relativeInside(this.settings.folder, p)).filter((r): r is string => r !== null);
        if (!rels.length) return;
        const ignored = makeIgnore();
        if (rels.every((r) => ignored(r))) return;
        this.kick('cambio local', DEBOUNCE_MS);
    }

    private kick(_reason: string, delay: number): void {
        if (!this.configured()) return;
        if (this.debounce) clearTimeout(this.debounce);
        this.debounce = setTimeout(() => { void this.syncNow(false); }, delay);
    }

    // ---------- sincronía ----------
    async syncNow(manual: boolean): Promise<void> {
        if (!this.configured()) {
            if (manual) new Notice('Ryphos: configura el código de conexión, la memoria y la carpeta en los ajustes del plugin.');
            return;
        }
        if (this.running) { this.again = true; return; }
        this.running = true;
        this.renderStatus('sincronizando…');
        try {
            do {
                this.again = false;
                await this.syncOnce(manual);
            } while (this.again);
        } finally { this.running = false; this.renderStatus(); }
    }

    private async syncOnce(manual: boolean): Promise<void> {
        let folder: string;
        try {
            assertSecureApiUrl(this.settings.apiUrl);
            folder = normalizeFolder(this.settings.folder);
        } catch (e) { this.fail((e as Error).message, manual); return; }
        if (!this.store || this.store.memoryId !== this.settings.memoryId || this.store.folder !== folder) {
            this.store = { memoryId: this.settings.memoryId, folder, state: { files: {} } };
        }
        const fresh = !this.store.state.cursor && Object.keys(this.store.state.files).length === 0 && !this.store.lastSync;
        let rep: SyncReport;
        try {
            rep = await runSync({
                fs: new ObsidianVaultFs(this.app, folder),
                state: this.store.state,
                memoryId: this.settings.memoryId,
                remote: new McpMemoryRemote(this.rpc()),
                host: this.settings.deviceName,
                fresh,
                confirmFirstSync: (info) => new ConfirmFirstSync(this.app, folder, info).ask(),
            });
        } catch (e) {
            this.fail((e as Error).message, manual);
            return;
        }
        this.lastError = '';
        this.store.lastSync = Date.now();
        await this.persist();
        for (const w of rep.warnings) console.warn(`[Ryphos] ${w}`);
        if (rep.serverWarnings.length) new Notice(`Ryphos: ${rep.serverWarnings.slice(0, 3).join(' · ')}`, 10_000);
        if (rep.conflicts.length && rep.conflicts.length !== this.lastConflicts) {
            new Notice(`Ryphos: ${rep.conflicts.length} conflicto(s). Revisa los ficheros *.conflict-*.md junto a los originales.`, 10_000);
        }
        this.lastConflicts = rep.conflicts.length;
        if (rep.errors) {
            const first = rep.results.find((r) => r.error);
            this.fail(`${rep.errors} error(es)${first ? `: ${first.path} — ${first.error}` : ''}`, manual);
        } else if (manual) {
            new Notice(rep.results.length ? `Ryphos: sincronizado (${rep.results.length} cambio(s)).` : 'Ryphos: todo sincronizado.');
        }
    }

    private fail(msg: string, manual: boolean): void {
        this.lastError = msg;
        console.warn(`[Ryphos] ${msg}`);
        if (manual) new Notice(`Ryphos: ${msg}`, 8000);
    }

    renderStatus(override?: string): void {
        if (!this.statusEl) return;
        let text: string;
        if (override) text = `Ryphos · ${override}`;
        else if (!this.configured()) text = 'Ryphos · sin configurar';
        else if (this.lastError) text = 'Ryphos · error de sincronía';
        else if (this.store?.lastSync) text = `Ryphos · sincronizado ${agoText(this.store.lastSync)}`;
        else text = 'Ryphos · pendiente';
        this.statusEl.setText(text);
        this.statusEl.title = this.lastError || 'Ryphos: clic derecho en el comando «Sincronizar ahora»';
    }
}

class ConfirmFirstSync extends Modal {
    private resolve!: (v: boolean) => void;
    private done = false;
    constructor(app: App, private readonly folder: string, private readonly info: { pull: number; push: number; total: number }) { super(app); }

    ask(): Promise<boolean> {
        return new Promise((resolve) => { this.resolve = resolve; this.open(); });
    }
    private finish(v: boolean): void { if (this.done) return; this.done = true; this.resolve(v); this.close(); }
    onOpen(): void {
        this.titleEl.setText('Primera sincronización con Ryphos');
        this.contentEl.createEl('p', {
            text: `Se bajarán ${this.info.pull} y se subirán ${this.info.push} nota(s) entre la memoria y la carpeta «${this.folder}». No se tocará nada fuera de esa carpeta.`,
        });
        const row = this.contentEl.createDiv({ cls: 'modal-button-container' });
        new ButtonComponent(row).setButtonText('Continuar').setCta().onClick(() => this.finish(true));
        new ButtonComponent(row).setButtonText('Cancelar').onClick(() => this.finish(false));
    }
    onClose(): void { this.finish(false); }
}

class RyphosSettingTab extends PluginSettingTab {
    constructor(app: App, private readonly plugin: RyphosPlugin) { super(app, plugin); }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();
        const s = this.plugin.settings;

        const keyDesc = this.plugin.usesSecretStorage()
            ? 'En Ryphos: Memorias → Conectar → Obsidian. Se guarda en el almacén de secretos de Obsidian (fuera de la bóveda).'
            : 'En Ryphos: Memorias → Conectar → Obsidian. Se guarda en .obsidian/plugins/ryphos/data.json. Si sincronizas la carpeta .obsidian con iCloud, Dropbox, Obsidian Sync o git, la clave viaja con ella.';
        new Setting(containerEl)
            .setName('Código de conexión')
            .setDesc(keyDesc)
            .addText((t) => {
                t.inputEl.type = 'password';
                t.inputEl.autocomplete = 'off';
                t.setPlaceholder('rk_…').setValue(this.plugin.getKey()).onChange(async (v) => { await this.plugin.setKey(v.trim()); await this.plugin.applySettings(); });
            });

        new Setting(containerEl)
            .setName('URL de la API')
            .setDesc('Por defecto https://api.ryphos.com')
            .addText((t) => t.setValue(s.apiUrl).onChange(async (v) => {
                const url = v.trim().replace(/\/+$/, '');
                try { assertSecureApiUrl(url); s.apiUrl = url; await this.plugin.applySettings(); } catch { /* se valida al guardar un valor correcto */ }
            }));

        const memSetting = new Setting(containerEl)
            .setName('Memoria a sincronizar')
            .setDesc(s.memoryId ? `Seleccionada: ${s.memoryName || s.memoryId}` : 'Pulsa «Cargar» tras introducir el código de conexión.');
        let dd: HTMLSelectElement | null = null;
        memSetting.addDropdown((d) => {
            dd = d.selectEl;
            if (s.memoryId) d.addOption(s.memoryId, s.memoryName || s.memoryId);
            d.setValue(s.memoryId);
            d.onChange(async (id) => {
                const name = dd?.selectedOptions[0]?.text || id;
                s.memoryId = id; s.memoryName = name;
                if (!s.folder || s.folder.startsWith('Ryphos/')) s.folder = defaultFolder(name);
                await this.plugin.applySettings();
                this.display();
            });
        });
        memSetting.addButton((b) => b.setButtonText('Cargar').onClick(async () => {
            try {
                const mems = await this.plugin.listMemories();
                if (!mems.length) { new Notice('Ryphos: no hay memorias en esta cuenta.'); return; }
                if (dd) {
                    dd.empty();
                    for (const m of mems) dd.createEl('option', { value: m.id, text: m.name || m.id });
                    dd.value = mems.some((m) => m.id === s.memoryId) ? s.memoryId : mems[0].id;
                    dd.dispatchEvent(new Event('change'));
                }
            } catch (e) { new Notice(`Ryphos: ${(e as Error).message}`); }
        }));

        new Setting(containerEl)
            .setName('Carpeta de la bóveda')
            .setDesc('Solo se lee y escribe dentro de esta carpeta. Por defecto Ryphos/<memoria>.')
            .addText((t) => {
                t.setPlaceholder('Ryphos/Mi memoria').setValue(s.folder);
                // se aplica al salir del campo (no en cada tecla): evita sincronizar con una carpeta a medio escribir
                t.inputEl.addEventListener('blur', () => {
                    void (async () => {
                        try { s.folder = normalizeFolder(t.getValue()); await this.plugin.applySettings(); }
                        catch (e) { new Notice(`Ryphos: ${(e as Error).message}`); t.setValue(s.folder); }
                    })();
                });
            });

        new Setting(containerEl)
            .setName('Intervalo de sondeo (segundos)')
            .setDesc(`Cada cuánto consulta Ryphos si hay cambios. Mínimo ${MIN_INTERVAL}.`)
            .addText((t) => t.setValue(String(s.intervalSec)).onChange(async (v) => {
                const n = Math.max(MIN_INTERVAL, Math.floor(Number(v)) || 30);
                s.intervalSec = n; await this.plugin.applySettings();
            }));

        new Setting(containerEl)
            .setName('Nombre de este dispositivo')
            .setDesc('Se usa en los ficheros de conflicto: nota.conflict-<dispositivo>.md')
            .addText((t) => t.setValue(s.deviceName).onChange(async (v) => {
                s.deviceName = v.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 30) || s.deviceName; await this.plugin.persist();
            }));

        new Setting(containerEl).addButton((b) => b.setButtonText('Sincronizar ahora').setCta().onClick(() => { void this.plugin.syncNow(true); }));
    }
}
