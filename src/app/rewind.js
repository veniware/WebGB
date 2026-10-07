/**
 * Rewind history: recent save states, newest last. Most are stored as the
 * bytes that differ from the group's first (full) state, since little of
 * the memory changes in a fraction of a second. The oldest groups are
 * dropped once the history exceeds `maxBytes`.
 */
export class RewindBuffer {
  /** @type {{ key: Uint8Array, deltas: Uint8Array[], bytes: number }[]} */
  #groups = [];
  #bytes = 0;
  #count = 0;
  #scratch = new Uint8Array(0);

  /**
   * @param {{ maxBytes?: number, groupSize?: number }} [options]
   *   groupSize: states per full state.
   */
  constructor({ maxBytes = 24 * 1024 * 1024, groupSize = 10 } = {}) {
    this.maxBytes = maxBytes;
    this.groupSize = groupSize;
  }

  /** Number of states held. */
  get length() {
    return this.#count;
  }

  /** Memory used, in bytes. */
  get bytes() {
    return this.#bytes;
  }

  /** @param {Uint8Array} state  Kept (not copied) when it starts a group. */
  push(state) {
    const group = this.#groups.at(-1);
    if (!group || group.deltas.length + 1 >= this.groupSize || group.key.length !== state.length) {
      this.#groups.push({ key: state, deltas: [], bytes: state.length });
      this.#bytes += state.length;
    } else {
      const delta = this.#encode(state, group.key);
      group.deltas.push(delta);
      group.bytes += delta.length;
      this.#bytes += delta.length;
    }
    this.#count++;
    while (this.#bytes > this.maxBytes && this.#groups.length > 1) {
      const oldest = this.#groups.shift();
      this.#bytes -= oldest.bytes;
      this.#count -= oldest.deltas.length + 1;
    }
  }

  /** Removes and returns the newest state, or null when empty. */
  pop() {
    const group = this.#groups.at(-1);
    if (!group) return null;
    this.#count--;
    const delta = group.deltas.pop();
    if (delta) {
      group.bytes -= delta.length;
      this.#bytes -= delta.length;
      return decode(delta, group.key);
    }
    this.#groups.pop();
    this.#bytes -= group.key.length;
    return group.key;
  }

  clear() {
    this.#groups = [];
    this.#bytes = 0;
    this.#count = 0;
  }

  /**
   * Runs of changed bytes: [unchanged count, changed count, ...changed bytes]
   * with the counts as varints. Short unchanged gaps are folded into the
   * changed runs, where they cost less than a new run.
   */
  #encode(state, key) {
    if (this.#scratch.length < state.length + 64) this.#scratch = new Uint8Array(state.length + state.length / 8 + 64);
    const out = this.#scratch;
    const length = state.length;
    let o = 0;
    let i = 0;
    let copied = 0;
    while (i < length) {
      while (i < length && state[i] === key[i]) i++;
      if (i === length) break;
      let end = i + 1;
      // Extend the run while the next unchanged gap is shorter than 4 bytes.
      for (let gap = 0; end < length; end++) {
        if (state[end] === key[end]) {
          if (++gap >= 4) {
            end -= gap - 1;
            break;
          }
        } else {
          gap = 0;
        }
      }
      if (end > length) end = length;
      o = varint(out, o, i - copied);
      o = varint(out, o, end - i);
      out.set(state.subarray(i, end), o);
      o += end - i;
      i = copied = end;
    }
    return out.slice(0, o);
  }
}

function varint(out, o, value) {
  while (value >= 0x80) {
    out[o++] = (value & 0x7f) | 0x80;
    value >>>= 7;
  }
  out[o++] = value;
  return o;
}

function decode(delta, key) {
  const state = key.slice();
  let position = 0;
  let o = 0;
  const read = () => {
    let value = 0;
    let shift = 0;
    let byte;
    do {
      byte = delta[o++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    } while (byte & 0x80);
    return value;
  };
  while (o < delta.length) {
    position += read();
    const count = read();
    state.set(delta.subarray(o, o + count), position);
    o += count;
    position += count;
  }
  return state;
}
