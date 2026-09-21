import { inspect, isHeif, isJpeg, isVideoContainer, liveToMotion, motionToLive, parseMotionPhoto } from '@photoshare/core';
import { browserHeicTranscoder } from './heic.js';
import { zip } from './zip.js';

/**
 * Everything runs in the page: read the dropped files, decide the direction per
 * file (or per still+video pair), convert, and offer downloads.
 */

interface Output {
  name: string;
  data: Uint8Array;
  mime: string;
}

interface Job {
  id: number;
  title: string;
  kind: 'to-live' | 'to-motion' | 'info';
  status: 'working' | 'done' | 'error';
  detail: string;
  outputs: Output[];
  previewUrl?: string;
}

const $ = <T extends Element>(sel: string) => document.querySelector(sel) as T;
const drop = $<HTMLElement>('#drop');
const input = $<HTMLInputElement>('#file');
const results = $<HTMLElement>('#results');
const list = $<HTMLUListElement>('#list');
const downloadAll = $<HTMLButtonElement>('#download-all');
const clearBtn = $<HTMLButtonElement>('#clear');

const jobs: Job[] = [];
let nextId = 1;

drop.addEventListener('click', () => input.click());
drop.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') input.click();
});
input.addEventListener('change', () => {
  if (input.files) void handleFiles([...input.files]);
  input.value = '';
});
for (const ev of ['dragenter', 'dragover']) {
  drop.addEventListener(ev, (e) => {
    e.preventDefault();
    drop.classList.add('over');
  });
}
for (const ev of ['dragleave', 'drop']) {
  drop.addEventListener(ev, (e) => {
    e.preventDefault();
    drop.classList.remove('over');
  });
}
drop.addEventListener('drop', (e) => {
  const files = [...(e.dataTransfer?.files ?? [])];
  if (files.length) void handleFiles(files);
});
clearBtn.addEventListener('click', () => {
  for (const j of jobs) if (j.previewUrl) URL.revokeObjectURL(j.previewUrl);
  jobs.length = 0;
  render();
});
downloadAll.addEventListener('click', () => {
  const files = jobs.flatMap((j) => j.outputs).map((o) => ({ name: o.name, data: o.data }));
  if (files.length) save(zip(files), 'photoshare.zip', 'application/zip');
});

const stem = (n: string) => n.replace(/\.[^.]+$/, '');
const ext = (n: string) => (n.match(/\.([^.]+)$/)?.[1] ?? '').toLowerCase();

async function handleFiles(files: File[]) {
  results.hidden = false;
  const loaded = await Promise.all(files.map(async (f) => ({ file: f, data: new Uint8Array(await f.arrayBuffer()) })));

  const stills = new Map<string, { file: File; data: Uint8Array }>();
  const videos = new Map<string, { file: File; data: Uint8Array }>();
  const singles: { file: File; data: Uint8Array }[] = [];

  for (const item of loaded) {
    const { data } = item;
    if ((isJpeg(data) || isHeif(data)) && parseMotionPhoto(data)) {
      void runJob(item.file.name, 'to-live', async () => convertToLive(item.file, data));
    } else if (isJpeg(data) || isHeif(data)) {
      stills.set(stem(item.file.name).toLowerCase(), item);
    } else if (isVideoContainer(data)) {
      videos.set(stem(item.file.name).toLowerCase(), item);
    } else {
      singles.push(item);
    }
  }
  // Pair by base name; a lone still + lone video also count as a pair.
  if (stills.size === 1 && videos.size === 1 && ![...stills.keys()][0].startsWith([...videos.keys()][0])) {
    const [s] = stills.values();
    const [v] = videos.values();
    stills.clear();
    videos.clear();
    void runJob(`${s.file.name} + ${v.file.name}`, 'to-motion', async () => convertToMotion(s.file, s.data, v.file, v.data));
  }
  for (const [key, s] of stills) {
    const v = videos.get(key);
    if (v) {
      videos.delete(key);
      void runJob(`${s.file.name} + ${v.file.name}`, 'to-motion', async () => convertToMotion(s.file, s.data, v.file, v.data));
    } else singles.push(s);
  }
  for (const v of videos.values()) singles.push(v);
  for (const item of singles) void runJob(item.file.name, 'info', async () => describe(item.file, item.data));
}

async function runJob(title: string, kind: Job['kind'], fn: () => Promise<Partial<Job>>) {
  const job: Job = { id: nextId++, title, kind, status: 'working', detail: '변환 중…', outputs: [] };
  jobs.push(job);
  render();
  try {
    Object.assign(job, await fn(), { status: 'done' });
  } catch (e) {
    job.status = 'error';
    job.detail = (e as Error).message;
  }
  render();
}

async function convertToLive(file: File, data: Uint8Array): Promise<Partial<Job>> {
  const res = motionToLive(data);
  const base = stem(file.name);
  const stillExt = res.stillContainer === 'heif' ? 'HEIC' : 'JPG';
  const outputs: Output[] = [
    { name: `${base}.${stillExt}`, data: res.still, mime: res.stillContainer === 'heif' ? 'image/heic' : 'image/jpeg' },
    { name: `${base}.MOV`, data: res.video, mime: 'video/quicktime' },
  ];
  const cam = [res.motion.exif?.make, res.motion.exif?.model].filter(Boolean).join(' ');
  return {
    title: `${file.name} → 라이브포토`,
    detail: `<span class="ok">완료</span> · 영상 ${fmt(res.video.byteLength)}, 키 프레임 ${res.stillTimeSec.toFixed(2)}s${cam ? ' · ' + cam : ''} · ID ${res.contentIdentifier.slice(0, 8)}…`,
    outputs,
    previewUrl: res.stillContainer === 'jpeg' ? URL.createObjectURL(blobOf(res.still, 'image/jpeg')) : undefined,
  };
}

async function convertToMotion(still: File, stillData: Uint8Array, video: File, videoData: Uint8Array): Promise<Partial<Job>> {
  const res = await liveToMotion(stillData, videoData, { transcodeHeic: browserHeicTranscoder });
  const name = `${stem(still.name)}.jpg`;
  const notes = [
    res.transcoded ? 'HEIC → JPEG 변환' : 'JPEG 원본 유지',
    res.pairedByIdentifier ? '식별자 일치' : '이름으로 짝지음',
    `키 프레임 ${(res.presentationTimestampUs / 1e6).toFixed(2)}s`,
  ];
  return {
    title: `${still.name} + ${video.name} → 모션포토`,
    detail: `<span class="ok">완료</span> · ${notes.join(' · ')} · ${fmt(res.file.byteLength)}`,
    outputs: [{ name, data: res.file, mime: 'image/jpeg' }],
    previewUrl: URL.createObjectURL(blobOf(res.file, 'image/jpeg')),
  };
}

async function describe(file: File, data: Uint8Array): Promise<Partial<Job>> {
  const info = inspect(data);
  const kindKo: Record<string, string> = {
    'live-photo-still': '라이브포토 정지 이미지 (짝이 되는 MOV를 함께 넣으세요)',
    'live-photo-video': '라이브포토 영상 (짝이 되는 HEIC/JPG를 함께 넣으세요)',
    still: '일반 사진 (움직임 없음)',
    video: '일반 영상 (같은 이름의 사진과 함께 넣으면 모션포토로 합칩니다)',
    unknown: '알 수 없는 파일',
    'motion-photo': '모션포토',
  };
  return {
    title: file.name,
    detail: `${kindKo[info.kind] ?? info.kind}${info.notes.length ? ' · ' + info.notes.join(' · ') : ''}`,
  };
}

function render() {
  results.hidden = jobs.length === 0;
  downloadAll.disabled = !jobs.some((j) => j.outputs.length);
  list.replaceChildren(
    ...jobs.map((j) => {
      const li = document.createElement('li');
      li.className = 'item';
      const thumb = j.previewUrl
        ? Object.assign(document.createElement('img'), { className: 'thumb', src: j.previewUrl, alt: '' })
        : Object.assign(document.createElement('div'), { className: 'thumb', textContent: j.kind === 'to-live' ? '🍎' : j.kind === 'to-motion' ? '🤖' : 'ℹ️' });
      const body = document.createElement('div');
      body.innerHTML = `<div class="item-title"></div><div class="item-sub">${
        j.status === 'working' ? '<span class="spinner"></span>변환 중…' : j.status === 'error' ? `<span class="err">실패</span> · ${escapeHtml(j.detail)}` : j.detail
      }</div>`;
      body.querySelector('.item-title')!.textContent = j.title;
      const actions = document.createElement('div');
      actions.className = 'item-actions';
      for (const o of j.outputs) {
        const b = document.createElement('button');
        b.className = 'btn small';
        b.textContent = `⬇ ${o.name}`;
        b.onclick = () => save(o.data, o.name, o.mime);
        actions.append(b);
      }
      if (j.outputs.length > 1) {
        const b = document.createElement('button');
        b.className = 'btn small primary';
        b.textContent = 'ZIP으로 함께 저장';
        b.onclick = () => save(zip(j.outputs.map((o) => ({ name: o.name, data: o.data }))), `${stem(j.outputs[0].name)}.zip`, 'application/zip');
        actions.append(b);
      }
      li.append(thumb, body, actions);
      return li;
    }),
  );
}

function save(data: Uint8Array, name: string, mime: string) {
  const url = URL.createObjectURL(blobOf(data, mime));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Copy into a plain ArrayBuffer-backed view so TypeScript accepts it as a BlobPart. */
function blobOf(data: Uint8Array, type: string): Blob {
  return new Blob([new Uint8Array(data)], { type });
}

function fmt(n: number): string {
  return n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}
