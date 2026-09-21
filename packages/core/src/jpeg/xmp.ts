import { decodeUtf8, utf8 } from '../bytes.js';

/**
 * XMP for Motion Photos. Two generations exist in the wild and we write both:
 *
 *  - "MicroVideo" (Google Pixel 2/3, Samsung One UI 1–2): GCamera:MicroVideo=1,
 *    GCamera:MicroVideoOffset = bytes from end-of-file to start of the MP4.
 *  - "MotionPhoto v1" (Pixel 4+, Samsung One UI 3+): GCamera:MotionPhoto=1 and
 *    a Container:Directory listing the Primary image and the MotionPhoto item
 *    laid out sequentially after the primary image's EOI.
 */

export const NS = {
  GCamera: 'http://ns.google.com/photos/1.0/camera/',
  Container: 'http://ns.google.com/photos/1.0/container/',
  Item: 'http://ns.google.com/photos/1.0/container/item/',
  rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
  x: 'adobe:ns:meta/',
} as const;

export interface MotionPhotoXmp {
  motionPhoto?: number;
  motionPhotoVersion?: number;
  /** Presentation timestamp (µs) of the still frame within the video. */
  presentationTimestampUs?: number;
  microVideo?: number;
  microVideoVersion?: number;
  microVideoOffset?: number;
  microVideoPresentationTimestampUs?: number;
  /** Container items in file order. */
  items: ContainerItem[];
}

export interface ContainerItem {
  mime?: string;
  semantic?: string;
  length?: number;
  padding?: number;
}

function attrOrElement(xml: string, qname: string): string | undefined {
  const esc = qname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const a = new RegExp(`\\b${esc}\\s*=\\s*"([^"]*)"`).exec(xml) || new RegExp(`\\b${esc}\\s*=\\s*'([^']*)'`).exec(xml);
  if (a) return a[1];
  const e = new RegExp(`<${esc}(?:\\s[^>]*)?>([^<]*)</${esc}>`).exec(xml);
  return e ? e[1].trim() : undefined;
}

function num(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export function parseMotionPhotoXmp(xml: string): MotionPhotoXmp {
  const out: MotionPhotoXmp = {
    motionPhoto: num(attrOrElement(xml, 'GCamera:MotionPhoto')),
    motionPhotoVersion: num(attrOrElement(xml, 'GCamera:MotionPhotoVersion')),
    presentationTimestampUs: num(attrOrElement(xml, 'GCamera:MotionPhotoPresentationTimestampUs')),
    microVideo: num(attrOrElement(xml, 'GCamera:MicroVideo')),
    microVideoVersion: num(attrOrElement(xml, 'GCamera:MicroVideoVersion')),
    microVideoOffset: num(attrOrElement(xml, 'GCamera:MicroVideoOffset')),
    microVideoPresentationTimestampUs: num(attrOrElement(xml, 'GCamera:MicroVideoPresentationTimestampUs')),
    items: [],
  };
  // Items appear either as <Container:Item .../> (attribute form) or as
  // <rdf:li><Container:Item><Item:Mime>..</Item:Mime></Container:Item></rdf:li>.
  const itemRe = /<Container:Item\b([^>]*?)(?:\/>|>([\s\S]*?)<\/Container:Item>)/g;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(xml))) {
    const chunk = m[1] + (m[2] ?? '');
    out.items.push({
      mime: attrOrElement(chunk, 'Item:Mime'),
      semantic: attrOrElement(chunk, 'Item:Semantic'),
      length: num(attrOrElement(chunk, 'Item:Length')),
      padding: num(attrOrElement(chunk, 'Item:Padding')),
    });
  }
  return out;
}

export function isMotionPhotoXmp(x: MotionPhotoXmp): boolean {
  return x.motionPhoto === 1 || x.microVideo === 1 || x.items.some((i) => i.semantic === 'MotionPhoto');
}

export interface MotionPhotoXmpParams {
  /** Byte length of the embedded MP4. */
  videoLength: number;
  /** Bytes between the primary image's EOI and the first byte of the MP4 (e.g. Samsung SEF block headers). */
  paddingBeforeVideo: number;
  /** Bytes after the MP4 up to end of file (e.g. Samsung SEF directory). */
  bytesAfterVideo: number;
  presentationTimestampUs: number;
  primaryMime?: string;
  /** Length of the primary image in bytes (optional per spec; Samsung writes it). 0 = unknown. */
  primaryLength?: number;
}

const MOTION_ATTR_RE = /\s+GCamera:(?:MotionPhoto|MotionPhotoVersion|MotionPhotoPresentationTimestampUs|MicroVideo|MicroVideoVersion|MicroVideoOffset|MicroVideoPresentationTimestampUs)\s*=\s*(?:"[^"]*"|'[^']*')/g;
const MOTION_ELEM_RE = /<GCamera:(?:MotionPhoto|MotionPhotoVersion|MotionPhotoPresentationTimestampUs|MicroVideo|MicroVideoVersion|MicroVideoOffset|MicroVideoPresentationTimestampUs)\b[^>]*>[^<]*<\/GCamera:[A-Za-z]+>\s*/g;
const CONTAINER_DIR_RE = /<Container:Directory\b[\s\S]*?<\/Container:Directory>\s*/g;
const CONTAINER_DIR_ATTR_RE = /\s+Container:Directory\s*=\s*(?:"[^"]*"|'[^']*')/g;

/** Remove every motion-photo hint from an XMP packet (used when making a plain still / Live Photo). */
export function stripMotionPhotoXmp(xml: string): string {
  return xml
    .replace(MOTION_ATTR_RE, '')
    .replace(MOTION_ELEM_RE, '')
    .replace(CONTAINER_DIR_RE, '')
    .replace(CONTAINER_DIR_ATTR_RE, '');
}

/**
 * Lengths follow what Google's reader (media3 MotionPhotoDescription) and
 * Samsung's own files do: readers walk *backwards from the end of the file*,
 * so the MotionPhoto item's Length must cover the MP4 plus anything after it
 * (Samsung's SEF directory). The video item's Padding records that tail, and
 * the primary item's Padding is the gap between its EOI and the MP4.
 */
function motionDescription(p: MotionPhotoXmpParams): string {
  const ts = Math.max(0, Math.round(p.presentationTimestampUs));
  const videoItemLength = p.videoLength + p.bytesAfterVideo;
  const microOffset = videoItemLength;
  return (
    `<rdf:Description rdf:about=""` +
    ` xmlns:GCamera="${NS.GCamera}" xmlns:Container="${NS.Container}" xmlns:Item="${NS.Item}"` +
    ` GCamera:MotionPhoto="1" GCamera:MotionPhotoVersion="1" GCamera:MotionPhotoPresentationTimestampUs="${ts}"` +
    ` GCamera:MicroVideo="1" GCamera:MicroVideoVersion="1" GCamera:MicroVideoOffset="${microOffset}" GCamera:MicroVideoPresentationTimestampUs="${ts}">` +
    `<Container:Directory><rdf:Seq>` +
    `<rdf:li rdf:parseType="Resource"><Container:Item Item:Mime="${p.primaryMime ?? 'image/jpeg'}" Item:Semantic="Primary" Item:Length="${p.primaryLength ?? 0}" Item:Padding="${p.paddingBeforeVideo}"/></rdf:li>` +
    `<rdf:li rdf:parseType="Resource"><Container:Item Item:Mime="video/mp4" Item:Semantic="MotionPhoto" Item:Length="${videoItemLength}" Item:Padding="${p.bytesAfterVideo}"/></rdf:li>` +
    `</rdf:Seq></Container:Directory>` +
    `</rdf:Description>`
  );
}

/**
 * Produce an XMP packet that carries the motion photo hints. When `existing`
 * is given, its other content is kept and a fresh rdf:Description is added.
 */
export function buildMotionPhotoXmp(p: MotionPhotoXmpParams, existing?: string): string {
  const desc = motionDescription(p);
  if (existing && /<rdf:RDF\b/.test(existing)) {
    const cleaned = stripMotionPhotoXmp(existing);
    return cleaned.replace(/<\/rdf:RDF>/, `${desc}</rdf:RDF>`);
  }
  return (
    `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>` +
    `<x:xmpmeta xmlns:x="${NS.x}" x:xmptk="photoshare">` +
    `<rdf:RDF xmlns:rdf="${NS.rdf}">${desc}</rdf:RDF>` +
    `</x:xmpmeta>` +
    `<?xpacket end="w"?>`
  );
}

export const XMP_APP1_PREFIX = 'http://ns.adobe.com/xap/1.0/\0';

export function xmpFromApp1(payload: Uint8Array): string {
  return decodeUtf8(payload.subarray(XMP_APP1_PREFIX.length));
}

export function xmpToApp1(xml: string): Uint8Array {
  return utf8(XMP_APP1_PREFIX + xml);
}
