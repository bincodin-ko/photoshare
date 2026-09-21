import { isHeif, isVideoContainer, majorBrand } from './isobmff/boxes.js';
import { findHeifMotionVideo, readHeifExif } from './isobmff/heif.js';
import { MovieInfo, readMovieInfo } from './isobmff/quicktime.js';
import { ExifSummary, summarizeExif } from './jpeg/exif.js';
import { isJpeg } from './jpeg/segments.js';
import { readLivePhotoStill } from './livephoto.js';
import { MotionPhoto, parseMotionPhoto } from './motionphoto.js';

export type FileKind =
  | 'motion-photo'
  | 'live-photo-still'
  | 'live-photo-video'
  | 'still'
  | 'video'
  | 'unknown';

export interface Inspection {
  kind: FileKind;
  container: 'jpeg' | 'heif' | 'mp4' | 'unknown';
  size: number;
  exif?: ExifSummary;
  contentIdentifier?: string;
  motion?: Omit<MotionPhoto, 'still' | 'video' | 'sef' | 'xmp' | 'exif'> & { videoBytes: number; video?: MovieInfo };
  movie?: MovieInfo;
  notes: string[];
}

/** Describe what a file is, from the point of view of Live/Motion photos. */
export function inspect(file: Uint8Array): Inspection {
  const notes: string[] = [];
  const size = file.byteLength;
  if (isJpeg(file) || isHeif(file)) {
    const container = isJpeg(file) ? 'jpeg' : 'heif';
    const motion = parseMotionPhoto(file);
    if (motion) {
      let video: MovieInfo | undefined;
      try {
        video = readMovieInfo(motion.video);
      } catch (e) {
        notes.push(`embedded video unreadable: ${(e as Error).message}`);
      }
      const { still: _s, video: _v, sef, xmp, exif, ...rest } = motion;
      if (sef) notes.push(`Samsung SEF trailer v${sef.version}: ${sef.blocks.map((b) => b.name).join(', ')}`);
      if (xmp?.motionPhoto === 1) notes.push('XMP: GCamera:MotionPhoto v' + (xmp.motionPhotoVersion ?? '?'));
      if (xmp?.microVideo === 1) notes.push('XMP: GCamera:MicroVideo (legacy)');
      return { kind: 'motion-photo', container, size, exif, motion: { ...rest, videoBytes: motion.video.byteLength, video }, notes };
    }
    const still = readLivePhotoStill(file);
    if (still?.contentIdentifier) notes.push('Apple MakerNote ContentIdentifier present');
    if (container === 'heif') {
      const e = readHeifExif(file);
      if (!e) notes.push('HEIC has no Exif item');
      if (findHeifMotionVideo(file)) notes.push('HEIC has a motion video');
    }
    return {
      kind: still?.contentIdentifier ? 'live-photo-still' : 'still',
      container,
      size,
      exif: still?.exif,
      contentIdentifier: still?.contentIdentifier,
      notes,
    };
  }
  if (isVideoContainer(file)) {
    try {
      const movie = readMovieInfo(file);
      const isLive = !!movie.contentIdentifier;
      if (movie.hasStillImageTimeTrack) notes.push(`still-image-time track at ${movie.stillImageTimeSec?.toFixed(3)}s`);
      else if (isLive) notes.push('no still-image-time track (Photos will use frame 0)');
      notes.push(`brand ${majorBrand(file)}`);
      return { kind: isLive ? 'live-photo-video' : 'video', container: 'mp4', size, contentIdentifier: movie.contentIdentifier, movie, notes };
    } catch (e) {
      notes.push((e as Error).message);
      return { kind: 'video', container: 'mp4', size, notes };
    }
  }
  return { kind: 'unknown', container: 'unknown', size, notes };
}

export { summarizeExif };
