// Service worker: makes WebGB installable and lets it start offline.
//
// Network first, so a new version is used as soon as it's online; every
// response is kept as the offline copy. FILES (the whole app) is cached on
// install; tests/pwa.test.js checks that it lists every file in src/.

const CACHE = 'webgb';
const FILES = [
  './',
  'index.html',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-180.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'src/app/emitter.js',
  'src/app/emulator.js',
  'src/app/settings.js',
  'src/audio/audio-output.js',
  'src/audio/audio-processor.js',
  'src/audio/resampler.js',
  'src/core/buttons.js',
  'src/core/gb/apu.js',
  'src/core/gb/cartridge.js',
  'src/core/gb/constants.js',
  'src/core/gb/cpu.js',
  'src/core/gb/fifo.js',
  'src/core/gb/gameboy.js',
  'src/core/gb/index.js',
  'src/core/gb/joypad.js',
  'src/core/gb/link.js',
  'src/core/gb/mappers/base.js',
  'src/core/gb/mappers/camera.js',
  'src/core/gb/mappers/huc3.js',
  'src/core/gb/mappers/mbc.js',
  'src/core/gb/mappers/mbc6.js',
  'src/core/gb/mappers/mbc7.js',
  'src/core/gb/mappers/mmm01.js',
  'src/core/gb/mappers/tama5.js',
  'src/core/gb/palettes.js',
  'src/core/gb/ppu.js',
  'src/core/gb/rtc.js',
  'src/core/gb/serial.js',
  'src/core/gb/sgb.js',
  'src/core/gb/timer.js',
  'src/core/gba/apu.js',
  'src/core/gba/arm.js',
  'src/core/gba/backup.js',
  'src/core/gba/bios.js',
  'src/core/gba/bus.js',
  'src/core/gba/cpu.js',
  'src/core/gba/dma.js',
  'src/core/gba/gba.js',
  'src/core/gba/gpio.js',
  'src/core/gba/index.js',
  'src/core/gba/ppu.js',
  'src/core/gba/sio.js',
  'src/core/gba/thumb.js',
  'src/core/gba/timers.js',
  'src/core/interface.js',
  'src/core/registry.js',
  'src/core/state.js',
  'src/core/test/test-core.js',
  'src/input/bindings.js',
  'src/input/camera.js',
  'src/input/gamepad.js',
  'src/input/input-manager.js',
  'src/input/keyboard.js',
  'src/input/motion.js',
  'src/input/rumble.js',
  'src/input/touch.js',
  'src/main.js',
  'src/rom/detect.js',
  'src/rom/loader.js',
  'src/rom/zip.js',
  'src/storage/db.js',
  'src/storage/roms.js',
  'src/storage/saves.js',
  'src/storage/snapshots.js',
  'src/styles.css',
  'src/ui/controls-dialog.js',
  'src/ui/dom.js',
  'src/ui/files.js',
  'src/ui/game-dialog.js',
  'src/ui/library-dialog.js',
  'src/ui/link-dialog.js',
  'src/ui/modals.js',
  'src/ui/settings-dialog.js',
  'src/ui/ui.js',
  'src/util/crc32.js',
  'src/video/canvas-renderer.js',
  'src/video/display.js',
  'src/video/filters.js',
  'src/video/thumbnail.js',
  'src/video/webgl-renderer.js',
];

self.addEventListener('install', (event) => {
  // Past the HTTP cache, so the copies are all of the same version.
  const requests = FILES.map((file) => new Request(file, { cache: 'reload' }));
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(requests)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(networkFirst(request));
});

async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch (err) {
    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached) return cached;
    if (request.mode === 'navigate') {
      const page = await cache.match('./');
      if (page) return page;
    }
    throw err;
  }
}
