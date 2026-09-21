import { FormatError } from './bytes.js';
import { isHeif, isVideoContainer } from './isobmff/boxes.js';
import { heifStillOnly, readHeifExif, writeHeifExif } from './isobmff/heif.js';
import { MovieInfo, makeLivePhotoVideo, readMovieInfo } from './isobmff/quicktime.js';
import { ExifModel, ExifSummary, emptyExif, getAppleContentIdentifier, parseTiff, serializeTiff, setAppleContentIdentifier, summarizeExif } from './jpeg/exif.js';
import { EXIF_HEADER, findExifSegment, findXmpSegment, isJpeg, parseJpeg, rebuildJpeg, upsertApp1, XMP_HEADER } from './jpeg/segments.js';
import { stripMotionPhotoXmp, xmpFromApp1, xmpToApp1 } from './jpeg/xmp.js';
import { ascii } from './bytes.js';
import { concat } from './bytes.js';
import { newContentIdentifier } from './uuid.js';

/**
 * A Live Photo is two files that agree on one UUID:
 *   still  (HEIC/JPEG)  → Apple MakerNote 0x0011 ContentIdentifier
 *   video  (.MOV)       → mdta key com.apple.quicktime.content.identifier
 * plus a still-image-time metadata track telling Photos which frame is the key photo.
 */

export interface LivePhotoStill {
  container: 'jpeg' | 'heif';
  contentIdentifier?: string;
  exif?: ExifSummary;
}

export function readLivePhotoStill(file: Uint8Array): LivePhotoStill | undefined {
  if (isJpeg(file)) {
    const parsed = parseJpeg(file);
    const seg = findExifSegment(parsed);
    if (!seg) return { container: 'jpeg' };
    try {
      const model = parseTiff(seg.data.subarray(EXIF_HEADER.length));
      return { container: 'jpeg', contentIdentifier: getAppleContentIdentifier(model), exif: summarizeExif(model) };
    } catch {
      return { container: 'jpeg' };
    }
  }
  if (isHeif(file)) {
    try {
      const e = readHeifExif(file);
      if (!e) return { container: 'heif' };
      return { container: 'heif', contentIdentifier: getAppleContentIdentifier(e.model), exif: summarizeExif(e.model) };
    } catch {
      return { container: 'heif' };
    }
  }
  return undefined;
}

export function readLivePhotoVideo(file: Uint8Array): MovieInfo | undefined {
  if (!isVideoContainer(file)) return undefined;
  return readMovieInfo(file);
}

/** Get the Exif model out of a JPEG (or an empty one). */
export function jpegExifModel(file: Uint8Array): ExifModel {
  const parsed = parseJpeg(file);
  const seg = findExifSegment(parsed);
  if (!seg) return emptyExif(false);
  try {
    return parseTiff(seg.data.subarray(EXIF_HEADER.length));
  } catch {
    return emptyExif(false);
  }
}

/** Replace the Exif APP1 of a JPEG with `model`. */
export function jpegWithExif(file: Uint8Array, model: ExifModel, opts: { stripMotionXmp?: boolean; stripTrailer?: boolean } = {}): Uint8Array {
  const parsed = parseJpeg(file);
  const payload = concat([ascii(EXIF_HEADER), serializeTiff(model)]);
  let segments = upsertApp1(parsed.segments, EXIF_HEADER, payload);
  if (opts.stripMotionXmp ?? true) {
    const x = findXmpSegment(parsed);
    if (x) segments = upsertApp1(segments, XMP_HEADER, xmpToApp1(stripMotionPhotoXmp(xmpFromApp1(x.data))));
  }
  return rebuildJpeg(file, parsed, segments, opts.stripTrailer === false ? parsed.trailer : undefined);
}

/** Stamp a content identifier into a JPEG or HEIC still. */
export function stampStill(still: Uint8Array, contentIdentifier: string): Uint8Array {
  if (isJpeg(still)) {
    const model = setAppleContentIdentifier(jpegExifModel(still), contentIdentifier);
    return jpegWithExif(still, model);
  }
  if (isHeif(still)) {
    const e = readHeifExif(heifStillOnly(still));
    if (!e) throw new FormatError('HEIC has no Exif item; cannot stamp a content identifier');
    return writeHeifExif(heifStillOnly(still), setAppleContentIdentifier(e.model, contentIdentifier));
  }
  throw new FormatError('Still must be a JPEG or HEIC');
}

export interface BuildLivePhotoOptions {
  still: Uint8Array;
  video: Uint8Array;
  /** Reuse an identifier (e.g. when re-pairing). A fresh UUID is generated otherwise. */
  contentIdentifier?: string;
  /** Still frame time within the video, seconds. */
  stillTimeSec?: number;
}

export interface LivePhoto {
  still: Uint8Array;
  video: Uint8Array;
  contentIdentifier: string;
  stillContainer: 'jpeg' | 'heif';
}

export function buildLivePhoto(opts: BuildLivePhotoOptions): LivePhoto {
  const id = opts.contentIdentifier ?? newContentIdentifier();
  const still = stampStill(opts.still, id);
  const video = makeLivePhotoVideo(opts.video, { contentIdentifier: id, stillTimeSec: opts.stillTimeSec });
  return { still, video, contentIdentifier: id, stillContainer: isJpeg(opts.still) ? 'jpeg' : 'heif' };
}
