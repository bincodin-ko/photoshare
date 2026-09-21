import { ByteWriter, FormatError, ascii, concat, decodeUtf8, fourcc, u16, u32, u64, utf8, view } from '../bytes.js';
import { Box, be32, box, child, childrenOf, ftypBox, fullBox, metaSkip, parseBoxes, path, rawBox } from './boxes.js';

/**
 * Everything Apple-specific about Live Photo videos:
 *
 *  1. moov/meta (hdlr 'mdta') with key  com.apple.quicktime.content.identifier
 *     whose value equals the still image's Apple MakerNote ContentIdentifier.
 *  2. A timed-metadata track (hdlr 'meta', sample entry 'mebx') carrying the
 *     key com.apple.quicktime.still-image-time. The *time* of its single sample
 *     tells Photos which frame is the still ("key photo").
 */

export const KEY_CONTENT_IDENTIFIER = 'com.apple.quicktime.content.identifier';
export const KEY_STILL_IMAGE_TIME = 'com.apple.quicktime.still-image-time';

export interface MovieInfo {
  timescale: number;
  /** Movie duration in seconds. */
  durationSec: number;
  nextTrackId: number;
  tracks: TrackInfo[];
  /** moov/meta mdta key/value pairs (string values only). */
  keys: Record<string, string>;
  contentIdentifier?: string;
  /** Presentation time (seconds) of the still-image-time sample, when present. */
  stillImageTimeSec?: number;
  hasStillImageTimeTrack: boolean;
  majorBrand: string;
  fragmented: boolean;
}

export interface TrackInfo {
  id: number;
  handler: string;
  /** stsd sample entry format, e.g. avc1, hvc1, mp4a, mebx. */
  format?: string;
  width?: number;
  height?: number;
  timescale: number;
  durationSec: number;
  metaKeys?: string[];
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

function fullBoxVersion(b: Box): number {
  return b.payload[0];
}

function mvhdInfo(mvhd: Box): { timescale: number; duration: number; nextTrackId: number } {
  const p = mvhd.payload;
  const v = fullBoxVersion(mvhd);
  if (v === 1) {
    return { timescale: u32(p, 20), duration: u64(p, 24), nextTrackId: u32(p, 108) };
  }
  return { timescale: u32(p, 12), duration: u32(p, 16), nextTrackId: u32(p, 96) };
}

function tkhdInfo(tkhd: Box): { id: number; duration: number; width: number; height: number } {
  const p = tkhd.payload;
  const v = fullBoxVersion(tkhd);
  const id = v === 1 ? u32(p, 20) : u32(p, 12);
  const duration = v === 1 ? u64(p, 28) : u32(p, 20);
  const base = v === 1 ? 36 : 24; // after duration: reserved(8) layer(2) alt(2) vol(2) res(2) matrix(36)
  const width = u32(p, base + 8 + 2 + 2 + 2 + 2 + 36) / 65536;
  const height = u32(p, base + 8 + 2 + 2 + 2 + 2 + 36 + 4) / 65536;
  return { id, duration, width, height };
}

function mdhdInfo(mdhd: Box): { timescale: number; duration: number } {
  const p = mdhd.payload;
  const v = fullBoxVersion(mdhd);
  return v === 1 ? { timescale: u32(p, 20), duration: u64(p, 24) } : { timescale: u32(p, 12), duration: u32(p, 16) };
}

function handlerType(hdlr: Box | undefined): string {
  return hdlr && hdlr.payload.byteLength >= 12 ? fourcc(hdlr.payload, 8) : '';
}

/** Parse the sample entries of an stsd box. */
function stsdEntries(stsd: Box | undefined, buf: Uint8Array): Box[] {
  if (!stsd) return [];
  const start = stsd.start + stsd.headerSize + 8; // version/flags + entry_count
  return parseBoxes(buf, start, stsd.start + stsd.size, 9);
}

/** Keys declared in a 'mebx' sample entry ('keys' box → entries → 'keyd'). */
function mebxKeys(entry: Box, buf: Uint8Array): string[] {
  const keys: string[] = [];
  const bodyStart = entry.start + entry.headerSize + 8; // 6 reserved + 2 data_reference_index
  for (const b of parseBoxes(buf, bodyStart, entry.start + entry.size, 9)) {
    if (b.type !== 'keys') continue;
    for (const k of parseBoxes(buf, b.start + b.headerSize, b.start + b.size, 10)) {
      for (const kk of parseBoxes(buf, k.start + k.headerSize, k.start + k.size, 11)) {
        if (kk.type === 'keyd' && kk.payload.byteLength > 4) keys.push(decodeUtf8(kk.payload.subarray(4)));
      }
    }
  }
  return keys;
}

/** Sum of leading empty edits (media_time == -1) in movie timescale units. */
function leadingEmptyEditDuration(trak: Box): number {
  const elst = path(trak, 'edts', 'elst');
  if (!elst) return 0;
  const p = elst.payload;
  const v = fullBoxVersion(elst);
  const n = u32(p, 4);
  let off = 8;
  let total = 0;
  for (let i = 0; i < n; i++) {
    const segDur = v === 1 ? u64(p, off) : u32(p, off);
    const mediaTime = v === 1 ? Number(view(p).getBigInt64(off + 8)) : view(p).getInt32(off + 4);
    off += v === 1 ? 20 : 12;
    if (mediaTime === -1) total += segDur;
    else break;
  }
  return total;
}

/** Read moov/meta (mdta) keys → string values. */
export function readMetaKeys(meta: Box | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!meta) return out;
  const hdlr = child(meta, 'hdlr');
  if (handlerType(hdlr) !== 'mdta') return out;
  const keysBox = child(meta, 'keys');
  const ilst = child(meta, 'ilst');
  if (!keysBox || !ilst) return out;
  const kp = keysBox.payload;
  const n = u32(kp, 4);
  const names: string[] = [];
  let off = 8;
  for (let i = 0; i < n && off + 8 <= kp.byteLength; i++) {
    const size = u32(kp, off);
    names.push(decodeUtf8(kp.subarray(off + 8, off + size)));
    off += size;
  }
  const ip = ilst.payload;
  off = 0;
  while (off + 8 <= ip.byteLength) {
    const size = u32(ip, off);
    if (size < 8) break;
    const index = u32(ip, off + 4);
    const name = names[index - 1];
    let d = off + 8;
    while (d + 16 <= off + size) {
      const dsize = u32(ip, d);
      if (dsize < 16) break;
      if (fourcc(ip, d + 4) === 'data') {
        const type = u32(ip, d + 8);
        const val = ip.subarray(d + 16, d + dsize);
        if (name) out[name] = type === 1 ? decodeUtf8(val) : Array.from(val, (x) => x.toString(16).padStart(2, '0')).join('');
      }
      d += dsize;
    }
    off += size;
  }
  return out;
}

export function readMovieInfo(file: Uint8Array): MovieInfo {
  const top = parseBoxes(file);
  const ftyp = top.find((b) => b.type === 'ftyp');
  const moov = top.find((b) => b.type === 'moov');
  if (!moov) throw new FormatError('MP4/MOV: no moov box');
  const mvhd = child(moov, 'mvhd');
  if (!mvhd) throw new FormatError('MP4/MOV: no mvhd box');
  const mv = mvhdInfo(mvhd);
  const tracks: TrackInfo[] = [];
  let stillSec: number | undefined;
  let hasStill = false;
  for (const trak of childrenOf(moov, 'trak')) {
    const tkhd = child(trak, 'tkhd');
    const mdhd = path(trak, 'mdia', 'mdhd');
    const hdlr = path(trak, 'mdia', 'hdlr');
    if (!tkhd || !mdhd) continue;
    const tk = tkhdInfo(tkhd);
    const md = mdhdInfo(mdhd);
    const entries = stsdEntries(path(trak, 'mdia', 'minf', 'stbl', 'stsd'), file);
    const handler = handlerType(hdlr);
    const info: TrackInfo = {
      id: tk.id,
      handler,
      format: entries[0]?.type,
      width: tk.width || undefined,
      height: tk.height || undefined,
      timescale: md.timescale,
      durationSec: md.timescale ? md.duration / md.timescale : 0,
    };
    if (handler === 'meta') {
      const keys = entries.filter((e) => e.type === 'mebx').flatMap((e) => mebxKeys(e, file));
      info.metaKeys = keys;
      if (keys.some((k) => k.endsWith('still-image-time'))) {
        hasStill = true;
        stillSec = leadingEmptyEditDuration(trak) / mv.timescale;
      }
    }
    tracks.push(info);
  }
  const keys = { ...readMetaKeys(path(moov, 'udta', 'meta')), ...readMetaKeys(child(moov, 'meta')) };
  return {
    timescale: mv.timescale,
    durationSec: mv.timescale ? mv.duration / mv.timescale : 0,
    nextTrackId: mv.nextTrackId,
    tracks,
    keys,
    contentIdentifier: keys[KEY_CONTENT_IDENTIFIER],
    stillImageTimeSec: stillSec,
    hasStillImageTimeTrack: hasStill,
    majorBrand: ftyp ? fourcc(ftyp.payload, 0) : '',
    fragmented: top.some((b) => b.type === 'moof'),
  };
}

// ---------------------------------------------------------------------------
// Writing helpers
// ---------------------------------------------------------------------------

function metaKeysBox(names: string[]): Uint8Array {
  const parts = names.map((n) => {
    const nb = utf8(n);
    return concat([be32(8 + nb.byteLength), ascii('mdta'), nb]);
  });
  return fullBox('keys', 0, 0, be32(names.length), ...parts);
}

function ilstBox(values: Uint8Array[]): Uint8Array {
  const items = values.map((v, i) => {
    const data = box('data', be32(1), be32(0), v); // type 1 = UTF-8, locale 0
    return concat([be32(8 + data.byteLength), be32(i + 1), data]);
  });
  return box('ilst', ...items);
}

function hdlrBox(handler: string, name: string, componentType = ''): Uint8Array {
  const w = new ByteWriter(64);
  w.str(componentType.padEnd(4, '\0').slice(0, 4)).str(handler).zeros(12).bytes(utf8(name)).u8(0);
  return fullBox('hdlr', 0, 0, w.toUint8Array());
}

/**
 * Build a moov/meta box from key → value pairs. Per Apple's QuickTime File
 * Format spec the movie-level 'meta' atom is a plain atom (no version/flags),
 * which is also what iPhone recordings contain and what exiftool expects at
 * this level. (ffmpeg instead writes a FullBox under moov/udta; we read both.)
 */
function buildMetaBox(pairs: Record<string, string>): Uint8Array {
  const names = Object.keys(pairs);
  return box('meta', hdlrBox('mdta', ''), metaKeysBox(names), ilstBox(names.map((n) => utf8(pairs[n]))));
}

const IDENTITY_MATRIX = new Uint8Array([
  0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x40, 0, 0, 0,
]);

interface StillTrackParams {
  trackId: number;
  videoTrackId: number;
  movieTimescale: number;
  /** Still time in movie timescale units. */
  stillMovieTicks: number;
  /** Remaining duration after the still, in movie ticks (>= 1). */
  sampleMovieTicks: number;
  mediaTimescale: number;
  /** Absolute file offset where the 9-byte sample will live. */
  sampleOffset: number;
}

const STILL_SAMPLE = (() => {
  const w = new ByteWriter(9);
  w.u32(9).u32(1).i8(-1);
  return w.toUint8Array();
})();

export const STILL_SAMPLE_SIZE = STILL_SAMPLE.byteLength;

function stillImageTimeTrack(p: StillTrackParams): Uint8Array {
  const mediaDur = Math.max(1, Math.round((p.sampleMovieTicks / p.movieTimescale) * p.mediaTimescale));
  const trackDur = p.stillMovieTicks + p.sampleMovieTicks;

  const tkhd = (() => {
    const w = new ByteWriter(84);
    w.u32(0).u32(0).u32(p.trackId).u32(0).u32(trackDur).zeros(8).u16(0).u16(0).u16(0).u16(0).bytes(IDENTITY_MATRIX).u32(0).u32(0);
    return fullBox('tkhd', 0, 0x000001, w.toUint8Array());
  })();

  const tref = box('tref', box('cdsc', be32(p.videoTrackId)));

  const edts = (() => {
    const w = new ByteWriter(32);
    const entries: [number, number][] = [];
    if (p.stillMovieTicks > 0) entries.push([p.stillMovieTicks, -1]);
    entries.push([p.sampleMovieTicks, 0]);
    w.u32(entries.length);
    for (const [dur, mt] of entries) w.u32(dur).i32(mt).u16(1).u16(0);
    return box('edts', fullBox('elst', 0, 0, w.toUint8Array()));
  })();

  const mdhd = (() => {
    const w = new ByteWriter(20);
    w.u32(0).u32(0).u32(p.mediaTimescale).u32(mediaDur).u16(0x55c4).u16(0);
    return fullBox('mdhd', 0, 0, w.toUint8Array());
  })();

  const hdlr = hdlrBox('meta', 'Core Media Metadata', 'mhlr');

  const keyd = box('keyd', ascii('mdta'), utf8(KEY_STILL_IMAGE_TIME));
  const dtyp = box('dtyp', be32(0), be32(65)); // namespace 0, type 65 = signed 8-bit integer
  const keyEntry = concat([be32(8 + keyd.byteLength + dtyp.byteLength), be32(1), keyd, dtyp]);
  const mebx = box('mebx', new Uint8Array(6), new ByteWriter(2).u16(1).toUint8Array(), box('keys', keyEntry));
  const stsd = fullBox('stsd', 0, 0, be32(1), mebx);
  const stts = fullBox('stts', 0, 0, be32(1), be32(1), be32(mediaDur));
  const stsc = fullBox('stsc', 0, 0, be32(1), be32(1), be32(1), be32(1));
  const stsz = fullBox('stsz', 0, 0, be32(STILL_SAMPLE_SIZE), be32(1));
  const stco = fullBox('stco', 0, 0, be32(1), be32(p.sampleOffset));
  const stbl = box('stbl', stsd, stts, stsc, stsz, stco);
  const dinf = box('dinf', fullBox('dref', 0, 0, be32(1), fullBox('url ', 0, 1)));
  const minf = box('minf', fullBox('nmhd', 0, 0), dinf, stbl);
  const mdia = box('mdia', mdhd, hdlr, minf);
  return box('trak', tkhd, tref, edts, mdia);
}

// ---------------------------------------------------------------------------
// Relayout: rewrite moov, keep media bytes, fix chunk offsets
// ---------------------------------------------------------------------------

interface Relayout {
  /** New file bytes. */
  file: Uint8Array;
  /** Absolute offset of the appended extra mdat payload (when requested). */
  extraOffset: number;
}

/**
 * Build [ftyp][moov][…original non-moov boxes in order…][extra mdat?] and
 * patch every stco/co64 so media samples still resolve. `buildMoov` receives
 * the original moov, the per-box delta function and must return the new moov
 * bytes. Because the moov size affects deltas, it is called twice: first with
 * a provisional layout to learn its size, then for real.
 */
function relayout(
  file: Uint8Array,
  newFtyp: Uint8Array,
  buildMoov: (ctx: { shift: (absOffset: number) => number; extraOffset: number; original: Box }) => Uint8Array,
  extraPayload?: Uint8Array,
): Relayout {
  const top = parseBoxes(file);
  const moov = top.find((b) => b.type === 'moov');
  if (!moov) throw new FormatError('MP4/MOV: no moov box');
  if (top.some((b) => b.type === 'moof')) throw new FormatError('Fragmented MP4 is not supported');
  const rest = top.filter((b) => b.type !== 'ftyp' && b.type !== 'moov');

  const compute = (moovSize: number) => {
    let pos = newFtyp.byteLength + moovSize;
    const map: { start: number; end: number; delta: number }[] = [];
    for (const b of rest) {
      map.push({ start: b.start, end: b.start + b.size, delta: pos - b.start });
      pos += b.size;
    }
    const extraOffset = pos + 8;
    const shift = (abs: number) => {
      for (const m of map) if (abs >= m.start && abs < m.end) return abs + m.delta;
      // Offsets pointing inside the old moov (rare, e.g. tiny samples in moov) are not supported.
      throw new FormatError(`MP4/MOV: chunk offset ${abs} does not fall inside a media box`);
    };
    return { shift, extraOffset };
  };

  // Pass 1: provisional size (deltas may be wrong, but the moov size is layout-independent).
  const p1 = compute(moov.size);
  const provisional = buildMoov({ ...p1, original: moov });
  const p2 = compute(provisional.byteLength);
  const finalMoov = buildMoov({ ...p2, original: moov });
  if (finalMoov.byteLength !== provisional.byteLength) throw new FormatError('MP4/MOV: moov size not stable');

  const parts: Uint8Array[] = [newFtyp, finalMoov];
  for (const b of rest) parts.push(rawBox(file, b));
  if (extraPayload) parts.push(box('mdat', extraPayload));
  return { file: concat(parts), extraOffset: p2.extraOffset };
}

/** Copy a trak box, patching stco/co64 entries through `shift`. */
function patchTrakOffsets(file: Uint8Array, trak: Box, shift: (abs: number) => number): Uint8Array {
  const out = rawBox(file, trak).slice();
  const dv = view(out);
  const stbl = path(trak, 'mdia', 'minf', 'stbl');
  for (const b of stbl?.children ?? []) {
    if (b.type !== 'stco' && b.type !== 'co64') continue;
    const rel = b.start - trak.start + b.headerSize;
    const n = dv.getUint32(rel + 4);
    for (let i = 0; i < n; i++) {
      if (b.type === 'stco') {
        const at = rel + 8 + i * 4;
        dv.setUint32(at, shift(dv.getUint32(at)));
      } else {
        const at = rel + 8 + i * 8;
        dv.setBigUint64(at, BigInt(shift(Number(dv.getBigUint64(at)))));
      }
    }
  }
  return out;
}

function patchMvhd(file: Uint8Array, mvhd: Box, nextTrackId: number, duration?: number): Uint8Array {
  const out = rawBox(file, mvhd).slice();
  const dv = view(out);
  const v = out[mvhd.headerSize];
  const base = mvhd.headerSize;
  if (v === 1) {
    dv.setUint32(base + 108, nextTrackId);
    if (duration !== undefined) dv.setBigUint64(base + 24, BigInt(duration));
  } else {
    dv.setUint32(base + 96, nextTrackId);
    if (duration !== undefined) dv.setUint32(base + 16, duration);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Public transforms
// ---------------------------------------------------------------------------

export interface LivePhotoVideoOptions {
  contentIdentifier: string;
  /** Time of the still frame within the video, in seconds. Defaults to the middle? No: 0. */
  stillTimeSec?: number;
  /** Extra mdta keys to write (e.g. com.apple.quicktime.creationdate). */
  extraKeys?: Record<string, string>;
}

/**
 * Turn an ordinary MP4 (Samsung/Google motion video) into a Live Photo video:
 * QuickTime brand, content identifier key, still-image-time track.
 * Existing metadata tracks with a still-image-time key are dropped first so
 * re-running is idempotent.
 */
export function makeLivePhotoVideo(input: Uint8Array, opts: LivePhotoVideoOptions): Uint8Array {
  const info = readMovieInfo(input);
  if (info.fragmented) throw new FormatError('Fragmented MP4 is not supported');
  const video = info.tracks.find((t) => t.handler === 'vide');
  if (!video) throw new FormatError('MP4/MOV: no video track');
  const stillSec = Math.min(Math.max(0, opts.stillTimeSec ?? 0), Math.max(0, info.durationSec));
  const stillTicks = Math.round(stillSec * info.timescale);
  const totalTicks = Math.round(info.durationSec * info.timescale);
  const sampleTicks = Math.max(1, totalTicks - stillTicks);

  const ftyp = ftypBox('qt  ', 0, ['qt  ']);
  const { file } = relayout(
    input,
    ftyp,
    ({ shift, extraOffset, original }) => {
      const parts: Uint8Array[] = [];
      let newTrackId = info.nextTrackId;
      for (const c of original.children ?? []) {
        if (c.type === 'mvhd') {
          parts.push(patchMvhd(input, c, newTrackId + 1));
        } else if (c.type === 'trak') {
          const isStillTrack = path(c, 'mdia', 'hdlr') && handlerType(path(c, 'mdia', 'hdlr')) === 'meta' &&
            stsdEntries(path(c, 'mdia', 'minf', 'stbl', 'stsd'), input).some((e) => e.type === 'mebx' && mebxKeys(e, input).some((k) => k.endsWith('still-image-time')));
          if (isStillTrack) continue;
          parts.push(patchTrakOffsets(input, c, shift));
        } else if (c.type === 'meta' && handlerType(child(c, 'hdlr')) === 'mdta') {
          continue; // rebuilt below
        } else {
          parts.push(rawBox(input, c));
        }
      }
      const pairs = {
        ...readMetaKeys(path(original, 'udta', 'meta')),
        ...readMetaKeys(child(original, 'meta')),
        ...(opts.extraKeys ?? {}),
        [KEY_CONTENT_IDENTIFIER]: opts.contentIdentifier,
      };
      parts.push(buildMetaBox(pairs));
      parts.push(
        stillImageTimeTrack({
          trackId: newTrackId,
          videoTrackId: video.id,
          movieTimescale: info.timescale,
          stillMovieTicks: stillTicks,
          sampleMovieTicks: sampleTicks,
          mediaTimescale: video.timescale || info.timescale,
          sampleOffset: extraOffset,
        }),
      );
      return box('moov', ...parts);
    },
    STILL_SAMPLE,
  );
  return file;
}

export interface MotionVideoOptions {
  /** Drop Apple timed-metadata tracks (still-image-time, etc). Default true. */
  stripMetadataTracks?: boolean;
}

/**
 * Turn a Live Photo .mov into a plain MP4 suitable for embedding in a Motion
 * Photo: ISO brand and (by default) no timed-metadata tracks, which some
 * Android players refuse to open.
 */
export function makeMotionPhotoVideo(input: Uint8Array, opts: MotionVideoOptions = {}): Uint8Array {
  const strip = opts.stripMetadataTracks ?? true;
  const ftyp = ftypBox('mp42', 0, ['mp42', 'isom', 'mp41']);
  const { file } = relayout(input, ftyp, ({ shift, original }) => {
    const parts: Uint8Array[] = [];
    for (const c of original.children ?? []) {
      if (c.type === 'trak') {
        const h = handlerType(path(c, 'mdia', 'hdlr'));
        if (strip && (h === 'meta' || h === 'tmcd')) continue;
        parts.push(patchTrakOffsets(input, c, shift));
      } else {
        parts.push(rawBox(input, c));
      }
    }
    return box('moov', ...parts);
  });
  return file;
}

/** Read a 16-bit value helper re-exported for tests. */
export const _u16 = u16;
export { metaSkip as _metaSkip };
