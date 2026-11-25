import { createHash } from 'node:crypto';
import type ExcelJS from 'exceljs';
import { unzipSync } from 'fflate';

import {
  detectWorkDocumentFormat,
  type HostDocumentPreview,
  type WorkPresentationSlide,
  type WorkSlideBlock,
  type WorkSpreadsheetSheet,
} from '../../contract/work-projects';
import type { Settings } from '../config';
import { AppError } from '../errors';
import { convertLegacy } from './documents/converter';
import { extensionOf } from './file-types';
import { excelWorkbookToXSpreadsheet } from './work-excel-spreadsheet';

const LEGACY_FORMATS = new Set(['doc', 'xls', 'ppt']);
const MAX_SHEETS = 30;
const MAX_SHEET_ROWS = 500;
const MAX_SHEET_COLS = 50;
const MAX_SLIDE_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_DECK_IMAGE_BYTES = 12 * 1024 * 1024;

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
};

const SAFE_WORD_TAGS = new Set([
  'p', 'br', 'hr',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'strong', 'b', 'em', 'i', 'u', 's', 'del', 'sub', 'sup', 'code', 'pre', 'blockquote',
  'ul', 'ol', 'li',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'colgroup', 'col', 'caption',
  'a', 'img', 'span', 'div', 'figure', 'figcaption',
]);

function decodeXml(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/giu, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/gu, (_, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'")
    .replace(/&amp;/gu, '&');
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/"/gu, '&quot;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;');
}

function decodeUtf8(data: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    return new TextDecoder('utf-8', { fatal: false }).decode(data);
  }
}

/**
 * Strip dangerous tags, scripts, inline styles, and event handlers from mammoth HTML output
 * while preserving semantic document structure, tables, safe links, and embedded images.
 */
export function sanitizeWordHtml(rawHtml: string): string {
  const withoutBlocked = rawHtml
    .replace(/<!--[\s\S]*?-->/gu, '')
    .replace(/<(script|style|iframe|object|embed|form|input|button|textarea|select|svg|math)\b[\s\S]*?<\/\1>/giu, '')
    .replace(/<(script|style|iframe|object|embed|form|input|button|textarea|select|meta|link|base)\b[^>]*\/?>/giu, '');

  return withoutBlocked.replace(/<(\/?)([a-z][a-z0-9]*)(\s[^<>]*)?>/giu, (match, closing: string, rawTag: string, rawAttrs = '') => {
    const tag = rawTag.toLowerCase();
    if (!SAFE_WORD_TAGS.has(tag)) return '';
    if (closing) return `</${tag}>`;

    const keptAttrs: string[] = [];
    const attrRe = /([a-z][a-z0-9:-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/giu;
    let attrMatch: RegExpExecArray | null;
    while ((attrMatch = attrRe.exec(rawAttrs)) !== null) {
      const name = attrMatch[1].toLowerCase();
      const val = decodeXml(attrMatch[2] ?? attrMatch[3] ?? attrMatch[4] ?? '').trim();
      if (name.startsWith('on')) continue;
      if (tag === 'a' && name === 'href') {
        if (/^(?:https?:|mailto:|#)/iu.test(val)) {
          keptAttrs.push(`href="${escapeAttr(val)}"`);
          if (/^https?:/iu.test(val)) {
            keptAttrs.push('target="_blank"', 'rel="noreferrer noopener"');
          }
        }
      } else if (tag === 'img' && name === 'src') {
        if (/^data:image\/(?:png|jpeg|jpg|gif|webp|bmp);base64,[a-z0-9+/=\s]+$/iu.test(val)) {
          keptAttrs.push(`src="${escapeAttr(val)}"`);
        }
      } else if (tag === 'img' && name === 'alt') {
        keptAttrs.push(`alt="${escapeAttr(val)}"`);
      } else if ((tag === 'td' || tag === 'th') && (name === 'colspan' || name === 'rowspan')) {
        const span = Number.parseInt(val, 10);
        if (Number.isInteger(span) && span > 1 && span <= 50) {
          keptAttrs.push(`${name}="${span}"`);
        }
      }
    }

    const selfClose = tag === 'br' || tag === 'hr' || tag === 'img' ? ' /' : '';
    const attrText = keptAttrs.length ? ` ${keptAttrs.join(' ')}` : '';
    void match;
    return `<${tag}${attrText}${selfClose}>`;
  });
}

async function renderWordDocx(data: Uint8Array): Promise<HostDocumentPreview> {
  const mammoth = await import('mammoth');
  const result = await mammoth.convertToHtml({ buffer: Buffer.from(data) });
  return {
    kind: 'word',
    html: sanitizeWordHtml(result.value),
  };
}

function formatCellText(cell: ExcelJS.Cell): string {
  const raw = cell.text;
  if (typeof raw === 'string' && raw.length > 0) return raw;
  const value = cell.value;
  if (value === null || value === undefined) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object') {
    if ('richText' in value && Array.isArray(value.richText)) {
      return value.richText.map((part) => part.text ?? '').join('');
    }
    if ('result' in value && value.result !== undefined && value.result !== null) {
      return String(value.result);
    }
    if ('text' in value && typeof value.text === 'string') return value.text;
  }
  return '';
}

async function renderExcelXlsx(
  data: Uint8Array,
  filename: string,
  revision: string,
  readOnlyLegacy: boolean,
): Promise<HostDocumentPreview> {
  const { default: ExcelJS } = await import('exceljs');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(data) as unknown as ExcelJS.Buffer);

  const sheets: WorkSpreadsheetSheet[] = [];
  for (const sheet of workbook.worksheets.slice(0, MAX_SHEETS)) {
    const totalRows = sheet.rowCount;
    const totalCols = sheet.columnCount;
    const rowLimit = Math.min(totalRows, MAX_SHEET_ROWS);
    const colLimit = Math.min(Math.max(totalCols, 1), MAX_SHEET_COLS);
    const rows: string[][] = [];
    let maxUsedCol = 0;

    for (let r = 1; r <= rowLimit; r += 1) {
      const row = sheet.getRow(r);
      const values: string[] = [];
      for (let c = 1; c <= colLimit; c += 1) {
        const text = formatCellText(row.getCell(c));
        values.push(text);
        if (text !== '' && c > maxUsedCol) maxUsedCol = c;
      }
      rows.push(values);
    }

    // Trim trailing completely empty rows and unused columns beyond maxUsedCol.
    while (rows.length > 0 && rows[rows.length - 1].every((cell) => cell === '')) {
      rows.pop();
    }
    const finalColCount = maxUsedCol;
    const trimmedRows = finalColCount > 0
      ? rows.map((row) => row.slice(0, finalColCount))
      : [];

    sheets.push({
      name: sheet.name,
      rows: trimmedRows,
      totalRows,
      totalCols,
      truncated: totalRows > MAX_SHEET_ROWS || totalCols > MAX_SHEET_COLS,
    });
  }

  const spreadsheet = excelWorkbookToXSpreadsheet(workbook);
  return {
    kind: 'excel',
    sheets,
    spreadsheet,
    revision,
    ...(readOnlyLegacy ? { readOnlyLegacy: true } : {}),
  };
}

function resolveZipTarget(baseDir: string, target: string): string {
  const clean = target.replace(/^\/+/u, '');
  if (target.startsWith('/')) return clean;
  const parts = `${baseDir}/${clean}`.split('/');
  const resolved: string[] = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') resolved.pop();
    else resolved.push(part);
  }
  return resolved.join('/');
}

function parseSlideParagraphs(xmlFragment: string): Array<{ text: string; level?: number }> {
  const out: Array<{ text: string; level?: number }> = [];
  const pRe = /<a:p\b[^>]*>([\s\S]*?)<\/a:p>/gu;
  let pMatch: RegExpExecArray | null;
  while ((pMatch = pRe.exec(xmlFragment)) !== null) {
    const inner = pMatch[1];
    const lvlMatch = /<a:pPr\b[^>]*\blvl="(\d+)"/u.exec(inner);
    const level = lvlMatch ? Number.parseInt(lvlMatch[1], 10) : undefined;
    const runs = [...inner.matchAll(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>/gu)]
      .map((match) => decodeXml(match[1]));
    const text = runs.join('').trim();
    if (!text) continue;
    out.push(level !== undefined && level > 0 ? { text, level } : { text });
  }
  return out;
}

function parseSlideTable(tblXml: string): string[][] {
  const rows: string[][] = [];
  const trRe = /<a:tr\b[^>]*>([\s\S]*?)<\/a:tr>/gu;
  let trMatch: RegExpExecArray | null;
  while ((trMatch = trRe.exec(tblXml)) !== null) {
    const cells: string[] = [];
    const tcRe = /<a:tc\b[^>]*>([\s\S]*?)<\/a:tc>/gu;
    let tcMatch: RegExpExecArray | null;
    while ((tcMatch = tcRe.exec(trMatch[1])) !== null) {
      const text = parseSlideParagraphs(tcMatch[1]).map((item) => item.text).join('\n');
      cells.push(text);
    }
    if (cells.length > 0) rows.push(cells);
  }
  return rows;
}

function parseRelationships(relsXml: string): Map<string, string> {
  const map = new Map<string, string>();
  const relRe = /<Relationship\b([^>]+)\/?>/gu;
  let match: RegExpExecArray | null;
  while ((match = relRe.exec(relsXml)) !== null) {
    const attrs = match[1];
    const id = /\bId="([^"]+)"/u.exec(attrs)?.[1];
    const target = /\bTarget="([^"]+)"/u.exec(attrs)?.[1];
    if (id && target) map.set(id, decodeXml(target));
  }
  return map;
}

function renderPowerPointPptx(data: Uint8Array): HostDocumentPreview {
  const files = unzipSync(data);
  const slideNames = Object.keys(files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/u.test(name))
    .sort((left, right) => {
      const leftNum = Number(/slide(\d+)\.xml$/u.exec(left)?.[1] ?? 0);
      const rightNum = Number(/slide(\d+)\.xml$/u.exec(right)?.[1] ?? 0);
      return leftNum - rightNum;
    });

  let totalImageBytes = 0;
  const slides: WorkPresentationSlide[] = [];

  for (const slideName of slideNames) {
    const number = Number(/slide(\d+)\.xml$/u.exec(slideName)?.[1] ?? slides.length + 1);
    const xml = decodeUtf8(files[slideName]);
    const relsName = `ppt/slides/_rels/slide${number}.xml.rels`;
    const rels = files[relsName] ? parseRelationships(decodeUtf8(files[relsName])) : new Map<string, string>();

    let title: string | undefined;
    const blocks: WorkSlideBlock[] = [];

    // Match top-level shapes, tables, and pictures in document order.
    const elementRe = /<p:sp\b[^>]*>[\s\S]*?<\/p:sp>|<a:tbl\b[^>]*>[\s\S]*?<\/a:tbl>|<p:pic\b[^>]*>[\s\S]*?<\/p:pic>/gu;
    let elemMatch: RegExpExecArray | null;
    while ((elemMatch = elementRe.exec(xml)) !== null) {
      const chunk = elemMatch[0];
      if (chunk.startsWith('<p:sp')) {
        const isTitle = /<p:ph\b[^>]*\btype="(?:title|ctrTitle)"/u.test(chunk);
        const paragraphs = parseSlideParagraphs(chunk);
        if (isTitle && !title && paragraphs.length > 0) {
          title = paragraphs.map((p) => p.text).join(' ');
        } else {
          for (const para of paragraphs) {
            blocks.push({ kind: 'paragraph', ...para });
          }
        }
      } else if (chunk.startsWith('<a:tbl')) {
        const rows = parseSlideTable(chunk);
        if (rows.length > 0) blocks.push({ kind: 'table', rows });
      } else if (chunk.startsWith('<p:pic')) {
        const rId = /\br:embed="([^"]+)"/u.exec(chunk)?.[1];
        const descr = /\bdescr="([^"]*)"/u.exec(chunk)?.[1];
        if (!rId) continue;
        const target = rels.get(rId);
        if (!target) continue;
        const mediaPath = resolveZipTarget('ppt/slides', target);
        const mediaBytes = files[mediaPath];
        if (!mediaBytes || mediaBytes.byteLength === 0) continue;
        if (mediaBytes.byteLength > MAX_SLIDE_IMAGE_BYTES || totalImageBytes + mediaBytes.byteLength > MAX_DECK_IMAGE_BYTES) {
          continue;
        }
        const mime = IMAGE_MIME_BY_EXT[extensionOf(mediaPath)];
        if (!mime || mime === 'image/svg+xml') continue;
        totalImageBytes += mediaBytes.byteLength;
        blocks.push({
          kind: 'image',
          src: `data:${mime};base64,${Buffer.from(mediaBytes).toString('base64')}`,
          ...(descr ? { alt: decodeXml(descr) } : {}),
        });
      }
    }

    const notesName = `ppt/notesSlides/notesSlide${number}.xml`;
    let notes: string | undefined;
    if (files[notesName]) {
      const noteParagraphs = parseSlideParagraphs(decodeUtf8(files[notesName]))
        .map((item) => item.text)
        .filter((line) => line !== String(number));
      if (noteParagraphs.length > 0) notes = noteParagraphs.join('\n');
    }

    slides.push({
      number,
      ...(title ? { title } : {}),
      blocks,
      ...(notes ? { notes } : {}),
    });
  }

  return { kind: 'powerpoint', slides };
}

export async function renderWorkDocumentPreview(
  filename: string,
  data: Uint8Array,
  settings?: Settings,
): Promise<HostDocumentPreview> {
  const format = detectWorkDocumentFormat(filename);
  if (format !== 'word' && format !== 'excel' && format !== 'powerpoint') {
    throw new AppError(415, 'document_preview_unsupported', '暂不支持渲染预览此文件类型。');
  }

  const revision = createHash('sha256').update(data).digest('hex');
  let ext = extensionOf(filename);
  let payload: Uint8Array = data;
  let readOnlyLegacy = false;

  if (LEGACY_FORMATS.has(ext)) {
    if (!settings) {
      throw new AppError(503, 'document_converter_unavailable', '旧版 Office 文件需要 LibreOffice 转换引擎，建议另存为 .docx / .xlsx / .pptx 后查看。');
    }
    const converted = await convertLegacy(settings, filename, data);
    ext = converted.format;
    payload = converted.data;
    readOnlyLegacy = true;
  }

  try {
    if (ext === 'docx') return { ...(await renderWordDocx(payload)), revision, ...(readOnlyLegacy ? { readOnlyLegacy: true } : {}) };
    if (ext === 'xlsx') return await renderExcelXlsx(payload, filename, revision, readOnlyLegacy);
    if (ext === 'pptx') return { ...renderPowerPointPptx(payload), revision, ...(readOnlyLegacy ? { readOnlyLegacy: true } : {}) };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(422, 'document_preview_failed', '无法解析该 Office 文档，文件可能已损坏或受密码保护。', { cause: error });
  }

  throw new AppError(415, 'document_preview_unsupported', '暂不支持渲染预览此文件类型。');
}
