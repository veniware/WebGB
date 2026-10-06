/** Minimal event emitter. */
export class Emitter {
  #listeners = new Map();

  /** @returns {() => void} Unsubscribe. */
  on(type, fn) {
    let set = this.#listeners.get(type);
    if (!set) this.#listeners.set(type, (set = new Set()));
    set.add(fn);
    return () => set.delete(fn);
  }

  emit(type, detail) {
    for (const fn of this.#listeners.get(type) ?? []) fn(detail);
  }
}
