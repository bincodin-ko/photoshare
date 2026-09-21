import { FormatError } from './bytes.js';
import { isHeif, isVideoContainer } from './isobmff/boxes.js';
import { readHeifExif } from './isobmff/heif.js';
import { makeMotionPhotoVideo, readMovieInfo } from './isobmff/quicktime.js';
import { ExifModel, TAG, findEntry, setEntry, shortEntry } from './jpeg/exif.js';
import { isJpeg } from './jpeg/segments.js';
import { LivePhoto, buildLivePhoto, jpegExifModel, jpegWithExif, readLivePhotoStill } from './livephoto.js';
import { MotionPhoto, buildMotionPhoto, parseMotionPhoto } from './motionphoto.js';

/**
 * High-level conversions. These are what the CLI and the web app call.
 */

export interface MotionToLiveOptions {
  contentIdentifier?: string;
  /** Override the key-frame time (seconds). Defaults to the motion photo's presentation timestamp. */
  stillTimeSec?: number;
}

export interface MotionToLiveResult extends LivePhoto {
  motion: MotionPhoto;
  stillTimeSec: number;
}

/** Galaxy/Pixel Motion Photo → iPhone Live Photo pair (still + .mov). */
export function motionToLive(file: Uint8Array, opts: MotionToLiveOptions = {}): MotionToLiveResult {
  const motion = parseMotionPhoto(file);
  if (!motion) throw new FormatError('Not a Motion Photo: no embedded video found');
  const vinfo = readMovieInfo(motion.video);
  const stillTimeSec = clampStill(
    opts.stillTimeSec ?? (motion.presentationTimestampUs !== undefined ? motion.presentationTimestampUs / 1e6 : 0),
    vinfo.durationSec,
  );
  const live = buildLivePhoto({ still: motion.still, video: motion.video, contentIdentifier: opts.contentIdentifier, stillTimeSec });
  return { ...live, motion, stillTimeSec };
}

/** Function that turns a HEIC into a JPEG (pixels only; Exif is re-attached by us). */
export type HeicTranscoder = (heic: Uint8Array) => Promise<Uint8Array>;

export interface LiveToMotionOptions {
  /** Needed when the still is HEIC. */
  transcodeHeic?: HeicTranscoder;
  /** Override the key-frame time in µs. Defaults to the .mov's still-image-time. */
  presentationTimestampUs?: number;
  /** Keep Apple's timed-metadata tracks in the embedded MP4. Default false. */
  keepMetadataTracks?: boolean;
  /** Write Samsung SEF trailer. Default true. */
  samsungTrailer?: boolean;
}

export interface LiveToMotionResult {
  file: Uint8Array;
  presentationTimestampUs: number;
  contentIdentifier?: string;
  /** True when the HEIC still was transcoded to JPEG. */
  transcoded: boolean;
  pairedByIdentifier: boolean;
}

/** iPhone Live Photo pair → Galaxy/Pixel Motion Photo JPEG. */
export async function liveToMotion(still: Uint8Array, video: Uint8Array, opts: LiveToMotionOptions = {}): Promise<LiveToMotionResult> {
  if (!isVideoContainer(video)) throw new FormatError('Video is not an MP4/MOV');
  const stillInfo = readLivePhotoStill(still);
  if (!stillInfo) throw new FormatError('Still must be a JPEG or HEIC');
  const vinfo = readMovieInfo(video);
  const pairedByIdentifier = !!stillInfo.contentIdentifier && stillInfo.contentIdentifier === vinfo.contentIdentifier;

  let jpeg: Uint8Array;
  let transcoded = false;
  if (isJpeg(still)) {
    jpeg = still;
  } else if (isHeif(still)) {
    if (!opts.transcodeHeic) throw new FormatError('HEIC still needs a transcoder (Motion Photos must be JPEG)');
    const pixels = await opts.transcodeHeic(still);
    if (!isJpeg(pixels)) throw new FormatError('Transcoder did not return a JPEG');
    const exif = readHeifExif(still)?.model;
    jpeg = exif ? jpegWithExif(pixels, normalizeTranscodedExif(exif, pixels)) : pixels;
    transcoded = true;
  } else {
    throw new FormatError('Still must be a JPEG or HEIC');
  }

  const ts = Math.round(opts.presentationTimestampUs ?? (vinfo.stillImageTimeSec ?? 0) * 1e6);
  const mp4 = makeMotionPhotoVideo(video, { stripMetadataTracks: !opts.keepMetadataTracks });
  const file = buildMotionPhoto({ still: jpeg, video: mp4, presentationTimestampUs: ts, samsungTrailer: opts.samsungTrailer });
  return { file, presentationTimestampUs: ts, contentIdentifier: stillInfo.contentIdentifier ?? vinfo.contentIdentifier, transcoded, pairedByIdentifier };
}

/**
 * After a HEIC → JPEG transcode the pixels are already upright (decoders apply
 * irot/imir), so Exif Orientation must be reset; the thumbnail is dropped because
 * it may not match; pixel dimensions are refreshed from the JPEG's SOF.
 */
function normalizeTranscodedExif(model: ExifModel, jpeg: Uint8Array): ExifModel {
  const m: ExifModel = { le: model.le, ifd0: model.ifd0 };
  const dims = jpegDimensions(jpeg);
  if (findEntry(m.ifd0, TAG.Orientation)) setEntry(m.ifd0, shortEntry(TAG.Orientation, 1, m.le));
  if (dims && m.ifd0.exif) {
    const { longEntry } = exifHelpers();
    setEntry(m.ifd0.exif, longEntry(TAG.PixelXDimension, dims.width, m.le));
    setEntry(m.ifd0.exif, longEntry(TAG.PixelYDimension, dims.height, m.le));
  }
  return m;
}

// Tiny indirection to avoid a circular import at module-evaluation time.
function exifHelpers() {
  return { longEntry: (tag: number, n: number, le: boolean) => ({ tag, type: 4, count: 1, value: u32bytes(n, le) }) };
}
function u32bytes(n: number, le: boolean): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0, le);
  return b;
}

/** Width/height from the first SOFn marker. */
export function jpegDimensions(jpeg: Uint8Array): { width: number; height: number } | undefined {
  let i = 2;
  while (i + 9 < jpeg.byteLength) {
    if (jpeg[i] !== 0xff) return undefined;
    const m = jpeg[i + 1];
    if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01) {
      i += 2;
      continue;
    }
    const len = (jpeg[i + 2] << 8) | jpeg[i + 3];
    if ((m >= 0xc0 && m <= 0xc3) || (m >= 0xc5 && m <= 0xc7) || (m >= 0xc9 && m <= 0xcb) || (m >= 0xcd && m <= 0xcf)) {
      return { height: (jpeg[i + 5] << 8) | jpeg[i + 6], width: (jpeg[i + 7] << 8) | jpeg[i + 8] };
    }
    if (m === 0xda) return undefined;
    i += 2 + len;
  }
  return undefined;
}

function clampStill(t: number, duration: number): number {
  if (!Number.isFinite(t) || t < 0) return 0;
  return duration > 0 ? Math.min(t, duration) : t;
}

export { jpegExifModel };
