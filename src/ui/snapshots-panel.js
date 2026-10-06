/**
 * Dialog listing the current game's snapshots. Pauses the game while open.
 *
 * @param {{ dialog: HTMLDialogElement, emulator: import('../app/emulator.js').Emulator, onError: (err: Error) => void, onOpenChange: (open: boolean) => void }} deps
 */
export function createSnapshotsPanel({ dialog, emulator, onError, onOpenChange }) {
  const list = dialog.querySelector('[data-list]');
  const empty = dialog.querySelector('[data-empty]');
  const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium' });
  let objectUrls = [];
  let resumeOnClose = false;

  function releaseThumbnails() {
    objectUrls.forEach((url) => URL.revokeObjectURL(url));
    objectUrls = [];
  }

  async function render() {
    const snapshots = await emulator.listSnapshots();
    releaseThumbnails();
    list.replaceChildren(
      ...snapshots.map((snapshot) => {
        const item = document.createElement('li');
        item.dataset.id = snapshot.id;
        const thumb = document.createElement('img');
        thumb.alt = '';
        if (snapshot.thumbnail) {
          thumb.src = URL.createObjectURL(snapshot.thumbnail);
          objectUrls.push(thumb.src);
        }
        const time = document.createElement('time');
        time.dateTime = new Date(snapshot.created).toISOString();
        time.textContent = dateFormat.format(snapshot.created);
        item.append(thumb, time, button('Load', 'load'), button('Delete', 'delete'));
        return item;
      }),
    );
    empty.hidden = snapshots.length > 0;
  }

  function button(label, action) {
    const el = document.createElement('button');
    el.type = 'button';
    el.textContent = label;
    el.dataset.action = action;
    return el;
  }

  list.addEventListener('click', async (e) => {
    const action = e.target.closest('[data-action]')?.dataset.action;
    const id = Number(e.target.closest('li')?.dataset.id);
    if (!action || !id) return;
    try {
      if (action === 'load') {
        await emulator.loadSnapshot(id);
        dialog.close();
      } else if (action === 'delete' && confirm('Delete this snapshot?')) {
        await emulator.deleteSnapshot(id);
      }
    } catch (err) {
      onError(err);
    }
  });

  dialog.querySelector('[data-take]').addEventListener('click', () => emulator.takeSnapshot().catch(onError));
  dialog.querySelector('[data-close]').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => {
    releaseThumbnails();
    onOpenChange(false);
    if (resumeOnClose) emulator.setPaused(false);
  });
  emulator.on('snapshots', () => dialog.open && render().catch(onError));

  return {
    open() {
      if (!emulator.core || dialog.open) return;
      resumeOnClose = !emulator.paused;
      emulator.setPaused(true);
      onOpenChange(true);
      dialog.showModal();
      render().catch(onError);
    },
  };
}
