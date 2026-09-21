import { describe, expect, it } from 'vitest';
import {
  buildLivePhoto,
  findHeifMotionVideo,
  heifLayout,
  inspect,
  isHeif,
  parseMotionPhoto,
  readHeifExif,
  readLivePhotoStill,
  summarizeExif,
  concat,
  buildSefTrailer,
  sefMotionPhotoBlock,
  box,
} from '../src/index.js';
import { EXIFTOOL, exiftoolJson, fixture, tmpFile } from './helpers.js';

const heic = fixture('still.heic');
const video = fixture('video.mp4');

describe('HEIC', () => {
  it('reads the Exif item', () => {
    expect(isHeif(heic)).toBe(true);
    const e = readHeifExif(heic)!;
    expect(summarizeExif(e.model).make).toBe('Apple');
    expect(summarizeExif(e.model).dateTimeOriginal).toBe('2026:09:20 10:11:12');
    expect(heifLayout(heic).end).toBe(heic.byteLength);
  });

  it('stamps a content identifier without touching image data', () => {
    const live = buildLivePhoto({ still: heic, video, stillTimeSec: 0.2 });
    expect(live.stillContainer).toBe('heif');
    expect(readLivePhotoStill(live.still)?.contentIdentifier).toBe(live.contentIdentifier);
    expect(readLivePhotoStill(live.still)?.exif?.make).toBe('Apple');
    // Original bytes are a prefix (we only append + patch iloc).
    const layout = heifLayout(live.still);
    expect(layout.boxes.at(-1)?.type).toBe('mdat');
    expect(inspect(live.still).kind).toBe('live-photo-still');
  });

  it.runIf(EXIFTOOL)('stamped HEIC is understood by exiftool', () => {
    const live = buildLivePhoto({ still: heic, video, contentIdentifier: 'ABCDEF01-2345-4689-ABCD-EF0123456789' });
    const j = exiftoolJson(tmpFile('live.heic', live.still));
    expect(j['Apple:ContentIdentifier']).toBe('ABCDEF01-2345-4689-ABCD-EF0123456789');
    expect(j['IFD0:Make']).toBe('Apple');
    expect(JSON.stringify(j)).not.toMatch(/Warning/);
  });

  it('extracts motion video from Samsung-style HEIC (SEF trailer) and Google-style (mpvd)', () => {
    const samsung = concat([heic, buildSefTrailer([sefMotionPhotoBlock(video)])]);
    const a = findHeifMotionVideo(samsung)!;
    expect(a.source).toBe('sef-trailer');
    expect(a.video).toEqual(video);
    const ma = parseMotionPhoto(samsung)!;
    expect(ma.container).toBe('heif');
    expect(ma.still).toEqual(heic);

    const google = concat([heic, box('mpvd', video)]);
    const b = findHeifMotionVideo(google)!;
    expect(b.source).toBe('mpvd');
    expect(b.video).toEqual(video);
    expect(parseMotionPhoto(google)!.still).toEqual(heic);
    expect(inspect(google).kind).toBe('motion-photo');
  });
});
