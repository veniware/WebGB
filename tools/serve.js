// Tiny static file server for development: `npm start`.
// The app itself needs no server; any static host works.
import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');
const port = Number(process.env.PORT ?? 8080);
const host = process.env.HOST ?? '127.0.0.1';

const TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json',
    '.webmanifest': 'application/manifest+json',
    '.wasm': 'application/wasm',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
};

createServer(async (req, res) => {
    try {
        const { pathname } = new URL(req.url, 'http://localhost');
        let path = resolve(root, `.${decodeURIComponent(pathname)}`);
        if (path !== root && !path.startsWith(root + sep)) throw new Error('Outside root');
        if ((await stat(path)).isDirectory()) path = join(path, 'index.html');
        const body = await readFile(path);
        res.writeHead(200, {
            'Content-Type': TYPES[extname(path)] ?? 'application/octet-stream',
            'Cache-Control': 'no-cache',
        });
        res.end(body);
    } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
    }
}).listen(port, host, () => {
    console.log(`WebGB running at http://${host === '127.0.0.1' ? 'localhost' : host}:${port}/`);
});
