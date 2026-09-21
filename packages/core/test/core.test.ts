import { describe, expect, it } from 'vitest';
import {
  buildLivePhoto,
  buildMotionPhoto,
  inspect,
  isContentIdentifier,
  liveToMotion,
  motionToLive,
  parseJpeg,
  parseMotionPhoto,
  parseSefTrailer,
  parseTiff,
  readLivePhotoStill,
  readMovieInfo,
  serializeTiff,
  setAppleContentIdentifier,
  summarizeExif,
  getAppleContentIdentifier,
  findExifSegment,
  EXIF_HEADER,
  findXmpSegment,
  xmpFromApp1,
  parseMotionPhotoXmp,
  rebuildJpeg,
  jpegExifModel,
  stampStill,
  MARKER,
} from '../src/index.js';
import { EXIFTOOL, FFMPEG, exiftoolJson, ffmpegDecodes, fixture, tmpFile } from './helpers.js';

const still = fixture('still.jpg');
const video = fixture('video.mp4');
const ffmov = fixture('ffmov.mov');

describe('Exif', () => {
  it('round-trips a TIFF blob and can add the Apple content identifier', () => {
    const seg = findExifSegment(parseJpeg(still))!;
    const model = parseTiff(seg.data.subarray(EXIF_HEADER.length));
    const before = summarizeExif(model);
    expect(before.make).toBe('samsung');
    expect(before.dateTimeOriginal).toBe('2026:09:20 10:11:12');

    const again = parseTiff(serializeTiff(model));
    expect(summarizeExif(again)).toEqual(before);

    const id = '0A1B2C3D-4E5F-4A6B-8C7D-9E0F1A2B3C4D';
    const stamped = parseTiff(serializeTiff(setAppleContentIdentifier(model, id)));
    expect(getAppleContentIdentifier(stamped)).toBe(id);
    expect(summarizeExif(stamped).make).toBe('samsung');
    expect(summarizeExif(stamped).hasAppleMakerNote).toBe(true);
  });

  it('creates Exif from scratch for a JPEG without any', () => {
    const p = parseJpeg(still);
    const bare = rebuildJpeg(still, p, p.segments.filter((s) => s.marker !== MARKER.APP1));
    expect(findExifSegment(parseJpeg(bare))).toBeUndefined();
    const id = '11111111-2222-4333-8444-555555555555';
    const out = stampStill(bare, id);
    expect(readLivePhotoStill(out)?.contentIdentifier).toBe(id);
  });
});

describe('Motion Photo build/parse', () => {
  const motion = buildMotionPhoto({ still, video, presentationTimestampUs: 500_000, imageUtcMs: 1_790_000_000_000 });

  it('embeds the video after EOI with Samsung + Google metadata', () => {
    const parsed = parseMotionPhoto(motion)!;
    expect(parsed).toBeDefined();
    expect(parsed.source).toBe('sef');
    expect(parsed.video).toEqual(video);
    expect(parsed.presentationTimestampUs).toBe(500_000);
    expect(parsed.imageUtcMs).toBe(1_790_000_000_000);
    expect(parsed.xmp?.motionPhoto).toBe(1);
    expect(parsed.xmp?.items.map((i) => i.semantic)).toEqual(['Primary', 'MotionPhoto']);
    expect(parsed.xmp?.items[1].length).toBe(video.byteLength);
    expect(parsed.xmp?.items[0].padding).toBe(8 + 'MotionPhoto_Data'.length);
    // MicroVideoOffset counts from end of file to the MP4 start.
    const start = motion.byteLength - parsed.xmp!.microVideoOffset!;
    expect(String.fromCharCode(...motion.subarray(start + 4, start + 8))).toBe('ftyp');

    const sef = parseSefTrailer(motion)!;
    expect(sef.blocks.map((b) => b.name)).toEqual(['MotionPhoto_Data', 'Image_UTC_Data']);

    // The clean still has no trailer and no motion hints.
    const cleanParsed = parseJpeg(parsed.still);
    expect(cleanParsed.trailer.byteLength).toBe(0);
    const x = findXmpSegment(cleanParsed);
    if (x) expect(parseMotionPhotoXmp(xmpFromApp1(x.data)).motionPhoto).toBeUndefined();
    expect(inspect(motion).kind).toBe('motion-photo');
    expect(inspect(parsed.still).kind).toBe('still');
  });

  it('is found via the Google container even without the Samsung trailer', () => {
    const m = buildMotionPhoto({ still, video, presentationTimestampUs: 0, samsungTrailer: false });
    const parsed = parseMotionPhoto(m)!;
    expect(parsed.source).toBe('xmp-container');
    expect(parsed.video).toEqual(video);
  });

  it('is found by scanning when the XMP lies', () => {
    const m = buildMotionPhoto({ still, video, samsungTrailer: false });
    // Corrupt the XMP lengths.
    const txt = new TextDecoder().decode(m);
    const bad = new TextEncoder().encode(txt.replace(/Item:Length="\d+"/g, 'Item:Length="1"').replace(/MicroVideoOffset="\d+"/, 'MicroVideoOffset="1"'));
    // (re-encoding a JPEG through TextDecoder corrupts binary bytes, so patch bytes directly instead)
    void bad;
    const idx = indexOfStr(m, 'Item:Length="' + video.byteLength + '"');
    const patched = m.slice();
    patched.set(new TextEncoder().encode('Item:Length="' + '1'.padStart(String(video.byteLength).length, '0') + '"'), idx);
    const parsed = parseMotionPhoto(patched)!;
    expect(parsed).toBeDefined();
    expect(parsed.video).toEqual(video);
  });

  it.runIf(EXIFTOOL)('is understood by exiftool (Samsung + Google readers)', () => {
    const j = exiftoolJson(tmpFile('motion.jpg', motion), ['-b']);
    expect(j['XMP-GCamera:MotionPhoto']).toBe(1);
    expect(j['XMP-GCamera:MicroVideoOffset']).toBeDefined();
    expect(j['Samsung:EmbeddedVideoType']).toBe('MotionPhoto_Data');
    const embedded = j['Samsung:EmbeddedVideoFile'] as string; // base64:...
    expect(embedded.startsWith('base64:')).toBe(true);
    expect(Buffer.from(embedded.slice(7), 'base64').byteLength).toBe(video.byteLength);
    expect(String(j['Samsung:TimeStamp'])).toMatch(/^2026:09:21 14:13:20/);
    const gv = j['Google:MotionPhotoVideo'] as string;
    expect(Buffer.from(gv.slice(7), 'base64').byteLength).toBe(video.byteLength);
    expect((j['XMP-GContainer:DirectoryItemSemantic'] as string[]) ?? j['XMP-Container:DirectoryItemSemantic']).toContain('MotionPhoto');
  });
});

describe('Live Photo build/parse', () => {
  const live = buildLivePhoto({ still, video, stillTimeSec: 0.5 });

  it('stamps the same identifier into both files and adds the still-image-time track', () => {
    expect(isContentIdentifier(live.contentIdentifier)).toBe(true);
    expect(readLivePhotoStill(live.still)?.contentIdentifier).toBe(live.contentIdentifier);
    const info = readMovieInfo(live.video);
    expect(info.contentIdentifier).toBe(live.contentIdentifier);
    expect(info.majorBrand).toBe('qt  ');
    expect(info.hasStillImageTimeTrack).toBe(true);
    expect(info.stillImageTimeSec).toBeCloseTo(0.5, 2);
    expect(info.tracks.map((t) => t.handler).sort()).toEqual(['meta', 'soun', 'vide']);
    expect(info.durationSec).toBeCloseTo(readMovieInfo(video).durationSec, 3);
    expect(inspect(live.still).kind).toBe('live-photo-still');
    expect(inspect(live.video).kind).toBe('live-photo-video');
  });

  it('is idempotent (re-running replaces instead of duplicating)', () => {
    const again = buildLivePhoto({ still: live.still, video: live.video, contentIdentifier: live.contentIdentifier, stillTimeSec: 0.25 });
    const info = readMovieInfo(again.video);
    expect(info.tracks.filter((t) => t.handler === 'meta')).toHaveLength(1);
    expect(info.stillImageTimeSec).toBeCloseTo(0.25, 2);
    expect(Object.keys(info.keys).filter((k) => k.endsWith('content.identifier'))).toHaveLength(1);
  });

  it('reads identifiers written by ffmpeg', () => {
    expect(readMovieInfo(ffmov).contentIdentifier).toBe('ABCDEF01-2345-6789-ABCD-EF0123456789');
  });

  it.runIf(EXIFTOOL)('is understood by exiftool', () => {
    const js = exiftoolJson(tmpFile('live.jpg', live.still));
    expect(js['Apple:ContentIdentifier']).toBe(live.contentIdentifier);
    expect(js['IFD0:Make']).toBe('samsung');
    const jv = exiftoolJson(tmpFile('live.mov', live.video), ['-ee']);
    expect(jv['Keys:ContentIdentifier']).toBe(live.contentIdentifier);
    expect(jv['QuickTime:MajorBrand']).toBe('qt  ');
    expect(jv['Track3:HandlerType']).toBe('meta');
    expect(jv['Track3:ContentDescribes']).toBe(1);
    const keys = Object.keys(jv).join(' ');
    expect(keys).toMatch(/StillImageTime/);
  });

  it.runIf(FFMPEG)('still decodes with ffmpeg after relayout', () => {
    expect(() => ffmpegDecodes(tmpFile('live.mov', live.video))).not.toThrow();
  });
});

describe('Conversions', () => {
  it('motion → live → motion keeps the video bytes and the key frame time', async () => {
    const motion = buildMotionPhoto({ still, video, presentationTimestampUs: 700_000 });
    const live = motionToLive(motion);
    expect(live.stillTimeSec).toBeCloseTo(0.7, 3);
    expect(readMovieInfo(live.video).stillImageTimeSec).toBeCloseTo(0.7, 2);

    const back = await liveToMotion(live.still, live.video);
    expect(back.pairedByIdentifier).toBe(true);
    expect(back.presentationTimestampUs).toBeCloseTo(700_000, -3);
    const parsed = parseMotionPhoto(back.file)!;
    const v = readMovieInfo(parsed.video);
    expect(v.majorBrand).toBe('mp42');
    expect(v.tracks.map((t) => t.handler).sort()).toEqual(['soun', 'vide']);
    // Media payload is untouched: the mdat bytes are identical.
    expect(mdatBytes(parsed.video)).toEqual(mdatBytes(video));
    // Exif survives the trip.
    expect(readLivePhotoStill(parsed.still)?.exif?.make).toBe('samsung');
  });

  it.runIf(FFMPEG)('converted motion video decodes with ffmpeg', async () => {
    const live = buildLivePhoto({ still, video, stillTimeSec: 0.3 });
    const back = await liveToMotion(live.still, live.video);
    const parsed = parseMotionPhoto(back.file)!;
    expect(() => ffmpegDecodes(tmpFile('back.mp4', parsed.video))).not.toThrow();
    expect(() => ffmpegDecodes(tmpFile('motion.jpg', back.file))).not.toThrow();
  });

  it('refuses non-motion input clearly', () => {
    expect(() => motionToLive(still)).toThrow(/Not a Motion Photo/);
  });

  it('exposes the exif model helper', () => {
    expect(summarizeExif(jpegExifModel(still)).model).toBe('SM-S928B');
  });
});

function indexOfStr(b: Uint8Array, s: string): number {
  const n = new TextEncoder().encode(s);
  outer: for (let i = 0; i <= b.length - n.length; i++) {
    for (let j = 0; j < n.length; j++) if (b[i + j] !== n[j]) continue outer;
    return i;
  }
  return -1;
}

/** First mdat payload — the media bytes. */
function mdatBytes(file: Uint8Array): Uint8Array {
  const dv = new DataView(file.buffer, file.byteOffset, file.byteLength);
  let p = 0;
  while (p + 8 <= file.byteLength) {
    const size = dv.getUint32(p);
    const type = String.fromCharCode(...file.subarray(p + 4, p + 8));
    if (type === 'mdat') return file.slice(p + 8, p + size);
    p += size;
  }
  throw new Error('no mdat');
}
