/**
 * A FlatBuffers builder (the binary format of google/flatbuffers), written back to front as the
 * reference builders write it: children first, each table's vtable just before it, every value
 * aligned to its size from the start of the finished, size-prefixed buffer. Vtables are not
 * shared, so the bytes depend only on the order of the calls: the native engine (flatgeobuf.rs)
 * makes the same calls in the same order and writes the same bytes. The reader below shares no
 * code with the builder, so the export read-back does not take the writer's word for anything.
 */

const UTF8 = new TextEncoder();
const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true });

export class FlatBuilder {
  private buf = new Uint8Array(1024);
  private view = new DataView(this.buf.buffer);
  /** Bytes still free at the front; the written bytes are buf[space..]. */
  private space = 1024;
  private minalign = 1;
  private vtable: number[] = [];
  private objectStart = 0;
  private vectorLength = 0;

  /** Bytes written so far, which is how an object's position is named until the buffer is done. */
  offset(): number {
    return this.buf.length - this.space;
  }

  private grow(needed: number): void {
    while (this.space < needed) {
      const old = this.buf;
      const next = new Uint8Array(old.length * 2);
      next.set(old, old.length);
      this.space += old.length;
      this.buf = next;
      this.view = new DataView(next.buffer);
    }
  }

  private pad(n: number): void {
    this.grow(n);
    for (let i = 0; i < n; i++) this.buf[--this.space] = 0;
  }

  /** Aligns so that `size` bytes can follow `additional` more bytes at an aligned position. */
  prep(size: number, additional: number): void {
    if (size > this.minalign) this.minalign = size;
    const alignSize = (size - ((this.offset() + additional) % size)) % size;
    this.grow(alignSize + size + additional);
    this.pad(alignSize);
  }

  private write(size: number, put: (at: number) => void): void {
    this.prep(size, 0);
    this.space -= size;
    put(this.space);
  }

  addUint8(v: number): void {
    this.write(1, (at) => this.view.setUint8(at, v));
  }
  addUint16(v: number): void {
    this.write(2, (at) => this.view.setUint16(at, v, true));
  }
  addInt32(v: number): void {
    this.write(4, (at) => this.view.setInt32(at, v, true));
  }
  addUint32(v: number): void {
    this.write(4, (at) => this.view.setUint32(at, v, true));
  }
  addUint64(v: bigint): void {
    this.write(8, (at) => this.view.setBigUint64(at, v, true));
  }
  addFloat64(v: number): void {
    this.write(8, (at) => this.view.setFloat64(at, v, true));
  }

  /** An offset to an object written earlier, relative to where it is stored. */
  addOffset(target: number): void {
    this.prep(4, 0);
    this.addUint32(this.offset() - target + 4);
  }

  createString(text: string): number {
    const bytes = UTF8.encode(text);
    this.prep(4, bytes.length + 1);
    this.addUint8(0);
    this.grow(bytes.length);
    this.space -= bytes.length;
    this.buf.set(bytes, this.space);
    this.addUint32(bytes.length);
    return this.offset();
  }

  startVector(elemSize: number, count: number, alignment: number): void {
    this.vectorLength = count;
    this.prep(4, elemSize * count);
    this.prep(alignment, elemSize * count);
  }

  endVector(): number {
    this.grow(4);
    this.space -= 4;
    this.view.setUint32(this.space, this.vectorLength, true);
    return this.offset();
  }

  createFloat64Vector(values: readonly number[]): number {
    this.startVector(8, values.length, 8);
    for (let i = values.length - 1; i >= 0; i--) this.addFloat64(values[i] as number);
    return this.endVector();
  }

  createUint32Vector(values: readonly number[]): number {
    this.startVector(4, values.length, 4);
    for (let i = values.length - 1; i >= 0; i--) this.addUint32(values[i] as number);
    return this.endVector();
  }

  createBytes(bytes: Uint8Array): number {
    this.startVector(1, bytes.length, 1);
    this.grow(bytes.length);
    this.space -= bytes.length;
    this.buf.set(bytes, this.space);
    return this.endVector();
  }

  createOffsetVector(targets: readonly number[]): number {
    this.startVector(4, targets.length, 4);
    for (let i = targets.length - 1; i >= 0; i--) this.addOffset(targets[i] as number);
    return this.endVector();
  }

  startTable(fields: number): void {
    this.vtable = new Array<number>(fields).fill(0);
    this.objectStart = this.offset();
  }

  /** Records that the value just added is field `slot` of the table being built. */
  slot(slot: number): void {
    this.vtable[slot] = this.offset();
  }

  fieldUint8(slot: number, v: number): void {
    this.addUint8(v);
    this.slot(slot);
  }
  fieldUint16(slot: number, v: number): void {
    this.addUint16(v);
    this.slot(slot);
  }
  fieldInt32(slot: number, v: number): void {
    this.addInt32(v);
    this.slot(slot);
  }
  fieldUint64(slot: number, v: bigint): void {
    this.addUint64(v);
    this.slot(slot);
  }
  fieldOffset(slot: number, target: number): void {
    this.addOffset(target);
    this.slot(slot);
  }

  endTable(): number {
    this.addInt32(0);
    const objectOffset = this.offset();
    let last = this.vtable.length - 1;
    while (last >= 0 && this.vtable[last] === 0) last--;
    for (let i = last; i >= 0; i--) {
      const at = this.vtable[i] as number;
      this.addUint16(at === 0 ? 0 : objectOffset - at);
    }
    this.addUint16(objectOffset - this.objectStart);
    this.addUint16((last + 1 + 2) * 2);
    const vtableOffset = this.offset();
    // The table's first word: how far before it its vtable is.
    this.view.setInt32(this.buf.length - objectOffset, vtableOffset - objectOffset, true);
    return objectOffset;
  }

  /** The finished buffer: its size, the offset to the root table, and everything written. */
  finishSizePrefixed(root: number): Uint8Array {
    this.prep(this.minalign, 8);
    this.addOffset(root);
    this.addUint32(this.offset());
    return this.buf.slice(this.space);
  }
}

/** Reads FlatBuffers tables, apart from the builder: vtables, scalars, strings and vectors. */
export class FlatReader {
  private readonly view: DataView;

  constructor(private readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  private check(at: number, size: number): void {
    if (at < 0 || at + size > this.bytes.length) throw new RangeError(`an offset points outside the buffer`);
  }

  uint8(at: number): number {
    this.check(at, 1);
    return this.view.getUint8(at);
  }
  uint16(at: number): number {
    this.check(at, 2);
    return this.view.getUint16(at, true);
  }
  int32(at: number): number {
    this.check(at, 4);
    return this.view.getInt32(at, true);
  }
  uint32(at: number): number {
    this.check(at, 4);
    return this.view.getUint32(at, true);
  }
  uint64(at: number): bigint {
    this.check(at, 8);
    return this.view.getBigUint64(at, true);
  }
  float64(at: number): number {
    this.check(at, 8);
    return this.view.getFloat64(at, true);
  }

  /** The table an offset at `at` points to. */
  indirect(at: number): number {
    return at + this.uint32(at);
  }

  /** Where field `slot` of the table at `table` is, or null when it is absent. */
  field(table: number, slot: number): number | null {
    const vtable = table - this.int32(table);
    const size = this.uint16(vtable);
    const entry = 4 + 2 * slot;
    if (entry >= size) return null;
    const at = this.uint16(vtable + entry);
    return at === 0 ? null : table + at;
  }

  /** The start and length of the vector a field points to. */
  vector(table: number, slot: number): { start: number; length: number } | null {
    const at = this.field(table, slot);
    if (at === null) return null;
    const v = this.indirect(at);
    return { start: v + 4, length: this.uint32(v) };
  }

  bytesAt(start: number, length: number): Uint8Array {
    this.check(start, length);
    return this.bytes.subarray(start, start + length);
  }

  string(table: number, slot: number): string | null {
    const v = this.vector(table, slot);
    if (v === null) return null;
    try {
      return STRICT_UTF8.decode(this.bytesAt(v.start, v.length));
    } catch (e) {
      if (e instanceof RangeError) throw e;
      throw new RangeError('a string is not UTF-8 text', { cause: e });
    }
  }
}
