import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const fixturesDir = new URL('./fixtures/', import.meta.url).pathname;

export function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(fixturesDir, name)));
}

import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';

const require = createRequire(import.meta.url);

function resolveOptional(id: string): string | undefined {
  try {
    return require.resolve(id);
  } catch {
    return undefined;
  }
}

/** "perl /path/to/exiftool" — from $EXIFTOOL or the vendored devDependency. */
export const EXIFTOOL: string | undefined =
  process.env.EXIFTOOL ??
  (() => {
    const pkg = resolveOptional('exiftool-vendored.pl/package.json');
    if (!pkg) return undefined;
    const bin = join(pkg, '..', 'bin', 'exiftool');
    return existsSync(bin) ? `perl ${bin}` : undefined;
  })();

/** ffmpeg binary — from $FFMPEG or ffmpeg-static (only if its postinstall actually downloaded it). */
export const FFMPEG: string | undefined =
  process.env.FFMPEG ??
  (() => {
    try {
      const p = require('ffmpeg-static') as string | null;
      return p && existsSync(p) ? p : undefined;
    } catch {
      return undefined;
    }
  })();

export function tmpFile(name: string, data: Uint8Array): string {
  const dir = mkdtempSync(join(tmpdir(), 'photoshare-'));
  const p = join(dir, name);
  writeFileSync(p, data);
  return p;
}

/** Run exiftool with -j and return the first object. */
export function exiftoolJson(file: string, args: string[] = []): Record<string, unknown> {
  if (!EXIFTOOL) throw new Error('EXIFTOOL not set');
  const [cmd, ...pre] = EXIFTOOL.split(' ');
  const out = execFileSync(cmd, [...pre, '-j', '-G1', '-a', '-n', ...args, file], { encoding: 'utf8', maxBuffer: 64 << 20 });
  return JSON.parse(out)[0];
}

/** ffmpeg decode check: throws when the container is broken. */
export function ffmpegDecodes(file: string): string {
  if (!FFMPEG) throw new Error('FFMPEG not set');
  return execFileSync(FFMPEG, ['-v', 'error', '-xerror', '-i', file, '-f', 'null', '-'], { encoding: 'utf8' });
}
