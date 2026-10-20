# Ryphos for Obsidian

Syncs a **Ryphos memory** with a folder in your vault, in both directions. What you write in Obsidian shows up in Ryphos (and is available to your AI assistant);
what your AI saves or you edit on the web shows up in your vault. Works on desktop and mobile.

- Markdown files only; changes are synced shortly after you edit, plus a periodic check (every 30 s by default).
- If the same note changes in two places at once, nothing is overwritten: the other version is saved as `note.conflict-<device>.md`.
- Files are only read and written inside the folder you choose.

## Install
- **Community plugins**: Settings, Community plugins, search for "Ryphos".
- **Manual**: copy `main.js` and `manifest.json` to `<vault>/.obsidian/plugins/ryphos/` and enable it.
- **BRAT**: add this repository as a beta plugin.

## Connect
1. In Ryphos open Memories, Connect, Obsidian and copy the connection code.
2. In Obsidian open the plugin settings, paste the code, press Load and pick the memory.
3. The first sync shows how many notes will be downloaded and uploaded and asks for confirmation.

## Network use and account
- **Requires a Ryphos account.** The free plan includes 1 memory and 200 pages; paid plans allow more.
- The plugin connects **only to `https://api.ryphos.com/mcp`** (or the API URL you configure; plain http is accepted only for localhost) to list your memories and to read and write the pages of the memory you selected.
- It **sends the content of the `.md` files** inside the synced folder (and their paths) to Ryphos, and downloads the pages of that memory into the folder. Nothing outside the folder is read.
- **No telemetry and no analytics.** There are no other network requests.
- **Where the connection code is stored**: in the Obsidian secret storage (Obsidian 1.11.4 or newer). On older versions it is stored in `.obsidian/plugins/ryphos/data.json` inside your vault, so exclude that file if you sync your `.obsidian` folder. You can revoke the code in Ryphos at any time.
- Server redirects (3xx) are treated as errors so the code is never sent to an unexpected destination.

License: MIT.

---

# Versión en español


Plugin que sincroniza una **memoria de Ryphos** con una carpeta de tu bóveda de Obsidian, en ambos sentidos:
lo que escribes en Obsidian aparece en Ryphos (y lo ve tu IA) y lo que guarda tu IA o editas en la web aparece en Obsidian.
Funciona en escritorio y en móvil.

## Instalación

### Manual
1. Descarga `main.js` y `manifest.json` de la última release (o compílalos: `npm install && npm run build`).
2. Cópialos a `<tu-boveda>/.obsidian/plugins/ryphos/`.
3. En Obsidian: Ajustes → Complementos de la comunidad → activa «Ryphos».

### Con BRAT
1. Instala el plugin **BRAT** (Obsidian42 - BRAT) desde Complementos de la comunidad.
2. BRAT → «Add Beta plugin» → pega `https://github.com/ryphos/ryphos-obsidian`.
3. Activa «Ryphos» en Complementos de la comunidad.

## Conectar con tu cuenta
1. En Ryphos abre **Memorias → Conectar → Obsidian**. Se genera un **código de conexión** (clave personal `rk_…`, solo da acceso a tus memorias).
2. En Obsidian: Ajustes → Ryphos → pega el **código de conexión**.
3. Pulsa **Cargar** y elige la **memoria**. La carpeta por defecto es `Ryphos/<nombre de la memoria>`.
4. La primera vez se muestra cuántas notas se bajarán y subirán y pide confirmación.

Trata el código como una contraseña. **Dónde se guarda**: con Obsidian 1.11.4 o superior se usa el almacén de secretos de Obsidian
(fuera de la bóveda; el plugin lo detecta solo, la versión mínima sigue siendo 1.5.0). En versiones anteriores se guarda en
`.obsidian/plugins/ryphos/data.json`, **dentro de la bóveda**: si sincronizas la carpeta `.obsidian` con iCloud, Dropbox, Obsidian Sync o git, la clave viaja con ella
(excluye `plugins/ryphos/data.json` o actualiza Obsidian). Puedes revocarla en Ryphos cuando quieras.

## Ajustes
| Ajuste | Descripción |
|---|---|
| Código de conexión | Clave `rk_…` personal. |
| URL de la API | Por defecto `https://api.ryphos.com` (`http://` solo para `localhost`). |
| Memoria | Desplegable cargado con `ryphos_memory_list`. |
| Carpeta de la bóveda | Solo se lee y escribe dentro de ella. Relativa, sin `..`. |
| Intervalo de sondeo | 30 s por defecto, mínimo 15 s. |
| Nombre del dispositivo | Para los ficheros de conflicto. |

## Cómo sincroniza
- Al editar, crear, borrar o renombrar una nota (espera 1,5 s) y cada N segundos consulta cambios en Ryphos.
- Barra de estado: «Ryphos · sincronizado hace X». Comando: **Ryphos: Sincronizar ahora**.
- **Conflictos**: si editas la misma nota en dos sitios a la vez, no se pierde nada: se guarda la versión de Ryphos como
  `nota.conflict-<dispositivo>.md` y se avisa. Deja `nota.md` con el contenido que quieras (o bórralo para quedarte con el de Ryphos) y vuelve a sincronizar.
  Los ficheros `*.conflict-*.md` nunca se suben.
- Los borrados se propagan; lo que Ryphos borra va a la papelera de Obsidian (según tu ajuste de «Archivos eliminados»).
- Renombrar una nota equivale a borrar la antigua y crear la nueva.
- Los `[[enlaces]]` por título funcionan igual en Obsidian y en Ryphos.

## Seguridad
- Nunca se escribe fuera de la carpeta configurada; las rutas del servidor se validan (sin `..`, absolutas, ocultas, nombres reservados de Windows, colisiones de mayúsculas).
- Nunca se sincronizan ficheros de instrucciones de agentes (`CLAUDE.md`, `AGENTS.md`, `.cursor*`, `.github*`…), `.obsidian/`, `.trash/`, adjuntos que no sean `.md` ni ficheros ocultos.
- La Vault API de Obsidian no ve ficheros ocultos, así que `.ryphosignore` y la comprobación de `.git` no aplican en el plugin (los ocultos nunca se sincronizan). Usa una carpeta dedicada.
- Cualquier respuesta 3xx se trata como error (Obsidian no deja inspeccionar las redirecciones y no queremos reenviar la clave a un destino inesperado).
- Si el servidor avisa de secretos enmascarados al guardar una nota, se muestra un aviso.
- La clave solo viaja en la cabecera `Authorization` a tu API (HTTPS) y nunca se escribe en la consola.

## Desarrollo
```bash
npm install
npm run build   # genera main.js
npm test        # node:test + tsx (decisión, rutas, paridad de hash, sync con servidor y bóveda falsos)
```
El hash de contenido es SHA-256 en JS puro, idéntico al del servidor y al del CLI (`ryphos`): hay un test de paridad con los mismos fixtures.
