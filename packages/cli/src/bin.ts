#!/usr/bin/env node
import { readFile, writeFile, mkdir, stat, readdir } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  inspect,
  liveToMotion,
  motionToLive,
  parseMotionPhoto,
  readMovieInfo,
  isJpeg,
  isHeif,
  isVideoContainer,
  FormatError,
} from '@photoshare/core';
import { nodeHeicTranscoder } from './heic.js';

const HELP = `photoshare — move Live Photos and Motion Photos between iPhone and Galaxy

Usage:
  photoshare inspect  <file...>                     Describe what each file is
  photoshare to-live  <motion.jpg|heic...> [-o DIR] Motion Photo → Live Photo pair (still + .mov)
  photoshare to-motion <still> <video> [-o FILE]    Live Photo pair → Motion Photo JPEG
  photoshare to-motion <file|dir...> [-o DIR]       Pair stills/videos by file name, convert all
  photoshare convert  <file|dir...> [-o DIR]        Auto-detect direction for every input
  photoshare extract  <motion.jpg...> [-o DIR]      Split a Motion Photo into plain still + mp4

Options:
  -o, --out <path>       Output file or directory (default: next to the input)
  --still-time <sec>     Override key-frame time when making a Live Photo
  --ts <µs>              Override presentation timestamp when making a Motion Photo
  --id <uuid>            Reuse a content identifier instead of generating one
  --no-samsung           Skip the Samsung SEF trailer (Google-only Motion Photo)
  --keep-meta-tracks     Keep Apple timed-metadata tracks in the embedded MP4
  --quality <1-100>      JPEG quality when a HEIC still must be transcoded (default 92)
  --json                 Machine-readable output for inspect
  -h, --help             Show this help
`;

interface Opts {
  out?: string;
  stillTime?: number;
  ts?: number;
  id?: string;
  samsung: boolean;
  keepMetaTracks: boolean;
  quality: number;
  json: boolean;
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      out: { type: 'string', short: 'o' },
      'still-time': { type: 'string' },
      ts: { type: 'string' },
      id: { type: 'string' },
      'no-samsung': { type: 'boolean' },
      'keep-meta-tracks': { type: 'boolean' },
      quality: { type: 'string' },
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [cmd, ...files] = positionals;
  if (values.help || !cmd) {
    process.stdout.write(HELP);
    return cmd ? 0 : 1;
  }
  const opts: Opts = {
    out: values.out,
    stillTime: values['still-time'] !== undefined ? Number(values['still-time']) : undefined,
    ts: values.ts !== undefined ? Number(values.ts) : undefined,
    id: values.id,
    samsung: !values['no-samsung'],
    keepMetaTracks: !!values['keep-meta-tracks'],
    quality: values.quality ? Number(values.quality) : 92,
    json: !!values.json,
  };
  if (files.length === 0) throw new UsageError('no input files');
  switch (cmd) {
    case 'inspect':
      return cmdInspect(await expand(files), opts);
    case 'to-live':
      return cmdToLive(await expand(files), opts);
    case 'to-motion':
      return cmdToMotion(files, opts);
    case 'convert':
      return cmdConvert(await expand(files), opts);
    case 'extract':
      return cmdExtract(await expand(files), opts);
    default:
      throw new UsageError(`unknown command '${cmd}'`);
  }
}

class UsageError extends Error {}

const MEDIA_EXT = new Set(['.jpg', '.jpeg', '.heic', '.heif', '.mov', '.mp4']);

/** Expand directories into their media files (one level). */
async function expand(paths: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const p of paths) {
    const s = await stat(p);
    if (s.isDirectory()) {
      for (const f of (await readdir(p)).sort()) {
        if (MEDIA_EXT.has(extname(f).toLowerCase())) out.push(join(p, f));
      }
    } else out.push(p);
  }
  return out;
}

async function load(p: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(p));
}

async function outDir(opts: Opts, fallback: string): Promise<string> {
  const dir = opts.out ? resolve(opts.out) : fallback;
  await mkdir(dir, { recursive: true });
  return dir;
}

function stem(p: string): string {
  return basename(p, extname(p));
}

async function cmdInspect(files: string[], opts: Opts): Promise<number> {
  const results = [];
  for (const f of files) {
    const info = inspect(await load(f));
    results.push({ file: f, ...info });
    if (!opts.json) {
      const lines = [`${f}`, `  kind: ${info.kind} (${info.container}, ${fmtBytes(info.size)})`];
      if (info.contentIdentifier) lines.push(`  content identifier: ${info.contentIdentifier}`);
      if (info.exif?.make || info.exif?.model) lines.push(`  camera: ${[info.exif.make, info.exif.model].filter(Boolean).join(' ')}`);
      if (info.exif?.dateTimeOriginal) lines.push(`  taken: ${info.exif.dateTimeOriginal} ${info.exif.offsetTimeOriginal ?? ''}`.trimEnd());
      if (info.motion) {
        const v = info.motion.video;
        lines.push(`  embedded video: ${fmtBytes(info.motion.videoBytes)} via ${info.motion.source}` + (v ? `, ${v.durationSec.toFixed(2)}s ${v.tracks.find((t) => t.handler === 'vide')?.format ?? ''}` : ''));
        if (info.motion.presentationTimestampUs !== undefined) lines.push(`  key frame: ${(info.motion.presentationTimestampUs / 1e6).toFixed(3)}s`);
      }
      if (info.movie) {
        lines.push(`  duration: ${info.movie.durationSec.toFixed(2)}s, tracks: ${info.movie.tracks.map((t) => `${t.handler}/${t.format ?? '?'}`).join(' ')}`);
        if (info.movie.stillImageTimeSec !== undefined) lines.push(`  key frame: ${info.movie.stillImageTimeSec.toFixed(3)}s`);
      }
      for (const n of info.notes) lines.push(`  note: ${n}`);
      console.log(lines.join('\n'));
    }
  }
  if (opts.json) console.log(JSON.stringify(results, null, 2));
  return 0;
}

async function writeLivePair(f: string, data: Uint8Array, opts: Opts): Promise<void> {
  const dir = await outDir(opts, dirname(resolve(f)));
  const res = motionToLive(data, { stillTimeSec: opts.stillTime, contentIdentifier: opts.id });
  const ext = res.stillContainer === 'heif' ? '.heic' : '.jpg';
  const stillPath = join(dir, stem(f) + ext);
  const movPath = join(dir, stem(f) + '.mov');
  await writeFile(stillPath, res.still);
  await writeFile(movPath, res.video);
  console.log(`✓ ${f} → ${basename(stillPath)} + ${basename(movPath)}  (id ${res.contentIdentifier}, key frame ${res.stillTimeSec.toFixed(3)}s)`);
}

async function cmdToLive(files: string[], opts: Opts): Promise<number> {
  let failures = 0;
  for (const f of files) {
    try {
      await writeLivePair(f, await load(f), opts);
    } catch (e) {
      failures++;
      console.error(`✗ ${f}: ${(e as Error).message}`);
    }
  }
  return failures ? 1 : 0;
}

async function writeMotion(stillPath: string, videoPath: string, opts: Opts, explicitOut?: string): Promise<void> {
  const still = await load(stillPath);
  const video = await load(videoPath);
  const res = await liveToMotion(still, video, {
    transcodeHeic: nodeHeicTranscoder(opts.quality),
    presentationTimestampUs: opts.ts,
    keepMetadataTracks: opts.keepMetaTracks,
    samsungTrailer: opts.samsung,
  });
  const target = explicitOut ?? join(await outDir(opts, dirname(resolve(stillPath))), stem(stillPath) + '.jpg');
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, res.file);
  const notes = [res.transcoded ? 'HEIC transcoded to JPEG' : null, res.pairedByIdentifier ? 'identifiers matched' : 'identifiers did not match (paired by name)'].filter(Boolean);
  console.log(`✓ ${basename(stillPath)} + ${basename(videoPath)} → ${basename(target)}  (key frame ${(res.presentationTimestampUs / 1e6).toFixed(3)}s; ${notes.join(', ')})`);
}

/** Group stills and videos that share a base name. */
function pairByName(files: string[]): { still: string; video: string }[] {
  const stills = new Map<string, string>();
  const videos = new Map<string, string>();
  for (const f of files) {
    const e = extname(f).toLowerCase();
    const key = join(dirname(f), stem(f).toLowerCase());
    if (e === '.jpg' || e === '.jpeg' || e === '.heic' || e === '.heif') stills.set(key, f);
    else if (e === '.mov' || e === '.mp4') videos.set(key, f);
  }
  const pairs: { still: string; video: string }[] = [];
  for (const [k, still] of stills) {
    const video = videos.get(k);
    if (video) pairs.push({ still, video });
  }
  return pairs;
}

async function cmdToMotion(inputs: string[], opts: Opts): Promise<number> {
  // Explicit pair: two files, still + video.
  if (inputs.length === 2) {
    const [a, b] = await Promise.all(inputs.map(load));
    const isStill = (d: Uint8Array) => isJpeg(d) || isHeif(d);
    if (isStill(a) && isVideoContainer(b)) {
      await writeMotion(inputs[0], inputs[1], opts, opts.out && extname(opts.out) ? resolve(opts.out) : undefined);
      return 0;
    }
    if (isStill(b) && isVideoContainer(a)) {
      await writeMotion(inputs[1], inputs[0], opts, opts.out && extname(opts.out) ? resolve(opts.out) : undefined);
      return 0;
    }
  }
  const pairs = pairByName(await expand(inputs));
  if (!pairs.length) throw new UsageError('no still+video pairs found (files must share a base name, e.g. IMG_0001.HEIC + IMG_0001.MOV)');
  let failures = 0;
  for (const p of pairs) {
    try {
      await writeMotion(p.still, p.video, opts);
    } catch (e) {
      failures++;
      console.error(`✗ ${p.still}: ${(e as Error).message}`);
    }
  }
  return failures ? 1 : 0;
}

async function cmdConvert(files: string[], opts: Opts): Promise<number> {
  let failures = 0;
  const leftovers: string[] = [];
  for (const f of files) {
    const data = await load(f);
    if ((isJpeg(data) || isHeif(data)) && parseMotionPhoto(data)) {
      try {
        await writeLivePair(f, data, opts);
      } catch (e) {
        failures++;
        console.error(`✗ ${f}: ${(e as Error).message}`);
      }
    } else leftovers.push(f);
  }
  for (const p of pairByName(leftovers)) {
    try {
      await writeMotion(p.still, p.video, opts);
    } catch (e) {
      failures++;
      console.error(`✗ ${p.still}: ${(e as Error).message}`);
    }
  }
  return failures ? 1 : 0;
}

async function cmdExtract(files: string[], opts: Opts): Promise<number> {
  let failures = 0;
  for (const f of files) {
    try {
      const data = await load(f);
      const m = parseMotionPhoto(data);
      if (!m) throw new FormatError('not a Motion Photo');
      const dir = await outDir(opts, dirname(resolve(f)));
      const ext = m.container === 'heif' ? '.heic' : '.jpg';
      await writeFile(join(dir, stem(f) + '.still' + ext), m.still);
      await writeFile(join(dir, stem(f) + '.mp4'), m.video);
      const v = readMovieInfo(m.video);
      console.log(`✓ ${f} → ${stem(f)}.still${ext} + ${stem(f)}.mp4 (${v.durationSec.toFixed(2)}s)`);
    } catch (e) {
      failures++;
      console.error(`✗ ${f}: ${(e as Error).message}`);
    }
  }
  return failures ? 1 : 0;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e) => {
    if (e instanceof UsageError) {
      console.error(`error: ${e.message}\n`);
      process.stderr.write(HELP);
    } else {
      console.error(`error: ${(e as Error).message}`);
    }
    process.exit(2);
  },
);
