/**
 * Binary save-state (de)serialization shared by cores.
 *
 * Components describe their state once, in a `sync(s)` method that works in
 * both directions: with a StateWriter each call stores the value and returns
 * it unchanged, with a StateReader it ignores the argument and returns the
 * stored value. Writing and reading therefore can't drift apart.
 *
 *   sync(s) {
 *     this.counter = s.u16(this.counter);
 *     this.enabled = s.bool(this.enabled);
 *     s.bytes(this.ram); // typed arrays are copied in place
 *   }
 */
export class StateWriter {
  reading = false;
  #bytes = new Uint8Array(64 * 1024);
  #view = new DataView(this.#bytes.buffer);
  #pos = 0;

  u8(value) {
    this.#reserve(1).setUint8(this.#pos, value);
    this.#pos += 1;
    return value;
  }

  u16(value) {
    this.#reserve(2).setUint16(this.#pos, value, true);
    this.#pos += 2;
    return value;
  }

  u32(value) {
    this.#reserve(4).setUint32(this.#pos, value, true);
    this.#pos += 4;
    return value;
  }

  i32(value) {
    this.#reserve(4).setInt32(this.#pos, value, true);
    this.#pos += 4;
    return value;
  }

  f64(value) {
    this.#reserve(8).setFloat64(this.#pos, value, true);
    this.#pos += 8;
    return value;
  }

  bool(value) {
    this.u8(value ? 1 : 0);
    return value;
  }

  /** Stores the contents of a typed array (its length is checked on load). */
  bytes(array) {
    const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
    this.u32(bytes.length);
    this.#reserve(bytes.length);
    this.#bytes.set(bytes, this.#pos);
    this.#pos += bytes.length;
    return array;
  }

  finish() {
    return this.#bytes.slice(0, this.#pos);
  }

  #reserve(count) {
    if (this.#pos + count > this.#bytes.length) {
      let size = this.#bytes.length * 2;
      while (size < this.#pos + count) size *= 2;
      const grown = new Uint8Array(size);
      grown.set(this.#bytes);
      this.#bytes = grown;
      this.#view = new DataView(grown.buffer);
    }
    return this.#view;
  }
}

export class StateReader {
  reading = true;
  #bytes;
  #view;
  #pos = 0;

  /** @param {Uint8Array} data */
  constructor(data) {
    this.#bytes = data;
    this.#view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }

  u8() {
    this.#check(1);
    return this.#view.getUint8(this.#pos++);
  }

  u16() {
    this.#check(2);
    const value = this.#view.getUint16(this.#pos, true);
    this.#pos += 2;
    return value;
  }

  u32() {
    this.#check(4);
    const value = this.#view.getUint32(this.#pos, true);
    this.#pos += 4;
    return value;
  }

  i32() {
    this.#check(4);
    const value = this.#view.getInt32(this.#pos, true);
    this.#pos += 4;
    return value;
  }

  f64() {
    this.#check(8);
    const value = this.#view.getFloat64(this.#pos, true);
    this.#pos += 8;
    return value;
  }

  bool() {
    return this.u8() !== 0;
  }

  /** Fills a typed array in place; throws if the stored length differs. */
  bytes(array) {
    const length = this.u32();
    if (length !== array.byteLength) throw new Error('Invalid save state.');
    this.#check(length);
    new Uint8Array(array.buffer, array.byteOffset, array.byteLength).set(this.#bytes.subarray(this.#pos, this.#pos + length));
    this.#pos += length;
    return array;
  }

  /** True when every stored byte has been read. */
  get done() {
    return this.#pos === this.#bytes.length;
  }

  #check(count) {
    if (this.#pos + count > this.#bytes.length) throw new Error('Invalid save state.');
  }
}
