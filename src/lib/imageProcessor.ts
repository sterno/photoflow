/**
 * Image and video processing pipeline. Extracts EXIF metadata, generates
 * thumbnail/preview renditions, and pulls representative frames from video
 * uploads. Runs server-side only — invoked by the upload route after the
 * original lands in S3.
 */
import 'server-only';
import sharp from 'sharp';
import * as EXIF from 'exifr';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ffmpegPath from 'ffmpeg-static';

// Cap on the decoded pixel count sharp will accept for any single image.
// sharp's default (~268 MP) lets a small, crafted upload force ~1 GB+ of
// decode memory, so a few concurrent malicious uploads can OOM a small
// container. 100 MP comfortably covers real cameras (e.g. 100 MP medium
// format) while bounding the blast radius. Exported so the ZIP export path,
// which re-decodes stored originals, applies the same ceiling.
export const MAX_INPUT_PIXELS = 100_000_000;

export interface ImageMetadata {
  width?: number;
  height?: number;
  fStop?: number;
  shutterSpeed?: string;
  iso?: number;
  focalLength?: number;
  cameraModel?: string;
  lens?: string;
  photographerName?: string;
  captureTime?: Date;
  latitude?: number;
  longitude?: number;
}

// Some Lightroom / camera-firmware combinations end up writing the photographer
// into BOTH EXIF Artist and XMP dc:creator with different capitalization.
// Toolchains downstream flatten the duplicates with "; " (XMP creator is a
// sequence), so we receive values like "bryan giardinelli; Bryan Giardinelli".
// We also see commas occasionally. Split on either separator, drop case-
// insensitive duplicates, and prefer the entry with mixed case so we keep the
// properly-typed version.
function normalizePhotographerName(raw: unknown): string | undefined {
  if (typeof raw !== 'string') {
    if (Array.isArray(raw)) return normalizePhotographerName(raw.join('; '));
    return undefined;
  }
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const parts = trimmed
    .split(/\s*[;,]\s*/)
    .map((segment) => segment.trim())
    .filter(Boolean);
  if (parts.length === 0) return undefined;
  if (parts.length === 1) return parts[0];
  // Dedupe case-insensitively, preserving the first occurrence of each.
  const seenLower = new Set<string>();
  const unique: string[] = [];
  for (const part of parts) {
    const key = part.toLowerCase();
    if (seenLower.has(key)) continue;
    seenLower.add(key);
    unique.push(part);
  }
  if (unique.length === 1) return unique[0];
  // Multiple genuinely-different names: prefer one with mixed case (likely the
  // "proper" name) over an all-lowercase or all-uppercase variant.
  const properCase = unique.find((candidate) => /[A-Z]/.test(candidate) && /[a-z]/.test(candidate));
  return properCase || unique[0];
}

// EXIF DateTimeOriginal carries the camera's wall-clock time with no timezone
// (e.g. "2026:06:03 14:30:00"). We store it as the same wall-clock instant in
// UTC so the digits round-trip exactly when displayed with timeZone:'UTC'.
// Without this guard the result depends on the server's local timezone:
// exifr's default parse uses local-time semantics, which means the same JPEG
// processed on a UTC server and a developer's EDT laptop would land in the
// database 4 hours apart.
function parseExifCaptureTime(value: unknown): Date | undefined {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return undefined;
    // Read the local-time components exifr produced (the literal EXIF digits)
    // and rebuild as the same digits in UTC, regardless of server timezone.
    return new Date(Date.UTC(
      value.getFullYear(),
      value.getMonth(),
      value.getDate(),
      value.getHours(),
      value.getMinutes(),
      value.getSeconds(),
    ));
  }
  if (typeof value === 'string') {
    // EXIF uses "YYYY:MM:DD HH:MM:SS"; ISO-ish formats (with "-" / "T") also
    // appear after some Lightroom exports.
    const match = value.match(/^(\d{4})[-:](\d{2})[-:](\d{2})[T\s](\d{2}):(\d{2}):(\d{2})/);
    if (!match) return undefined;
    return new Date(Date.UTC(
      Number(match[1]), Number(match[2]) - 1, Number(match[3]),
      Number(match[4]), Number(match[5]), Number(match[6]),
    ));
  }
  return undefined;
}

export async function extractMetadata(buffer: Buffer): Promise<ImageMetadata> {
  try {
    const metadata = await sharp(buffer, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();
    const exifData = await EXIF.parse(buffer);

    return {
      width: metadata.width,
      height: metadata.height,
      fStop: exifData?.FNumber,
      shutterSpeed: exifData?.ExposureTime ? `1/${Math.round(1/exifData.ExposureTime)}s` : undefined,
      iso: exifData?.ISO,
      // Prefer the 35mm-equivalent so wide/tele thresholds match how photographers
      // (and our shot-type filters) read focal length. Fall back to the lens's
      // literal focal length when the camera doesn't report the equivalent.
      focalLength: exifData?.FocalLengthIn35mmFormat ?? exifData?.FocalLength,
      cameraModel: exifData?.Model,
      lens: exifData?.LensModel,
      photographerName: normalizePhotographerName(exifData?.Artist || exifData?.Creator),
      captureTime: parseExifCaptureTime(exifData?.DateTimeOriginal),
      latitude: exifData?.latitude,
      longitude: exifData?.longitude,
    };
  } catch (error) {
    console.error('Error extracting metadata:', error);
    return {};
  }
}

export async function generateThumbnail(buffer: Buffer, size: number = 150): Promise<Buffer> {
  return sharp(buffer, { limitInputPixels: MAX_INPUT_PIXELS })
    .rotate() // honor EXIF orientation
    .resize(size, size, {
      fit: 'cover',
      position: 'center',
    })
    .jpeg({ quality: 90, mozjpeg: true, chromaSubsampling: '4:4:4' })
    .toBuffer();
}

export async function generatePreview(buffer: Buffer, size: number = 800): Promise<Buffer> {
  return sharp(buffer, { limitInputPixels: MAX_INPUT_PIXELS })
    .rotate() // honor EXIF orientation
    .resize(size, size, {
      fit: 'inside',
      withoutEnlargement: true,
    })
    .jpeg({ quality: 92, mozjpeg: true, chromaSubsampling: '4:4:4' })
    .toBuffer();
}

export interface VideoMetadata {
  duration: number | null; // seconds
  width: number | null;
  height: number | null;
}

export interface VideoFrameResult {
  frame: Buffer; // raw JPEG frame extracted by ffmpeg
  metadata: VideoMetadata;
}

// Parse the relevant bits out of ffmpeg's stderr (it always writes there even
// on success). Looking for:
//   "  Duration: 00:00:12.34, start: ..."
//   "  Stream #0:0(...): Video: ... 1920x1080 [SAR ...] ..."
function parseFfmpegStderr(stderr: string): VideoMetadata {
  let duration: number | null = null;
  let width: number | null = null;
  let height: number | null = null;

  const durationMatch = stderr.match(/Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/);
  if (durationMatch) {
    const hours = Number(durationMatch[1]);
    const minutes = Number(durationMatch[2]);
    const seconds = Number(durationMatch[3]);
    if (Number.isFinite(hours + minutes + seconds)) duration = hours * 3600 + minutes * 60 + seconds;
  }

  // The video stream line varies a lot across containers — just look for the
  // first NxN that appears after a "Video:" tag.
  const videoMatch = stderr.match(/Video:[^\n]*?\b(\d{2,5})x(\d{2,5})\b/);
  if (videoMatch) {
    width = Number(videoMatch[1]);
    height = Number(videoMatch[2]);
  }

  return { duration, width, height };
}

// Single ffmpeg run that both extracts a frame and reports duration/size.
// Why a temp file: ffmpeg's seek (-ss) against a stdin pipe is unreliable for
// container formats whose moov atom lives at the EOF (most .mov files), so we
// write the input to disk first. Cleanup is best-effort in the finally block.
async function runFfmpegFrameExtract(buffer: Buffer): Promise<VideoFrameResult> {
  if (!ffmpegPath) {
    throw new Error('ffmpeg-static binary not available on this platform');
  }
  const dir = await mkdtemp(join(tmpdir(), 'photoflow-video-'));
  const inputPath = join(dir, 'input');
  const outputPath = join(dir, 'frame.jpg');
  try {
    await writeFile(inputPath, buffer);
    const stderr = await new Promise<string>((resolve, reject) => {
      const ffmpegProc = spawn(ffmpegPath as string, [
        '-y',
        // Seek a second in so we skip the (often black) first frame, but fall
        // back gracefully on shorter clips — ffmpeg clamps to the available
        // duration rather than failing.
        '-ss', '1',
        '-i', inputPath,
        '-vframes', '1',
        '-q:v', '3', // 1 (best) – 31 (worst); 3 = visually good, small enough
        outputPath,
      ]);
      let stderrBuf = '';
      ffmpegProc.stderr.on('data', (chunk) => {
        stderrBuf += chunk.toString();
      });
      ffmpegProc.on('error', reject);
      ffmpegProc.on('close', (exitCode) => {
        if (exitCode === 0) resolve(stderrBuf);
        else reject(new Error(`ffmpeg exited ${exitCode}: ${stderrBuf.slice(-500)}`));
      });
    });
    const frame = await readFile(outputPath);
    return { frame, metadata: parseFfmpegStderr(stderr) };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// Cached frame extraction so the upload pipeline can ask for thumbnail and
// preview without re-running ffmpeg. Keyed by buffer reference (not bytes),
// since the route reuses the same Buffer for both calls.
const frameCache = new WeakMap<Buffer, Promise<VideoFrameResult>>();
function getVideoFrame(buffer: Buffer): Promise<VideoFrameResult> {
  let pending = frameCache.get(buffer);
  if (!pending) {
    pending = runFfmpegFrameExtract(buffer);
    frameCache.set(buffer, pending);
  }
  return pending;
}

export async function extractVideoMetadata(buffer: Buffer): Promise<VideoMetadata> {
  const { metadata } = await getVideoFrame(buffer);
  return metadata;
}

export async function generateVideoThumbnail(buffer: Buffer, size: number = 150): Promise<Buffer> {
  const { frame } = await getVideoFrame(buffer);
  // Cover-fit at thumbnail size; pipe through Sharp so the output matches the
  // photo thumbnail format and dimensions exactly.
  return sharp(frame)
    .resize(size, size, { fit: 'cover', position: 'center' })
    .jpeg({ quality: 90, mozjpeg: true })
    .toBuffer();
}

export async function generateVideoPreview(buffer: Buffer, size: number = 800): Promise<Buffer> {
  const { frame } = await getVideoFrame(buffer);
  return sharp(frame)
    .resize(size, size, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 92, mozjpeg: true })
    .toBuffer();
}