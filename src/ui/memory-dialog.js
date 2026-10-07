import { formatSize, h } from './dom.js';
import { CONDITIONS, MemorySearch, parseByte } from './memory-search.js';

// Bytes per page.
const PAGE = 256;
// Panels at least this wide (px) show 16 bytes per row, narrower ones 8.
const WIDE = 600;

/**
 * Memory viewer/editor: the running game's memory regions (see
 * Core.getMemoryRegions) as hex, a page at a time. The game is paused while
 * it's open unless "Run the game" is on; bytes are edited by typing two hex
 * digits. The search finds bytes by value and how they change.
 *
 * @param {{
 *     dialog: HTMLDialogElement,
 *     modals: ReturnType<typeof import('./modals.js').createModals>,
 *     emulator: import('../app/emulator.js').Emulator,
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
    let search = null;
    const live = dialog.querySelector('[data-live]');
    const condition = dialog.querySelector('[data-condition]');
    const searchValue = dialog.querySelector('[data-value]');
    const narrowButton = dialog.querySelector('[data-narrow]');
    const found = dialog.querySelector('[data-found]');
    const results = dialog.querySelector('[data-results]');
    const searchHint = found.textContent;

    const hex = (value, width) => value.toString(16).toUpperCase().padStart(width, '0');

    function choose(index) {
        region = regions[index];
        start = 0;
        digits = Math.max(4, hex(region.base + region.size - 1, 1).length);
        search = null;
        showResults();
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
            // Don't overwrite a byte being typed while the game runs.
            if (input === document.activeElement && input.value !== input.defaultValue) return;
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

    /** Runs a new search or narrows the last one. */
    function find(narrow) {
        const { needsValue } = CONDITIONS[condition.value];
        const value = parseByte(searchValue.value);
        if (needsValue && Number.isNaN(value)) {
            searchValue.setCustomValidity('A number from 0 to 255');
            searchValue.reportValidity();
            return;
        }
        if (!narrow || !search) {
            search = new MemorySearch(region);
            search.start(condition.value, value);
        } else {
            search.narrow(condition.value, value);
        }
        showResults();
    }

    function showResults() {
        narrowButton.disabled = !search;
        if (!search) {
            found.textContent = searchHint;
            results.replaceChildren();
            return;
        }
        found.textContent = search.count === 1 ? 'Found 1 byte.' : `Found ${search.count.toLocaleString()} bytes.`;
        results.replaceChildren(...search.results(search.count > 40 ? 0 : 40).map(({ offset, value }) => h('button', {
            type: 'button',
            textContent: `${hex(region.base + offset, digits)}: ${value < 0 ? '--' : value}`,
            onclick: () => go(hex(region.base + offset, digits)),
        })));
    }

    condition.append(...Object.entries(CONDITIONS).map(([id, { name }]) => new Option(name, id)));
    const updateValueField = () => (searchValue.disabled = !CONDITIONS[condition.value].needsValue);
    condition.addEventListener('change', updateValueField);
    updateValueField();
    searchValue.addEventListener('input', () => searchValue.setCustomValidity(''));
    searchValue.addEventListener('keydown', (e) => e.key === 'Enter' && find(Boolean(search)));
    dialog.querySelector('[data-search]').addEventListener('click', () => find(false));
    narrowButton.addEventListener('click', () => find(true));

    // "Run the game": unpaused while open, the page follows along.
    const follow = () => {
        if (!dialog.open || !live.checked) return;
        refresh();
        requestAnimationFrame(follow);
    };
    live.addEventListener('change', () => {
        emulator.setPaused(!live.checked);
        if (live.checked) requestAnimationFrame(follow);
        else showResults();
    });
    // Before the dialog manager resumes (or not) the game.
    dialog.addEventListener('close', () => {
        if (!live.checked) return;
        live.checked = false;
        emulator.setPaused(true);
    });

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
        if (search) showResults();
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
