import { constants } from 'node:fs';
import { open, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_ASSET_BYTES = 20 * 1024 * 1024;
const MAX_DIMENSION = 8192;
const IMAGE_EXTENSIONS = new Set([
  '.bmp', '.gif', '.jpeg', '.jpg', '.ktx', '.png', '.psd', '.svg', '.tif', '.tiff', '.webp',
]);
const SKIPPED_DIRECTORIES = new Set([
  '.expo', '.git', 'Pods', 'build', 'dist', 'node_modules',
]);

const mobileRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function startsWith(buffer, signature) {
  return buffer.length >= signature.length && buffer.subarray(0, signature.length).equals(signature);
}

function rejectKnownParserConfusion(buffer, relativePath) {
  const icns = Buffer.from('icns', 'ascii');
  const jxlCodestream = Buffer.from([0xff, 0x0a]);
  const jxlContainer = Buffer.from([0x00, 0x00, 0x00, 0x0c, 0x4a, 0x58, 0x4c, 0x20, 0x0d, 0x0a, 0x87, 0x0a]);
  const isoBaseMedia = buffer.length >= 12 && buffer.subarray(4, 8).toString('ascii') === 'ftyp';
  if (startsWith(buffer, icns) || startsWith(buffer, jxlCodestream) || startsWith(buffer, jxlContainer) || isoBaseMedia) {
    throw new Error(`${relativePath}: disguised ICNS, JPEG XL, HEIF, or AVIF content is forbidden`);
  }
}

function verifyPng(buffer, relativePath) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!startsWith(buffer, signature) || buffer.length < 33 || buffer.subarray(12, 16).toString('ascii') !== 'IHDR') {
    throw new Error(`${relativePath}: invalid PNG signature or IHDR`);
  }
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (width === 0 || height === 0 || width > MAX_DIMENSION || height > MAX_DIMENSION) {
    throw new Error(`${relativePath}: PNG dimensions are outside the release bound`);
  }
}

function verifySvg(buffer, relativePath) {
  const source = buffer.toString('utf8').replace(/^\uFEFF/, '').trimStart();
  if (!source.startsWith('<svg') && !(source.startsWith('<?xml') && source.slice(0, 2048).includes('<svg'))) {
    throw new Error(`${relativePath}: invalid SVG root`);
  }
  if (/<!doctype|<!entity|<script\b|\bon\w+\s*=|\b(?:href|xlink:href)\s*=\s*["'](?:https?:|data:)/iu.test(source)) {
    throw new Error(`${relativePath}: active or external SVG content is forbidden`);
  }
}

function verifySignature(extension, buffer, relativePath) {
  const ascii = (start, end) => buffer.subarray(start, end).toString('ascii');
  switch (extension) {
    case '.png':
      verifyPng(buffer, relativePath);
      return;
    case '.jpg':
    case '.jpeg':
      if (!(buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff)) throw new Error(`${relativePath}: invalid JPEG signature`);
      return;
    case '.gif':
      if (!['GIF87a', 'GIF89a'].includes(ascii(0, 6))) throw new Error(`${relativePath}: invalid GIF signature`);
      return;
    case '.webp':
      if (!(ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP')) throw new Error(`${relativePath}: invalid WebP signature`);
      return;
    case '.bmp':
      if (ascii(0, 2) !== 'BM') throw new Error(`${relativePath}: invalid BMP signature`);
      return;
    case '.psd':
      if (ascii(0, 4) !== '8BPS') throw new Error(`${relativePath}: invalid PSD signature`);
      return;
    case '.svg':
      verifySvg(buffer, relativePath);
      return;
    case '.tif':
    case '.tiff': {
      const littleEndian = startsWith(buffer, Buffer.from([0x49, 0x49, 0x2a, 0x00]));
      const bigEndian = startsWith(buffer, Buffer.from([0x4d, 0x4d, 0x00, 0x2a]));
      if (!littleEndian && !bigEndian) throw new Error(`${relativePath}: invalid TIFF signature`);
      return;
    }
    case '.ktx': {
      const ktx1 = Buffer.from([0xab, 0x4b, 0x54, 0x58, 0x20, 0x31, 0x31, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a]);
      const ktx2 = Buffer.from([0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a]);
      if (!startsWith(buffer, ktx1) && !startsWith(buffer, ktx2)) throw new Error(`${relativePath}: invalid KTX signature`);
      return;
    }
    default:
      throw new Error(`${relativePath}: unsupported release image extension`);
  }
}

async function collectImages(directory, images) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
    const absolutePath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`${path.relative(mobileRoot, absolutePath)}: symlinks are forbidden in release asset roots`);
    if (entry.isDirectory()) {
      await collectImages(absolutePath, images);
      continue;
    }
    const extension = path.extname(entry.name).toLowerCase();
    if (IMAGE_EXTENSIONS.has(extension)) images.push(absolutePath);
  }
}

export async function verifyReleaseAssets() {
  const roots = ['assets', 'app', 'src', 'ios'].map((name) => path.join(mobileRoot, name));
  const images = [];
  for (const directory of roots) await collectImages(directory, images);
  if (images.length === 0) throw new Error('no project-owned release images were found');

  for (const absolutePath of images.sort()) {
    const relativePath = path.relative(mobileRoot, absolutePath);
    let handle;
    try {
      handle = await open(absolutePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size === 0 || stat.size > MAX_ASSET_BYTES) {
        throw new Error(`${relativePath}: release image size is invalid`);
      }
      const buffer = await handle.readFile();
      rejectKnownParserConfusion(buffer, relativePath);
      verifySignature(path.extname(absolutePath).toLowerCase(), buffer, relativePath);
    } catch (error) {
      if (error?.code === 'ELOOP') throw new Error(`${relativePath}: symlinks are forbidden in release asset roots`);
      throw error;
    } finally {
      await handle?.close();
    }
  }
  return images.length;
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  verifyReleaseAssets()
    .then((count) => {
      if (process.argv.length > 2) throw new Error('release asset gate does not accept filesystem paths');
      return count;
    })
    .then((count) => process.stdout.write(`release asset gate passed (${count} project-owned images)\n`))
    .catch((error) => {
      process.stderr.write(`release asset gate failed: ${error instanceof Error ? error.message : 'unknown error'}\n`);
      process.exitCode = 1;
    });
}
