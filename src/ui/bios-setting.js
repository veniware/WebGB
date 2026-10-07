import { deleteFile, getFile, putFile } from '../storage/files.js';
import { crc32 } from '../util/crc32.js';
import { pickFiles } from './dom.js';
import { BIOS_ACCEPT, GBA_BIOS_SIZE } from './files.js';

const FILE_NAME = 'gba-bios';
// CRC32s of known dumps.
const KNOWN = {
  0x81977335: 'Game Boy Advance BIOS',
  0xa6473709: 'Nintendo DS BIOS (GBA mode)',
};

/**
 * The GBA BIOS file in the settings: load (kept in IndexedDB) or remove.
 *
 * @param {{
 *   onChange: (bios: Uint8Array | null) => void,
 *   onStatus: (text: string) => void,
 *   onError: (err: unknown) => void,
 * }} deps
 */
export function setupBiosSetting({ onChange, onStatus, onError }) {
  const status = document.getElementById('gba-bios-status');
  const remove = document.getElementById('gba-bios-remove');

  function show(bios) {
    status.textContent = bios ? KNOWN[crc32(bios) >>> 0] ?? 'BIOS file' : 'Built in';
    remove.hidden = !bios;
    onChange(bios);
  }

  document.getElementById('gba-bios-load').addEventListener('click', async () => {
    const [file] = await pickFiles({ accept: BIOS_ACCEPT });
    if (!file) return;
    try {
      if (file.size !== GBA_BIOS_SIZE) throw new Error(`${file.name} is not a GBA BIOS (it should be 16 KB).`);
      const bios = new Uint8Array(await file.arrayBuffer());
      await putFile(FILE_NAME, bios);
      show(bios);
      onStatus('BIOS file loaded. It is used from the next start of a GBA game.');
    } catch (err) {
      onError(err);
    }
  });

  remove.addEventListener('click', async () => {
    try {
      await deleteFile(FILE_NAME);
      show(null);
    } catch (err) {
      onError(err);
    }
  });

  getFile(FILE_NAME).then(show, () => {});
}
