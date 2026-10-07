/** Cartridge GPIO port (real-time clock): not present yet. */
export class Gpio {
  constructor() {
    this.present = false;
    this.readable = false;
  }

  reset() {}

  sync() {}

  read() {
    return 0;
  }

  write() {}

  toSave() {
    return new Uint8Array(0);
  }

  fromSave() {}
}
