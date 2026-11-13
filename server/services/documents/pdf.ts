import { readFile } from 'node:fs/promises';

import fontkit from '@pdf-lib/fontkit';
import { degrees, PDFDocument, rgb, StandardFonts, type PDFFont, type PDFPage } from 'pdf-lib';
import { extractText as extractPdfText } from 'unpdf';

import type { Settings } from '../../config';
import { AppError, invalid } from '../../errors';
import { fontPath } from './binaries';

const MAX_PDF_PAGES = 2_000;
const A4_WIDTH = 595.28;
const A4_HEIGHT = 841.89;
const LINE_HEIGHT = 1.4;
const MAX_CHANGES = 100;

type DrawText = {
  operation: 'draw_text';
  page: number;
  text: string;
  x: number;
  y: number;
  size: number;
  color: string;
};
type ReplacePage = Omit<DrawText, 'operation'> & { operation: 'replace_page' };
type AddPage = {
  operation: 'add_page';
  page?: number;
  width?: number;
  height?: number;
  text: string;
  x: number;
  y: number;
  size: number;
  color: string;
};
type RemovePage = { operation: 'remove_page'; page: number };
type RotatePage = { operation: 'rotate_page'; page: number; degrees: 0 | 90 | 180 | 270 };
type SetField = { operation: 'set_field'; name: string; text: string };
export type PdfChange = DrawText | ReplacePage | AddPage | RemovePage | RotatePage | SetField;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown, field: string, min?: number): number {
  const number = typeof value === 'number' && Number.isFinite(value) ? value : NaN;
  if (!Number.isFinite(number) || (min !== undefined && number < min)) throw invalid(`${field} 不合法。`);
  return number;
}

function textValue(value: unknown, field: string, max = 50_000): string {
  if (typeof value !== 'string' || value.length > max) throw invalid(`${field} 不合法。`);
  return value;
}

function colorValue(value: unknown): string {
  if (value === undefined) return '#000000';
  if (typeof value !== 'string' || !/^#?[0-9a-f]{6}$/iu.test(value)) throw invalid('color 必须是 #RRGGBB。');
  return value.startsWith('#') ? value : `#${value}`;
}

function pageValue(value: unknown): number {
  const page = finiteNumber(value, 'page', 1);
  if (!Number.isInteger(page)) throw invalid('page 必须是正整数。');
  return page;
}

export function validatePdfChanges(value: unknown): PdfChange[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_CHANGES) throw invalid('pdfChanges 必须是数组，且最多 100 条。');
  return value.map((raw, index) => {
    if (!isRecord(raw) || typeof raw.operation !== 'string') throw invalid(`第 ${index + 1} 条 PDF 操作格式不正确。`);
    const operation = raw.operation;
    if (operation === 'draw_text') {
      return {
        operation: 'draw_text',
        page: pageValue(raw.page),
        text: textValue(raw.text, 'text'),
        x: finiteNumber(raw.x, 'x', 0),
        y: finiteNumber(raw.y, 'y', 0),
        size: raw.size === undefined ? 12 : finiteNumber(raw.size, 'size', 1),
        color: colorValue(raw.color),
      };
    }
    if (operation === 'replace_page') {
      return {
        operation: 'replace_page',
        page: pageValue(raw.page),
        text: textValue(raw.text, 'text'),
        x: finiteNumber(raw.x, 'x', 0),
        y: finiteNumber(raw.y, 'y', 0),
        size: raw.size === undefined ? 12 : finiteNumber(raw.size, 'size', 1),
        color: colorValue(raw.color),
      };
    }
    if (operation === 'add_page') {
      return {
        operation: 'add_page',
        ...(raw.page !== undefined ? { page: pageValue(raw.page) } : {}),
        ...(raw.width !== undefined ? { width: finiteNumber(raw.width, 'width', 1) } : {}),
        ...(raw.height !== undefined ? { height: finiteNumber(raw.height, 'height', 1) } : {}),
        text: textValue(raw.text ?? '', 'text'),
        x: raw.x === undefined ? 0 : finiteNumber(raw.x, 'x', 0),
        y: raw.y === undefined ? 0 : finiteNumber(raw.y, 'y', 0),
        size: raw.size === undefined ? 12 : finiteNumber(raw.size, 'size', 1),
        color: colorValue(raw.color),
      };
    }
    if (operation === 'remove_page') return { operation: 'remove_page', page: pageValue(raw.page) };
    if (operation === 'rotate_page') {
      const rotation = raw.degrees;
      if (rotation !== 0 && rotation !== 90 && rotation !== 180 && rotation !== 270) {
        throw invalid('degrees 只能是 0/90/180/270。');
      }
      return { operation: 'rotate_page', page: pageValue(raw.page), degrees: rotation };
    }
    if (operation === 'set_field') {
      return {
        operation: 'set_field',
        name: textValue(raw.name, 'name', 200),
        text: textValue(raw.text, 'text'),
      };
    }
    throw invalid(`不支持的 PDF 操作：${operation}。`);
  });
}

async function loadPdf(data: Uint8Array): Promise<PDFDocument> {
  try {
    const document = await PDFDocument.load(data);
    if (document.getPageCount() > MAX_PDF_PAGES) {
      throw new AppError(422, 'document_too_large', 'PDF 页数超过 2000 页。');
    }
    return document;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(422, 'parse_failed', '无法解析 PDF 文件。', { cause: error });
  }
}

export async function inspectPdf(data: Uint8Array): Promise<string> {
  const document = await loadPdf(data);
  let texts: string[] = [];
  try {
    const extracted = await extractPdfText(new Uint8Array(data), { mergePages: false });
    texts = extracted.text as string[];
  } catch {
    // Text extraction is best effort; page geometry and fields still work.
  }
  const pages = document.getPages().map((page, index) => ({
    page: index + 1,
    width: Math.round(page.getWidth() * 100) / 100,
    height: Math.round(page.getHeight() * 100) / 100,
    rotation: page.getRotation().angle,
    text: (texts[index] ?? '').replaceAll('\0', '').trim().slice(0, 2_000),
  }));
  const fields: Array<{ name: string; type: string }> = [];
  try {
    for (const field of document.getForm().getFields()) {
      fields.push({ name: field.getName(), type: field.constructor.name });
    }
  } catch {
    // A PDF without an AcroForm is normal.
  }
  return JSON.stringify({ pageCount: document.getPageCount(), pages, fields }, null, 2);
}

function parseColor(value: string) {
  const hex = value.replace(/^#/u, '');
  return rgb(
    Number.parseInt(hex.slice(0, 2), 16) / 255,
    Number.parseInt(hex.slice(2, 4), 16) / 255,
    Number.parseInt(hex.slice(4, 6), 16) / 255,
  );
}

function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.replace(/\r\n/gu, '\n').replace(/\r/gu, '\n').split('\n')) {
    if (!paragraph) {
      lines.push('');
      continue;
    }
    let current = '';
    for (const char of paragraph) {
      const candidate = current + char;
      if (current && font.widthOfTextAtSize(candidate, size) > maxWidth) {
        lines.push(current);
        current = char;
      } else {
        current = candidate;
      }
    }
    lines.push(current);
  }
  return lines;
}

function drawText(
  page: PDFPage,
  latinFont: PDFFont,
  cjkFont: PDFFont,
  change: { text: string; x: number; y: number; size: number; color: string },
): void {
  if (!change.text) return;
  // A standard font keeps ASCII extractable; the embedded face is only needed
  // for CJK glyphs (pdf-lib's custom-font ToUnicode loses Latin mappings).
  const font = /^[\x00-\x7F]*$/u.test(change.text) ? latinFont : cjkFont;
  const maxWidth = page.getWidth() - change.x;
  if (maxWidth <= 0) throw new AppError(422, 'invalid_document_operation', '文本坐标超出页面范围。');
  const lines = wrapText(change.text, font, change.size, maxWidth);
  let currentY = page.getHeight() - change.y - change.size;
  if (currentY < 0) throw new AppError(422, 'invalid_document_operation', '文本坐标超出页面范围。');
  const totalHeight = lines.length * change.size * LINE_HEIGHT;
  if (currentY - totalHeight < -change.size) {
    throw new AppError(422, 'invalid_document_operation', '文本超出页面高度，请缩小字号或分段绘制。');
  }
  for (const line of lines) {
    page.drawText(line, {
      x: change.x,
      y: currentY,
      size: change.size,
      font,
      color: parseColor(change.color),
    });
    currentY -= change.size * LINE_HEIGHT;
  }
}

function requirePage(page: number, count: number): void {
  if (page < 1 || page > count) {
    throw new AppError(422, 'invalid_document_operation', `页面 ${page} 不存在（共 ${count} 页）。`);
  }
}

export async function applyPdfChanges(
  settings: Settings,
  data: Uint8Array | null,
  changes: PdfChange[],
): Promise<Buffer> {
  const document = data ? await loadPdf(data) : await PDFDocument.create();
  if (!data) document.addPage([A4_WIDTH, A4_HEIGHT]);
  document.registerFontkit(fontkit);
  const latinFont = await document.embedFont(StandardFonts.Helvetica);
  const font = await document.embedFont(
    await readFile(fontPath(settings)),
    { subset: false },
  );

  const fieldValues = new Map<string, string>();
  for (const change of changes) {
    const pageCount = document.getPageCount();
    if (change.operation === 'draw_text') {
      requirePage(change.page, pageCount);
      drawText(document.getPage(change.page - 1), latinFont, font, change);
    } else if (change.operation === 'replace_page') {
      requirePage(change.page, pageCount);
      const old = document.getPage(change.page - 1);
      const width = old.getWidth();
      const height = old.getHeight();
      document.removePage(change.page - 1);
      const blank = document.insertPage(change.page - 1, [width, height]);
      drawText(blank, latinFont, font, change);
    } else if (change.operation === 'add_page') {
      const index = change.page === undefined ? pageCount : Math.min(change.page - 1, pageCount);
      const source = pageCount ? document.getPage(Math.max(0, Math.min(index, pageCount - 1))) : null;
      const width = change.width ?? source?.getWidth() ?? A4_WIDTH;
      const height = change.height ?? source?.getHeight() ?? A4_HEIGHT;
      const page = document.insertPage(index, [width, height]);
      drawText(page, latinFont, font, change);
    } else if (change.operation === 'remove_page') {
      requirePage(change.page, pageCount);
      if (pageCount <= 1) throw new AppError(422, 'invalid_document_operation', '不能删除 PDF 的唯一一页。');
      document.removePage(change.page - 1);
    } else if (change.operation === 'rotate_page') {
      requirePage(change.page, pageCount);
      document.getPage(change.page - 1).setRotation(degrees(change.degrees));
    } else if (change.operation === 'set_field') {
      fieldValues.set(change.name, change.text);
    }
  }

  if (fieldValues.size) {
    try {
      const form = document.getForm();
      for (const [name, value] of fieldValues) form.getTextField(name).setText(value);
      form.updateFieldAppearances(font);
    } catch (error) {
      throw new AppError(422, 'invalid_document_operation', 'PDF 表单字段写入失败。', { cause: error });
    }
  }

  const result = Buffer.from(await document.save());
  if (result.length > settings.MAX_UPLOAD_BYTES) {
    throw new AppError(413, 'document_too_large', '生成的 PDF 超过 20 MiB。');
  }
  return result;
}
