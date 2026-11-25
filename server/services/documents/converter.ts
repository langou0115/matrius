import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { createConverter } from '@deepseek-ai/libreoffice-kit';

import type { Settings } from '../../config';
import { AppError } from '../../errors';
import { extensionOf } from '../file-types';
import { fontPath } from './binaries';

const TARGETS: Record<string, string> = { doc: 'docx', xls: 'xlsx', ppt: 'pptx' };
const PDF_RENDERABLE = new Set(['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx']);
const PDF_CACHE_MAX = 16;
const pdfRenderCache = new Map<string, Buffer>();

function getCachedPdf(key: string): Buffer | undefined {
  const hit = pdfRenderCache.get(key);
  if (!hit) return undefined;
  pdfRenderCache.delete(key);
  pdfRenderCache.set(key, hit);
  return hit;
}

function setCachedPdf(key: string, pdf: Buffer): void {
  pdfRenderCache.delete(key);
  pdfRenderCache.set(key, pdf);
  while (pdfRenderCache.size > PDF_CACHE_MAX) {
    const oldest = pdfRenderCache.keys().next().value;
    if (oldest !== undefined) pdfRenderCache.delete(oldest);
  }
}

function conversionError(error: unknown): AppError {
  const code = error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code)
    : '';
  if (code === 'timeout') return new AppError(504, 'document_conversion_timeout', '旧版 Office 转换超时，请重试。');
  if (code === 'unavailable') return new AppError(503, 'document_converter_unavailable', '旧版 Office 转换引擎不可用。');
  if (code === 'input-too-large' || code === 'output-too-large') {
    return new AppError(413, 'document_too_large', '旧版 Office 文件过大，无法转换。');
  }
  if (code === 'invalid-document' || code === 'unsupported-format') {
    return new AppError(422, 'invalid_document', '无法识别该旧版 Office 文件。', { cause: error });
  }
  return new AppError(502, 'document_conversion_failed', '旧版 Office 转换失败，请重试。', { cause: error });
}

export async function convertLegacy(
  settings: Settings,
  filename: string,
  data: Uint8Array,
): Promise<{ filename: string; format: string; data: Buffer }> {
  const extension = extensionOf(filename);
  const target = TARGETS[extension];
  if (!target) throw new AppError(415, 'unsupported_file_type', '只支持 .doc/.xls/.ppt 旧版 Office 转换。');
  const directory = await mkdtemp(join(tmpdir(), 'matrius-convert-'));
  try {
    const inputPath = join(directory, `input.${extension}`);
    const outputPath = join(directory, `output.${target}`);
    await writeFile(inputPath, data);
    let converter: Awaited<ReturnType<typeof createConverter>> | null = null;
    try {
      converter = await createConverter({
        timeoutMs: settings.DOCUMENT_TOOL_TIMEOUT_SECONDS * 1000,
        maxInputBytes: settings.MAX_UPLOAD_BYTES,
        maxOutputBytes: settings.MAX_UPLOAD_BYTES,
        fontDirectories: [dirname(fontPath(settings))],
        fontMetadataCacheDirectory: false,
      });
      await converter.convert({ inputPath, outputPath });
    } catch (error) {
      throw conversionError(error);
    } finally {
      await converter?.dispose();
    }
    const converted = await readFile(outputPath);
    if (converted.length < 4 || converted[0] !== 0x50 || converted[1] !== 0x4b) {
      throw new AppError(502, 'document_conversion_failed', '转换器没有生成有效的 Office 文件。');
    }
    const stem = filename.includes('.') ? filename.slice(0, filename.lastIndexOf('.')) : filename;
    return { filename: `${stem}.${target}`, format: target, data: converted };
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {});
  }
}

export async function renderOfficeToPdf(
  settings: Settings,
  filename: string,
  data: Uint8Array,
  signal?: AbortSignal,
): Promise<Buffer> {
  const extension = extensionOf(filename);
  if (!PDF_RENDERABLE.has(extension)) {
    throw new AppError(415, 'unsupported_file_type', '暂不支持将此文件渲染为 PDF 预览。');
  }
  const cacheKey = `${extension}:${createHash('sha256').update(data).digest('hex')}`;
  const cached = getCachedPdf(cacheKey);
  if (cached) return cached;

  const directory = await mkdtemp(join(tmpdir(), 'matrius-pdf-'));
  try {
    const inputPath = join(directory, `input.${extension}`);
    const outputPath = join(directory, 'output.pdf');
    await writeFile(inputPath, data);
    let converter: Awaited<ReturnType<typeof createConverter>> | null = null;
    try {
      // Omit fontDirectories so native LibreOffice discovers system + Microsoft Office fonts
      // (including SimSun / Microsoft YaHei / Calibri) and reuses the user font cache.
      converter = await createConverter({
        timeoutMs: Math.max(settings.DOCUMENT_TOOL_TIMEOUT_SECONDS * 1000, 60_000),
        maxInputBytes: Math.max(settings.MAX_UPLOAD_BYTES, 32 * 1024 * 1024),
        maxOutputBytes: Math.max(settings.MAX_UPLOAD_BYTES, 64 * 1024 * 1024),
      });
      await converter.render({ inputPath, outputPath }, signal);
    } catch (error) {
      throw conversionError(error);
    } finally {
      await converter?.dispose();
    }
    const pdf = await readFile(outputPath);
    if (pdf.length < 4 || !pdf.subarray(0, 4).equals(Buffer.from('%PDF'))) {
      throw new AppError(502, 'document_conversion_failed', '文档渲染引擎未生成有效的 PDF。');
    }
    setCachedPdf(cacheKey, pdf);
    return pdf;
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {});
  }
}
