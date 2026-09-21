/**
 * Tests against real files shot on phones. They are not vendored; run
 * `scripts/fetch-samples.sh` first (or point REAL_SAMPLES_DIR at a folder).
 * Every test is skipped when its file is missing so CI stays green offline.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildLivePhoto,
  inspect,
  liveToMotion,
  motionToLive,
  parseMotionPhoto,
  parseSefTrailer,
  readLivePhotoStill,
  readMovieInfo,
} from '../src/index.js';
import { FFMPEG, ffmpegDecodes, tmpFile } from './helpers.js';

const DIR = process.env.REAL_SAMPLES_DIR ?? resolve(new URL('.', import.meta.url).pathname, '../../../samples');
const have = (name: string) => existsSync(join(DIR, name));
const load = (name: string) => new Uint8Array(readFileSync(join(DIR, name)));

describe('real Samsung motion photos', () => {
  for (const [name, model] of [
    ['galaxy-oneui5-motion.jpg', 'SM-T970'],
    ['galaxy-oneui6-motion.jpg', 'SM-F711N'],
  ] as const) {
    it.runIf(have(name))(`${name}: parses like Samsung Gallery and Google Photos would`, () => {
      const file = load(name);
      const m = parseMotionPhoto(file)!;
      expect(m.source).toBe('sef');
      expect(m.exif?.model).toBe(model);
      expect(m.presentationTimestampUs).toBeGreaterThan(2_000_000);
      // Google's rule: EOF - video item Length == start of the MP4.
      const vStart = file.byteLength - m.xmp!.items[1].length!;
      expect(String.fromCharCode(...file.subarray(vStart + 4, vStart + 8))).toBe('ftyp');
      expect(m.video.byteLength).toBeLessThanOrEqual(m.xmp!.items[1].length!);
      expect(parseSefTrailer(file)!.version).toBe(107);
    });
  }
});

describe('real Pixel motion photos', () => {
  it.runIf(have('pixel7pro-motion.jpg'))('Pixel 7 Pro: two HEVC tracks are pruned to one for the Live Photo', () => {
    const live = motionToLive(load('pixel7pro-motion.jpg'));
    const info = readMovieInfo(live.video);
    expect(info.tracks.filter((t) => t.handler === 'vide')).toHaveLength(1);
    expect(info.tracks.filter((t) => t.handler === 'meta')).toHaveLength(1);
    expect(info.stillImageTimeSec).toBeCloseTo(1.134, 2);
  });
  it.runIf(have('galaxy-s20-motion-shortened.jpg'))('Galaxy S20 (One UI 2) legacy MicroVideo layout is found', () => {
    const m = parseMotionPhoto(load('galaxy-s20-motion-shortened.jpg'))!;
    expect(m.source).toBe('micro-video');
    expect(readMovieInfo(m.video).tracks.some((t) => t.handler === 'vide')).toBe(true);
  });
});

describe('real iPhone Live Photo', () => {
  const ok = have('iphone6s-live.jpg') && have('iphone6s-live.mov');
  it.runIf(ok)('reads the pair the way Photos wrote it', () => {
    const still = readLivePhotoStill(load('iphone6s-live.jpg'))!;
    const mov = readMovieInfo(load('iphone6s-live.mov'));
    expect(still.contentIdentifier).toBe(mov.contentIdentifier);
    expect(mov.hasStillImageTimeTrack).toBe(true);
    expect(mov.stillImageTimeSec).toBeCloseTo(0.48, 3);
  });
  it.runIf(ok)('round-trips through a Motion Photo and back, keeping the key frame', async () => {
    const motion = await liveToMotion(load('iphone6s-live.jpg'), load('iphone6s-live.mov'));
    expect(motion.pairedByIdentifier).toBe(true);
    expect(motion.presentationTimestampUs).toBe(480_000);
    const back = motionToLive(motion.file);
    expect(readMovieInfo(back.video).stillImageTimeSec).toBeCloseTo(0.48, 3);
    expect(inspect(back.still).kind).toBe('live-photo-still');
  });
  it.runIf(ok && FFMPEG)('converted files decode with ffmpeg', async () => {
    const motion = await liveToMotion(load('iphone6s-live.jpg'), load('iphone6s-live.mov'));
    expect(() => ffmpegDecodes(tmpFile('iphone.jpg', motion.file))).not.toThrow();
  });
  it.runIf(ok)('our still-image-time track matches Apple’s layout box for box', () => {
    const apple = trackBoxes(load('iphone6s-live.mov'), 'still-image-time');
    const ours = trackBoxes(buildLivePhoto({ still: load('iphone6s-live.jpg'), video: load('iphone6s-live.mov'), stillTimeSec: 0.48 }).video, 'still-image-time');
    expect(ours).toEqual(apple);
  });
});

describe('real iPhone HEIC', () => {
  it.runIf(have('iphone7-still.heic') && have('iphone6s-live.mov'))('gets a content identifier without disturbing the existing Apple MakerNote', () => {
    const live = buildLivePhoto({ still: load('iphone7-still.heic'), video: load('iphone6s-live.mov') });
    const s = readLivePhotoStill(live.still)!;
    expect(s.contentIdentifier).toBe(live.contentIdentifier);
    expect(s.exif?.model).toBe('iPhone 7');
    expect(s.exif?.hasAppleMakerNote).toBe(true);
  });
});

describe('real Samsung HEIC motion photo', () => {
  it.runIf(have('galaxy-oneui6-motion.heic'))('video is found in the mpvd box and the HEIC still is preserved', () => {
    const m = parseMotionPhoto(load('galaxy-oneui6-motion.heic'))!;
    expect(m.container).toBe('heif');
    expect(m.source).toBe('mpvd');
    expect(readMovieInfo(m.video).tracks.some((t) => t.handler === 'vide')).toBe(true);
    const live = motionToLive(load('galaxy-oneui6-motion.heic'));
    expect(live.stillContainer).toBe('heif');
    expect(readLivePhotoStill(live.still)?.contentIdentifier).toBe(live.contentIdentifier);
  });
});

/** Box types + sizes (offsets and timestamps excluded) of the trak carrying `key`. */
function trackBoxes(file: Uint8Array, key: string): string[] {
  const dv = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const str = (o: number, n: number) => String.fromCharCode(...file.subarray(o, o + n));
  const out: string[] = [];
  const walk = (s: number, e: number, depth: number, path: string, collect: boolean) => {
    let p = s;
    while (p + 8 <= e) {
      let size = dv.getUint32(p);
      const type = str(p + 4, 4);
      let hs = 8;
      if (size === 1) {
        size = Number(dv.getBigUint64(p + 8));
        hs = 16;
      } else if (size === 0) size = e - p;
      if (depth === 1) collect = type === 'trak' && str(p, size).includes(key);
      if (collect && !['stco', 'co64'].includes(type)) out.push(`${path}/${type}:${size}`);
      if (['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'dinf', 'tref', 'gmhd'].includes(type)) walk(p + hs, p + size, depth + 1, `${path}/${type}`, collect);
      else if (type === 'stsd' || type === 'mebx' || type === 'dref') walk(p + hs + 8, p + size, depth + 1, `${path}/${type}`, collect);
      p += size;
    }
  };
  walk(0, file.byteLength, 0, '', false);
  return out;
}
