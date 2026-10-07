import { formatSize, h } from './dom.js';

// Bytes per page.
const PAGE = 256;
// Panels at least this wide (px) show 16 bytes per row, narrower ones 8.
const WIDE = 600;

/**
 * Memory viewer/editor: the running game's memory regions (see
 * Core.getMemoryRegions) as hex, a page at a time. The game is paused while
 * it's open; bytes are edited by typing two hex digits.
 *
 * @param {{
 *   dialog: HTMLDialogElement,
 *   modals: ReturnType<typeof import('./modals.js').createModals>,
 *   emulator: import('../app/emulator.js').Emulator,
 * }} deps
 */
export function createMemoryDialog({ dialog, modals, emulator }) {
  const select = dialog.querySelector('[data-region]');
  const address = dialog.querySelector('[data-address]');
  const grid = dialog.querySelector('[data-grid]');
  const range = dialog.querySelector('[data-range]');
  /** @type {import('../core/interface.js').MemoryRegion[]} */
  let regions = [];
  let region = null;
  // Offset of the page's first byte.
  let start = 0;
  let columns = 16;
  let digits = 4;
  // The page's byte inputs, by offset - start.
  let inputs = [];
  let texts = [];

  const hex = (value, width) => value.toString(16).toUpperCase().padStart(width, '0');

  function choose(index) {
    region = regions[index];
    start = 0;
    digits = Math.max(4, hex(region.base + region.size - 1, 1).length);
    render();
  }

  function render() {
    columns = dialog.clientWidth >= WIDE ? 16 : 8;
    const end = Math.min(start + PAGE, region.size);
    inputs = [];
    texts = [];
    const rows = [];
    for (let row = start; row < end; row += columns) {
      const bytes = [];
      for (let offset = row; offset < Math.min(row + columns, end); offset++) bytes.push(byteInput(offset));
      const text = h('span', { className: 'text' });
      texts.push(text);
      rows.push(h('div', { className: 'row' }, h('span', { className: 'address', textContent: hex(region.base + row, digits) }),
        ...bytes, text));
    }
    grid.replaceChildren(...rows);
    range.textContent = `${hex(region.base + start, digits)}–${hex(region.base + end - 1, digits)} of ${formatSize(region.size)}`
      + (region.write ? '' : ' (read-only)');
    dialog.querySelector('[data-prev]').disabled = start === 0;
    dialog.querySelector('[data-next]').disabled = end >= region.size;
    refresh();
  }

  function byteInput(offset) {
    const input = h('input', {
      className: 'byte',
      maxLength: 2,
      spellcheck: false,
      autocomplete: 'off',
      autocapitalize: 'characters',
      readOnly: !region.write,
      ariaLabel: hex(region.base + offset, digits),
      onfocus: () => input.select(),
      oninput: () => {
        if (input.value.length === 2) commit(offset, input, true);
      },
      onchange: () => input.value !== input.defaultValue && commit(offset, input, false),
      onkeydown: (e) => {
        if (e.key === 'Enter') commit(offset, input, true);
        // Esc puts the value back instead of closing the dialog.
        else if (e.key === 'Escape' && input.value !== input.defaultValue) {
          e.preventDefault();
          input.value = input.defaultValue;
        }
      },
    });
    inputs.push(input);
    return input;
  }

  function commit(offset, input, advance) {
    if (/^[0-9a-f]{1,2}$/i.test(input.value) && region.write) {
      region.write(offset, parseInt(input.value, 16));
      refresh();
    } else {
      input.value = input.defaultValue;
    }
    if (advance) inputs[offset - start + 1]?.focus();
  }

  /** Re-reads the page (a write can change other bytes, e.g. I/O registers). */
  function refresh() {
    let chars = '';
    inputs.forEach((input, i) => {
      const value = region.read(start + i);
      input.value = input.defaultValue = value < 0 ? '--' : hex(value, 2);
      // Write-only registers read as --, but can still be written.
      input.disabled = value < 0 && !region.write;
      chars += value >= 0x20 && value < 0x7f ? String.fromCharCode(value) : '.';
      if ((i + 1) % columns === 0 || i === inputs.length - 1) {
        texts[Math.floor(i / columns)].textContent = chars;
        chars = '';
      }
    });
  }

  function go(text) {
    const value = parseInt(text.replace(/^0x/i, ''), 16);
    if (!Number.isFinite(value)) return;
    // An address in the region, or else an offset into it.
    const offset = value >= region.base && value < region.base + region.size ? value - region.base : value;
    if (offset >= region.size) {
      address.setCustomValidity('Not in this region');
      address.reportValidity();
      return;
    }
    start = offset - (offset % PAGE);
    render();
    inputs[offset - start]?.focus();
  }

  select.addEventListener('change', () => choose(Number(select.value)));
  address.addEventListener('input', () => address.setCustomValidity(''));
  address.addEventListener('keydown', (e) => e.key === 'Enter' && go(address.value));
  dialog.querySelector('[data-go]').addEventListener('click', () => go(address.value));
  dialog.querySelector('[data-prev]').addEventListener('click', () => {
    start = Math.max(0, start - PAGE);
    render();
  });
  dialog.querySelector('[data-next]').addEventListener('click', () => {
    start += PAGE;
    render();
  });
  dialog.querySelector('[data-frame]').addEventListener('click', () => {
    emulator.stepFrame();
    refresh();
  });
  dialog.querySelector('[data-close]').addEventListener('click', () => dialog.close());
  window.addEventListener('resize', () => {
    if (dialog.open && region && (dialog.clientWidth >= WIDE ? 16 : 8) !== columns) render();
  });

  return {
    /** Whether the running game has memory to show. */
    get available() {
      return Boolean(emulator.core?.getMemoryRegions);
    },

    open() {
      if (!this.available) return;
      const previous = region?.name;
      regions = emulator.core.getMemoryRegions();
      select.replaceChildren(...regions.map((r, i) => new Option(r.name, String(i))));
      const index = Math.max(0, regions.findIndex((r) => r.name === previous));
      select.value = String(index);
      modals.show(dialog);
      const keep = start;
      choose(index);
      // Back on the same page when reopened on the same region.
      if (regions[index].name === previous && keep < region.size) {
        start = keep;
        render();
      }
    },
  };
}
