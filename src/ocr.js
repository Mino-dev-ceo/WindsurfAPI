import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OCR_SCRIPT = resolve(__dirname, 'ocr-macos.swift');
const OCR_ENABLED = process.platform === 'darwin' && process.env.WINDSURFAPI_IMAGE_OCR !== '0';
const OCR_TIMEOUT_MS = parseInt(process.env.WINDSURFAPI_IMAGE_OCR_TIMEOUT_MS || '12000', 10);
const OCR_MAX_BYTES = parseInt(process.env.WINDSURFAPI_IMAGE_OCR_MAX_BYTES || String(5 * 1024 * 1024), 10);
const PDF_OCR_MAX_PAGES = parseInt(process.env.WINDSURFAPI_PDF_OCR_MAX_PAGES || '3', 10);

function execFileAsync(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function extForMime(mimeType = '') {
  const mime = String(mimeType || '').toLowerCase();
  if (mime === 'image/png') return 'png';
  if (mime === 'image/jpeg') return 'jpg';
  if (mime === 'image/webp') return 'webp';
  if (mime === 'image/gif') return 'gif';
  if (mime === 'application/pdf') return 'pdf';
  return 'bin';
}

async function runMacOcr(buf, mimeType, { kind = 'image', label = '' } = {}) {
  if (!OCR_ENABLED || !existsSync(OCR_SCRIPT)) return '';
  if (!Buffer.isBuffer(buf) || !buf.length) return '';
  if (buf.length > OCR_MAX_BYTES) {
    log.warn(`OCR skipped${label ? ` (${label})` : ''}: payload exceeds ${OCR_MAX_BYTES} bytes`);
    return '';
  }

  const tmpRoot = mkdtempSync(join(tmpdir(), 'windsurfapi-ocr-'));
  const inputPath = join(tmpRoot, `input.${extForMime(mimeType)}`);

  try {
    writeFileSync(inputPath, buf);
    const { stdout, stderr } = await execFileAsync(
      'swift',
      [OCR_SCRIPT, inputPath, kind, String(PDF_OCR_MAX_PAGES)],
      { timeout: OCR_TIMEOUT_MS, maxBuffer: 2 * 1024 * 1024 }
    );
    if (stderr?.trim()) log.debug(`OCR stderr${label ? ` (${label})` : ''}: ${stderr.trim()}`);
    const parsed = JSON.parse(String(stdout || '{}'));
    const text = String(parsed?.text || '').trim();
    if (text) {
      log.info(`OCR extracted${label ? ` (${label})` : ''}: ${text.length} chars`);
    }
    return text;
  } catch (e) {
    log.warn(`OCR failed${label ? ` (${label})` : ''}: ${e.message}`);
    return '';
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}

export async function ocrImageBuffer(buf, mimeType, label = '') {
  return runMacOcr(buf, mimeType, { kind: 'image', label });
}

export async function ocrPdfBuffer(buf, label = '') {
  return runMacOcr(buf, 'application/pdf', { kind: 'pdf', label });
}

