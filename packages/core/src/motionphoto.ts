import { FormatError, concat } from './bytes.js';
import { isHeif } from './isobmff/boxes.js';
import { findHeifMotionVideo, heifStillOnly, indexOfFtyp, mp4Extent, readHeifExif } from './isobmff/heif.js';
import { ExifSummary, exifDateToEpochMs, parseTiff, summarizeExif } from './jpeg/exif.js';
import { EXIF_HEADER, findExifSegment, findXmpSegment, isJpeg, parseJpeg, rebuildJpeg, upsertApp1, XMP_HEADER } from './jpeg/segments.js';
import { MotionPhotoXmp, buildMotionPhotoXmp, isMotionPhotoXmp, parseMotionPhotoXmp, stripMotionPhotoXmp, xmpFromApp1, xmpToApp1 } from './jpeg/xmp.js';
import { SefTrailer, buildSefTrailer, encodeSefBlock, parseSefTrailer, sefBlockHeaderSize, sefImageUtcBlock, sefMotionPhotoBlock } from './samsung/sef.js';
import { readMovieInfo } from './isobmff/quicktime.js';

/**
 * A Motion Photo (Samsung "모션 포토", Google "Motion Photo"/"Top Shot") is a
 * single still-image file with an MP4 glued after the image data.
 */

export interface MotionPhoto {
  container: 'jpeg' | 'heif';
  /** The still with every motion hint removed (safe to treat as an ordinary photo). */
  still: Uint8Array;
  /** The embedded MP4 exactly as stored. */
  video: Uint8Array;
  /** Where we found the video. */
  source: 'sef' | 'sef-offset' | 'xmp-container' | 'micro-video' | 'scan' | 'mpvd' | 'sefd' | 'sef-trailer';
  /** Time of the still frame within the video (µs), when the file says so. */
  presentationTimestampUs?: number;
  /** Samsung Image_UTC_Data (epoch ms), when present. */
  imageUtcMs?: number;
  exif?: ExifSummary;
  xmp?: MotionPhotoXmp;
  sef?: SefTrailer;
}

/**
 * Slice the MP4 that starts at `start`. Declared lengths in XMP are advisory:
 * we walk the box structure and trust it over the metadata, which protects us
 * from files whose XMP was rewritten by an editor without updating lengths.
 */
function sliceVideoAt(file: Uint8Array, start: number, length?: number): Uint8Array {
  const extent = mp4Extent(file, start);
  const end = extent > start + 8 ? extent : length ? Math.min(file.byteLength, start + length) : extent;
  return file.subarray(start, end);
}

/** Parse a JPEG or HEIF motion photo. Returns undefined when no video is embedded. */
export function parseMotionPhoto(file: Uint8Array): MotionPhoto | undefined {
  if (isJpeg(file)) return parseJpegMotionPhoto(file);
  if (isHeif(file)) return parseHeifMotionPhoto(file);
  return undefined;
}

function parseHeifMotionPhoto(file: Uint8Array): MotionPhoto | undefined {
  const found = findHeifMotionVideo(file);
  if (!found) return undefined;
  let exif: ExifSummary | undefined;
  try {
    const e = readHeifExif(file);
    if (e) exif = summarizeExif(e.model);
  } catch {
    /* ignore */
  }
  const utc = found.sef?.blocks.find((b) => b.name === 'Image_UTC_Data');
  return {
    container: 'heif',
    still: heifStillOnly(file),
    video: found.video,
    source: found.source,
    imageUtcMs: utc ? Number(new TextDecoder().decode(utc.data)) || undefined : undefined,
    exif,
    sef: found.sef,
  };
}

function parseJpegMotionPhoto(file: Uint8Array): MotionPhoto | undefined {
  const parsed = parseJpeg(file);
  const xmpSeg = findXmpSegment(parsed);
  const xmp = xmpSeg ? parseMotionPhotoXmp(xmpFromApp1(xmpSeg.data)) : undefined;
  const sef = parseSefTrailer(file);
  const exifSeg = findExifSegment(parsed);
  let exif: ExifSummary | undefined;
  try {
    if (exifSeg) exif = summarizeExif(parseTiff(exifSeg.data.subarray(EXIF_HEADER.length)));
  } catch {
    /* keep going without Exif */
  }

  let video: Uint8Array | undefined;
  let source: MotionPhoto['source'] | undefined;

  // 1. Samsung SEF trailer — the most reliable pointer.
  const blk = sef?.blocks.find((b) => b.name === 'MotionPhoto_Data' || b.type === 0x0a30);
  if (blk) {
    if (blk.data.byteLength === 12 && String.fromCharCode(...blk.data.subarray(0, 4)) === 'mpv2') {
      // Offset/size form: absolute offset + size (big-endian).
      const dv = new DataView(blk.data.buffer, blk.data.byteOffset, 12);
      video = sliceVideoAt(file, dv.getUint32(4), dv.getUint32(8));
      source = 'sef-offset';
    } else if (blk.data.byteLength > 16) {
      video = blk.data;
      source = 'sef';
    }
  }

  // 2. Google container directory. Google's reader (media3) walks backwards from
  //    the end of the file using each secondary item's Length; Samsung inflates
  //    the video Length to cover its trailing SEF directory, so we do the same walk.
  if (!video && xmp && xmp.items.length > 1) {
    let start = -1;
    let itemStart = file.byteLength;
    for (let i = xmp.items.length - 1; i >= 1; i--) {
      const item = xmp.items[i];
      const itemEnd = itemStart;
      itemStart -= item.length ?? 0;
      if (item.semantic === 'MotionPhoto' && (item.mime === 'video/mp4' || item.mime === 'video/quicktime') && itemStart < itemEnd) {
        start = itemStart;
        break;
      }
    }
    // Forward walk (EOI + primary padding) as a second opinion when the backward one misses.
    if (start < 0 || start < parsed.eoiEnd || indexOfFtyp(file.subarray(start, start + 16)) !== 0) {
      const fwd = parsed.eoiEnd + (xmp.items[0]?.padding ?? 0);
      if (indexOfFtyp(file.subarray(fwd, fwd + 16)) === 0) start = fwd;
      else start = indexOfFtyp(file, parsed.eoiEnd);
    }
    if (start >= 0) {
      video = sliceVideoAt(file, start);
      source = 'xmp-container';
    }
  }

  // 3. Legacy MicroVideoOffset (bytes from end of file to start of the MP4).
  if (!video && xmp?.microVideoOffset) {
    const start = file.byteLength - xmp.microVideoOffset;
    if (start > parsed.eoiEnd - 1 && indexOfFtyp(file.subarray(start, start + 16)) === 0) {
      video = sliceVideoAt(file, start);
      source = 'micro-video';
    }
  }

  // 4. Last resort: any MP4 after the EOI.
  if (!video) {
    const i = indexOfFtyp(file, parsed.eoiEnd);
    if (i >= 0) {
      video = sliceVideoAt(file, i);
      source = 'scan';
    }
  }
  if (!video || !source) return undefined;

  // Clean still: drop trailer, drop motion XMP hints.
  let segments = parsed.segments;
  if (xmpSeg) {
    const cleaned = stripMotionPhotoXmp(xmpFromApp1(xmpSeg.data));
    segments = upsertApp1(segments, XMP_HEADER, xmpToApp1(cleaned));
  }
  const still = rebuildJpeg(file, parsed, segments);

  const utc = sef?.blocks.find((b) => b.name === 'Image_UTC_Data');
  const imageUtcMs = utc ? Number(new TextDecoder().decode(utc.data)) || undefined : undefined;

  return {
    container: 'jpeg',
    still,
    video,
    source,
    presentationTimestampUs: xmp?.presentationTimestampUs ?? xmp?.microVideoPresentationTimestampUs,
    imageUtcMs,
    exif,
    xmp: xmp && isMotionPhotoXmp(xmp) ? xmp : undefined,
    sef,
  };
}

export interface BuildMotionPhotoOptions {
  /** JPEG still (any trailer is discarded). */
  still: Uint8Array;
  /** MP4 (ISO brand) video. */
  video: Uint8Array;
  /** Presentation time of the still within the video, in µs. Defaults to 0. */
  presentationTimestampUs?: number;
  /** Capture time for Samsung's Image_UTC_Data. Defaults to Exif DateTimeOriginal, then now. */
  imageUtcMs?: number;
  /** Write the Samsung SEF trailer (needed by Samsung Gallery). Default true. */
  samsungTrailer?: boolean;
}

/**
 * Build a JPEG Motion Photo readable by Samsung Gallery (SEF trailer),
 * Google Photos (XMP Container + MotionPhoto v1) and older readers (MicroVideo).
 */
export function buildMotionPhoto(opts: BuildMotionPhotoOptions): Uint8Array {
  if (!isJpeg(opts.still)) throw new FormatError('Motion Photo still must be a JPEG (transcode HEIC first)');
  const parsed = parseJpeg(opts.still);
  const video = opts.video;
  const vinfo = readMovieInfo(video); // validates the container
  if (vinfo.fragmented) throw new FormatError('Fragmented MP4 cannot be embedded');
  const ts = Math.max(0, Math.round(opts.presentationTimestampUs ?? 0));

  const samsung = opts.samsungTrailer ?? true;
  const exifSeg = findExifSegment(parsed);
  let utcMs = opts.imageUtcMs;
  if (utcMs === undefined && exifSeg) {
    try {
      const s = summarizeExif(parseTiff(exifSeg.data.subarray(EXIF_HEADER.length)));
      utcMs = exifDateToEpochMs(s.dateTimeOriginal, s.offsetTimeOriginal, s.subSecTimeOriginal);
    } catch {
      /* ignore */
    }
  }
  if (utcMs === undefined) utcMs = Date.now();

  // Same block order as Samsung One UI 6 files: small blocks first, the video last,
  // then the SEFH directory. The primary item's XMP Padding covers the small blocks
  // plus the video block header; the video item's Length covers MP4 + directory.
  let trailer: Uint8Array;
  let paddingBeforeVideo: number;
  if (samsung) {
    const utc = sefImageUtcBlock(utcMs);
    trailer = buildSefTrailer([utc, sefMotionPhotoBlock(video)], 107);
    paddingBeforeVideo = encodeSefBlock(utc).byteLength + sefBlockHeaderSize('MotionPhoto_Data');
  } else {
    trailer = video;
    paddingBeforeVideo = 0;
  }
  const bytesAfterVideo = trailer.byteLength - paddingBeforeVideo - video.byteLength;

  const xmpSeg = findXmpSegment(parsed);
  const existingXmp = xmpSeg ? xmpFromApp1(xmpSeg.data) : undefined;
  const params = { videoLength: video.byteLength, paddingBeforeVideo, bytesAfterVideo, presentationTimestampUs: ts };
  // The primary Length is the JPEG's own size, which depends on the XMP that states it:
  // iterate until the number is stable (the digit count changes at most once).
  let primaryLength = 0;
  let jpeg = rebuildJpeg(opts.still, parsed, upsertApp1(parsed.segments, XMP_HEADER, xmpToApp1(buildMotionPhotoXmp({ ...params, primaryLength }, existingXmp))));
  for (let i = 0; i < 3 && jpeg.byteLength !== primaryLength; i++) {
    primaryLength = jpeg.byteLength;
    jpeg = rebuildJpeg(opts.still, parsed, upsertApp1(parsed.segments, XMP_HEADER, xmpToApp1(buildMotionPhotoXmp({ ...params, primaryLength }, existingXmp))));
  }
  if (jpeg.byteLength !== primaryLength) {
    primaryLength = 0; // give up on the optional attribute rather than write a wrong one
    jpeg = rebuildJpeg(opts.still, parsed, upsertApp1(parsed.segments, XMP_HEADER, xmpToApp1(buildMotionPhotoXmp({ ...params, primaryLength }, existingXmp))));
  }
  return concat([jpeg, trailer]);
}
