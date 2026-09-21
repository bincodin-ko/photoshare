/**
 * Small, dependency-free byte helpers shared by every format module.
 * Everything works on Uint8Array so the same code runs in Node and the browser.
 */

export class FormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FormatError';
  }
}

export function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.byteLength;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}

export function ascii(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: false });
const latin1 = new TextDecoder('latin1');

export function utf8(s: string): Uint8Array {
  return encoder.encode(s);
}

export function decodeUtf8(b: Uint8Array): string {
  return decoder.decode(b);
}

export function decodeLatin1(b: Uint8Array): string {
  return latin1.decode(b);
}

export function fourcc(b: Uint8Array, off: number): string {
  return String.fromCharCode(b[off], b[off + 1], b[off + 2], b[off + 3]);
}

export function startsWith(b: Uint8Array, prefix: Uint8Array | string, off = 0): boolean {
  const p = typeof prefix === 'string' ? ascii(prefix) : prefix;
  if (b.byteLength - off < p.byteLength) return false;
  for (let i = 0; i < p.byteLength; i++) if (b[off + i] !== p[i]) return false;
  return true;
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Find `needle` in `hay` starting at `from`. Returns -1 when absent. */
export function indexOf(hay: Uint8Array, needle: Uint8Array | string, from = 0): number {
  const n = typeof needle === 'string' ? ascii(needle) : needle;
  if (n.byteLength === 0) return from;
  const first = n[0];
  const last = hay.byteLength - n.byteLength;
  outer: for (let i = Math.max(0, from); i <= last; i++) {
    if (hay[i] !== first) continue;
    for (let j = 1; j < n.byteLength; j++) if (hay[i + j] !== n[j]) continue outer;
    return i;
  }
  return -1;
}

export function lastIndexOf(hay: Uint8Array, needle: Uint8Array | string): number {
  const n = typeof needle === 'string' ? ascii(needle) : needle;
  outer: for (let i = hay.byteLength - n.byteLength; i >= 0; i--) {
    for (let j = 0; j < n.byteLength; j++) if (hay[i + j] !== n[j]) continue outer;
    return i;
  }
  return -1;
}

export function view(b: Uint8Array): DataView {
  return new DataView(b.buffer, b.byteOffset, b.byteLength);
}

export function u16(b: Uint8Array, off: number, le = false): number {
  return view(b).getUint16(off, le);
}
export function u32(b: Uint8Array, off: number, le = false): number {
  return view(b).getUint32(off, le);
}
export function u64(b: Uint8Array, off: number, le = false): number {
  const v = view(b).getBigUint64(off, le);
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new FormatError('64-bit value too large');
  return Number(v);
}

/** Growable big-endian-by-default writer. */
export class ByteWriter {
  private buf: Uint8Array;
  private len = 0;
  constructor(initial = 1024) {
    this.buf = new Uint8Array(initial);
  }
  get length(): number {
    return this.len;
  }
  private ensure(extra: number) {
    if (this.len + extra <= this.buf.byteLength) return;
    let size = this.buf.byteLength * 2;
    while (size < this.len + extra) size *= 2;
    const nb = new Uint8Array(size);
    nb.set(this.buf.subarray(0, this.len));
    this.buf = nb;
  }
  bytes(b: Uint8Array): this {
    this.ensure(b.byteLength);
    this.buf.set(b, this.len);
    this.len += b.byteLength;
    return this;
  }
  str(s: string): this {
    return this.bytes(ascii(s));
  }
  u8(v: number): this {
    this.ensure(1);
    this.buf[this.len++] = v & 0xff;
    return this;
  }
  i8(v: number): this {
    return this.u8(v < 0 ? v + 256 : v);
  }
  u16(v: number, le = false): this {
    this.ensure(2);
    view(this.buf).setUint16(this.len, v, le);
    this.len += 2;
    return this;
  }
  u32(v: number, le = false): this {
    this.ensure(4);
    view(this.buf).setUint32(this.len, v >>> 0, le);
    this.len += 4;
    return this;
  }
  i32(v: number, le = false): this {
    this.ensure(4);
    view(this.buf).setInt32(this.len, v, le);
    this.len += 4;
    return this;
  }
  u64(v: number, le = false): this {
    this.ensure(8);
    view(this.buf).setBigUint64(this.len, BigInt(v), le);
    this.len += 8;
    return this;
  }
  zeros(n: number): this {
    this.ensure(n);
    this.len += n; // freshly allocated memory is already zero
    return this;
  }
  /** Overwrite a u32 at an earlier position (used for back-patching sizes). */
  patchU32(pos: number, v: number, le = false): this {
    view(this.buf).setUint32(pos, v >>> 0, le);
    return this;
  }
  toUint8Array(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

export function hex(b: Uint8Array, max = 32): string {
  return Array.from(b.subarray(0, max), (x) => x.toString(16).padStart(2, '0')).join(' ');
}
