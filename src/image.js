import https from 'node:https';
import http from 'node:http';
import { lookup as dnsLookup } from 'node:dns';
import { log } from './config.js';
import { tryExtractPdf } from './pdf.js';
import { ocrImageBuffer, ocrPdfBuffer } from './ocr.js';
import { isPrivateIp, resolvePublicAddresses } from './net-safety.js';

const MAX_IMAGE_SIZE = 5 * 1024 * 1024; // 5 MB
const MAX_BINARY_SIZE = parseInt(process.env.WINDSURFAPI_REMOTE_BINARY_MAX_BYTES || String(20 * 1024 * 1024), 10);
const MAX_IMAGE_BASE64_LEN = Math.ceil(MAX_IMAGE_SIZE * 4 / 3) + 100;
const MAX_BINARY_BASE64_LEN = Math.ceil(MAX_BINARY_SIZE * 4 / 3) + 100;
const MAX_REDIRECTS = 3;
const MIME_OK = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const PDF_MIME_OK = new Set(['application/pdf']);
// http/https `lookup` hook: runs in place of the default DNS resolution.
// Rejecting here means the request never opens a socket to the internal
// address, closing the DNS-rebinding gap in the string-based host check.
function safeLookup(hostname, options, callback) {
  dnsLookup(hostname, options, (err, address, family) => {
    if (err) return callback(err);
    const addrs = Array.isArray(address) ? address : [{ address, family }];
    for (const a of addrs) {
      if (isPrivateIp(a.address)) {
        return callback(new Error(`Image URL resolves to private address: ${a.address}`));
      }
    }
    callback(null, address, family);
  });
}

function validateImageUrl(url) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error('Invalid image URL'); }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')
    throw new Error('Image URL must be http or https');
  if (String(parsed.hostname).toLowerCase() === 'localhost' || isPrivateIp(parsed.hostname))
    throw new Error('Image URL targets a private/internal address');
  return parsed;
}

function appendPdfText(text, pdf, label = '') {
  if (pdf?.text) {
    return `${text}\n[PDF Document${label} — ${pdf.pageCount} page(s)]\n${pdf.text}\n`;
  }
  return `${text}\n[PDF Document${label} — no extractable text (scanned/image-only PDF)]\n`;
}

function appendOcrText(text, ocrText, label = 'Image OCR') {
  const clean = String(ocrText || '').trim();
  if (!clean) return text;
  return `${text}\n[${label}]\n${clean}\n`;
}

function appendDocumentMeta(text, block) {
  const title = String(block?.title || '').trim();
  const context = String(block?.context || '').trim();
  if (!title && !context) return text;
  let out = text;
  if (title) out += `\n[Document Title]\n${title}\n`;
  if (context) out += `\n[Document Context]\n${context}\n`;
  return out;
}

function summarizeUrl(url = '') {
  if (String(url).startsWith('data:')) {
    const mime = String(url).slice(5).split(';', 1)[0] || 'unknown';
    return `data:${mime}`;
  }
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return '';
  }
}

function logBlock(block, detail = '') {
  const type = String(block?.type || '').toLowerCase() || 'unknown';
  const src = block?.source || block?.file || block?.image_url || {};
  const mime = src.media_type || src.mime_type || '';
  const url = src.url || block?.image_url?.url || '';
  const hasData = !!(src.data || src.file_data || (typeof url === 'string' && url.startsWith('data:')));
  log.info(`MM block: type=${type} mime=${mime || 'n/a'} url=${summarizeUrl(url) || 'n/a'} data=${hasData ? 'yes' : 'no'}${detail ? ` ${detail}` : ''}`);
}

export function parseDataUrl(url) {
  const clean = url.replace(/\s/g, '');
  const m = clean.match(/^data:(image\/[a-z+]+);base64,(.+)$/i);
  if (!m) return null;
  if (m[2].length > MAX_IMAGE_BASE64_LEN) throw new Error(`Image data URL exceeds ${MAX_IMAGE_SIZE} byte limit`);
  return { base64_data: m[2], mime_type: m[1].toLowerCase() };
}

// Extract base64 body from a data URL of any mime type. Used for PDF
// payloads which don't match parseDataUrl's image-only regex.
export function parseGenericDataUrl(url) {
  const clean = url.replace(/\s/g, '');
  const m = clean.match(/^data:([a-z0-9][a-z0-9.+/-]+);base64,(.+)$/i);
  if (!m) return null;
  if (m[2].length > MAX_BINARY_BASE64_LEN) throw new Error(`Data URL exceeds ${MAX_BINARY_SIZE} byte limit`);
  return { base64_data: m[2], mime_type: m[1].toLowerCase() };
}

export async function assertPublicUrlHost(urlOrHost, lookupFn = dnsLookup) {
  let host = urlOrHost;
  try { host = new URL(urlOrHost).hostname; } catch {}
  return resolvePublicAddresses(host, lookupFn);
}

export function fetchImageUrl(url, timeoutMs = 8000, _depth = 0) {
  if (_depth > MAX_REDIRECTS) return Promise.reject(new Error('Too many image redirects'));
  validateImageUrl(url);

  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, val) => { if (!settled) { settled = true; fn(val); } };

    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { timeout: timeoutMs, headers: { 'Accept': 'image/*' }, lookup: safeLookup }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return fetchImageUrl(res.headers.location, timeoutMs, _depth + 1).then(
          v => done(resolve, v), e => done(reject, e)
        );
      }
      if (res.statusCode !== 200) {
        res.resume();
        return done(reject, new Error(`Image fetch HTTP ${res.statusCode}`));
      }
      const mime = (res.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (!MIME_OK.has(mime)) {
        res.resume();
        return done(reject, new Error(`Unsupported image type: ${mime}`));
      }
      const chunks = [];
      let size = 0;
      res.on('data', (d) => {
        if (settled) return;
        size += d.length;
        if (size > MAX_IMAGE_SIZE) { res.destroy(); done(reject, new Error(`Image exceeds ${MAX_IMAGE_SIZE} bytes`)); }
        else chunks.push(d);
      });
      res.on('end', () => done(resolve, { base64_data: Buffer.concat(chunks).toString('base64'), mime_type: mime }));
      res.on('error', (e) => done(reject, e));
    });
    req.on('error', (e) => done(reject, e));
    req.on('timeout', () => { req.destroy(); done(reject, new Error('Image fetch timeout')); });
  });
}

function isPdfLikeResponse(url, mime) {
  if (PDF_MIME_OK.has(mime)) return true;
  if (mime === 'application/octet-stream') {
    try {
      const parsed = new URL(url);
      return parsed.pathname.toLowerCase().endsWith('.pdf');
    } catch {}
  }
  return false;
}

function fetchBinaryUrl(url, { timeoutMs = 8000, accept = '*/*', _depth = 0 } = {}) {
  if (_depth > MAX_REDIRECTS) return Promise.reject(new Error('Too many redirects'));
  validateImageUrl(url);

  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, val) => { if (!settled) { settled = true; fn(val); } };

    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { timeout: timeoutMs, headers: { 'Accept': accept }, lookup: safeLookup }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return fetchBinaryUrl(res.headers.location, { timeoutMs, accept, _depth: _depth + 1 }).then(
          (v) => done(resolve, v), (e) => done(reject, e)
        );
      }
      if (res.statusCode !== 200) {
        res.resume();
        return done(reject, new Error(`Binary fetch HTTP ${res.statusCode}`));
      }
      const mime = (res.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      const chunks = [];
      let size = 0;
      res.on('data', (d) => {
        if (settled) return;
        size += d.length;
        if (size > MAX_BINARY_SIZE) { res.destroy(); done(reject, new Error(`Binary payload exceeds ${MAX_BINARY_SIZE} bytes`)); }
        else chunks.push(d);
      });
      res.on('end', () => done(resolve, { mime_type: mime, data: Buffer.concat(chunks) }));
      res.on('error', (e) => done(reject, e));
    });
    req.on('error', (e) => done(reject, e));
    req.on('timeout', () => { req.destroy(); done(reject, new Error('Binary fetch timeout')); });
  });
}

async function fetchPdfUrl(url, timeoutMs = 8000) {
  const { mime_type, data } = await fetchBinaryUrl(url, { timeoutMs, accept: 'application/pdf,application/octet-stream' });
  if (!isPdfLikeResponse(url, mime_type)) {
    throw new Error(`Unsupported PDF type: ${mime_type || '(missing content-type)'}`);
  }
  return { pdf: tryExtractPdf(data.toString('base64')), data };
}

async function fetchPdfOrImageUrl(url, timeoutMs = 8000) {
  const { mime_type, data } = await fetchBinaryUrl(url, { timeoutMs, accept: 'application/pdf,image/*,application/octet-stream' });
  if (isPdfLikeResponse(url, mime_type)) {
    return { kind: 'pdf', pdf: tryExtractPdf(data.toString('base64')), data };
  }
  if (MIME_OK.has(mime_type)) {
    return { kind: 'image', image: { base64_data: data.toString('base64'), mime_type }, data };
  }
  throw new Error(`Unsupported remote asset type: ${mime_type || '(missing content-type)'}`);
}

export async function extractImages(contentBlocks) {
  if (!Array.isArray(contentBlocks)) return { text: String(contentBlocks ?? ''), images: [] };

  let text = '';
  const images = [];

  for (const block of contentBlocks) {
    if (!block || typeof block === 'string') { text += block || ''; continue; }

    if (block.type === 'text') {
      text += block.text || '';
    } else if (block.type === 'document') {
      logBlock(block);
      text = appendDocumentMeta(text, block);
      const src = block.source || {};
      const mime = (src.media_type || '').toLowerCase();
      if (mime === 'application/pdf' && src.data) {
        const pdf = tryExtractPdf(src.data);
        text = appendPdfText(text, pdf);
        if (pdf?.text) log.info(`PDF extracted: ${pdf.pageCount} pages, ${pdf.text.length} chars`);
        else {
          const ocrText = await ocrPdfBuffer(Buffer.from(src.data, 'base64'), 'document');
          text = appendOcrText(text, ocrText, 'PDF OCR');
        }
      } else if (src.type === 'url' && src.url) {
        try {
          const { pdf, data } = await fetchPdfUrl(src.url);
          text = appendPdfText(text, pdf);
          if (pdf?.text) log.info(`PDF extracted (document URL): ${pdf.pageCount} pages, ${pdf.text.length} chars`);
          else {
            const ocrText = await ocrPdfBuffer(data, 'document-url');
            text = appendOcrText(text, ocrText, 'PDF OCR');
          }
        } catch (e) {
          log.warn(`Document fetch failed: ${e.message}`);
        }
      }
    } else if (block.type === 'image') {
      logBlock(block);
      const src = block.source || {};
      const mime = (src.media_type || '').toLowerCase();
      if (mime === 'application/pdf' && src.data) {
        const pdf = tryExtractPdf(src.data);
        text = appendPdfText(text, pdf);
        if (!pdf?.text) {
          const ocrText = await ocrPdfBuffer(Buffer.from(src.data, 'base64'), 'image-pdf');
          text = appendOcrText(text, ocrText, 'PDF OCR');
        }
        continue;
      }
      try {
        if ((src.type === 'base64' || !src.type) && src.data) {
          if (src.data.length > MAX_IMAGE_BASE64_LEN) { log.warn('Image base64 exceeds size limit, skipping'); continue; }
          images.push({ base64_data: src.data, mime_type: src.media_type || 'image/png' });
          const ocrText = await ocrImageBuffer(Buffer.from(src.data, 'base64'), src.media_type || 'image/png', 'image');
          text = appendOcrText(text, ocrText);
        } else if (src.type === 'url' && src.url) {
          const asset = await fetchPdfOrImageUrl(src.url);
          if (asset.kind === 'pdf') {
            text = appendPdfText(text, asset.pdf);
            if (!asset.pdf?.text) {
              const ocrText = await ocrPdfBuffer(asset.data, 'image-url-pdf');
              text = appendOcrText(text, ocrText, 'PDF OCR');
            }
          } else {
            images.push(asset.image);
            const ocrText = await ocrImageBuffer(asset.data, asset.image.mime_type, 'image-url');
            text = appendOcrText(text, ocrText);
          }
        }
      } catch (e) { log.warn(`Image extraction failed: ${e.message}`); }
    } else if (block.type === 'image_url') {
      logBlock(block);
      const url = block.image_url?.url || '';
      try {
        if (url.startsWith('data:')) {
          // PDF-as-data-URL: let the model "see" it via text extraction
          // rather than treating it as an unsupported image type.
          const lower = url.slice(0, 40).toLowerCase();
          if (lower.startsWith('data:application/pdf')) {
            const g = parseGenericDataUrl(url);
            if (g?.base64_data) {
              const pdf = tryExtractPdf(g.base64_data);
              text = appendPdfText(text, pdf);
              if (pdf?.text) log.info(`PDF extracted (image_url data URL): ${pdf.pageCount} pages, ${pdf.text.length} chars`);
              else {
                const ocrText = await ocrPdfBuffer(Buffer.from(g.base64_data, 'base64'), 'image-url-data-pdf');
                text = appendOcrText(text, ocrText, 'PDF OCR');
              }
            }
            continue;
          }
          const parsed = parseDataUrl(url);
          if (parsed) {
            images.push(parsed);
            const ocrText = await ocrImageBuffer(Buffer.from(parsed.base64_data, 'base64'), parsed.mime_type, 'image-url-data');
            text = appendOcrText(text, ocrText);
          }
        } else if (url.startsWith('https://') || url.startsWith('http://')) {
          const asset = await fetchPdfOrImageUrl(url);
          if (asset.kind === 'pdf') {
            text = appendPdfText(text, asset.pdf);
            if (!asset.pdf?.text) {
              const ocrText = await ocrPdfBuffer(asset.data, 'image-url-remote-pdf');
              text = appendOcrText(text, ocrText, 'PDF OCR');
            }
          } else {
            images.push(asset.image);
            const ocrText = await ocrImageBuffer(asset.data, asset.image.mime_type, 'image-url-remote');
            text = appendOcrText(text, ocrText);
          }
        }
      } catch (e) { log.warn(`Image fetch failed: ${e.message}`); }
    } else if (block.type === 'file' || block.type === 'input_file') {
      logBlock(block);
      // OpenAI PDF input: { type:'file', file:{ filename, file_data:'data:application/pdf;base64,...' } }
      // or file_id (uploaded via Files API — we can't fetch, so ignore).
      const file = block.file || {};
      const dataUrl = file.file_data || file.url || '';
      if (dataUrl.startsWith('data:application/pdf')) {
        const g = parseGenericDataUrl(dataUrl);
        if (g?.base64_data) {
          const pdf = tryExtractPdf(g.base64_data);
          const label = file.filename ? ` "${file.filename}"` : '';
          text = appendPdfText(text, pdf, label);
          if (pdf?.text) log.info(`PDF extracted (OpenAI file block): ${pdf.pageCount} pages, ${pdf.text.length} chars`);
          else {
            const ocrText = await ocrPdfBuffer(Buffer.from(g.base64_data, 'base64'), file.filename || 'file-block');
            text = appendOcrText(text, ocrText, 'PDF OCR');
          }
        }
      } else if ((dataUrl.startsWith('https://') || dataUrl.startsWith('http://')) && !file.file_id) {
        try {
          const { pdf, data } = await fetchPdfUrl(dataUrl);
          const label = file.filename ? ` "${file.filename}"` : '';
          text = appendPdfText(text, pdf, label);
          if (pdf?.text) log.info(`PDF extracted (OpenAI file URL): ${pdf.pageCount} pages, ${pdf.text.length} chars`);
          else {
            const ocrText = await ocrPdfBuffer(data, file.filename || 'file-url');
            text = appendOcrText(text, ocrText, 'PDF OCR');
          }
        } catch (e) {
          log.warn(`File URL fetch failed: ${e.message}`);
        }
      } else if (dataUrl && !file.file_id) {
        log.warn(`Unsupported file block data URL: ${dataUrl.slice(0, 40)}...`);
      } else if (file.file_id) {
        log.warn(`File block references file_id=${file.file_id} — upload API not supported, skipping`);
      }
    }
  }

  return { text, images };
}
