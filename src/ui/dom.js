// Small DOM and formatting helpers shared by the UI modules.

export const SYSTEM_NAMES = { gb: 'Game Boy', gbc: 'Game Boy Color', gba: 'Game Boy Advance' };
export const SYSTEM_SHORT = { gb: 'GB', gbc: 'GBC', gba: 'GBA' };

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/**
 * Creates an element. Props are assigned as properties, except `dataset`
 * (merged) and `on<event>` (listeners). Falsy children are skipped.
 */
export function h(tag, props = {}, ...children) {
    const el = document.createElement(tag);
    for (const [name, value] of Object.entries(props)) {
        if (name === 'dataset') Object.assign(el.dataset, value);
        else if (name.startsWith('on')) el.addEventListener(name.slice(2), value);
        else if (value !== undefined && value !== null) el[name] = value;
    }
    el.append(...children.flat().filter((child) => child || child === 0));
    return el;
}

export function formatDate(timestamp) {
    return dateFormat.format(timestamp);
}

export function formatSize(bytes) {
    if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${bytes} B`;
}

/** File name without its extension. */
export function baseName(fileName) {
    return fileName.replace(/\.[^./]+$/, '');
}

/** Offers bytes to the user as a file download. */
export function downloadFile(data, fileName) {
    const url = URL.createObjectURL(new Blob([data], { type: 'application/octet-stream' }));
    const link = h('a', { href: url, download: fileName, hidden: true });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * Opens the file picker. Must be called from a user gesture.
 * @returns {Promise<File[]>} Empty when the user cancels.
 */
export function pickFiles({ accept = '', multiple = false } = {}) {
    return new Promise((resolve) => {
        const input = h('input', { type: 'file', accept, multiple, hidden: true });
        const done = () => {
            resolve([...(input.files ?? [])]);
            input.remove();
        };
        input.addEventListener('change', done, { once: true });
        input.addEventListener('cancel', done, { once: true });
        document.body.append(input);
        input.click();
    });
}
