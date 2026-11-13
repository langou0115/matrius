import ExcelJS from 'exceljs';
import { unzipSync } from 'fflate';
import * as mammoth from 'mammoth';
import { extractText as extractPdfText } from 'unpdf';

import { AppError } from '../../errors';
import { extensionOf } from '../file-types';

const MAX_EXTRACTED_CHARS = 2_000_000;
const LEGACY_FORMATS = new Set(['doc', 'xls', 'ppt']);

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'")
    .replace(/&amp;/gu, '&');
}

function decodeText(data: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    return new TextDecoder('utf-8', { fatal: false }).decode(data);
  }
}

async function extractDocx(data: Uint8Array): Promise<string> {
  const result = await mammoth.extractRawText({ buffer: Buffer.from(data) });
  return result.value;
}

async function extractXlsx(data: Uint8Array): Promise<string> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(data) as unknown as ExcelJS.Buffer);
  const parts: string[] = [];
  workbook.eachSheet((sheet) => {
    parts.push(`# ${sheet.name}`);
    sheet.eachRow({ includeEmpty: true }, (row) => {
      const values: string[] = [];
      row.eachCell({ includeEmpty: true }, (cell, column) => {
        values[column - 1] = cell.text;
      });
      parts.push(Array.from(values, (value) => value ?? '').join('\t'));
    });
  });
  return parts.join('\n');
}

function extractPptx(data: Uint8Array): string {
  const files = unzipSync(data);
  const slides = Object.keys(files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/u.test(name))
    .sort((left, right) => {
      const leftNumber = Number(/slide(\d+)\.xml$/u.exec(left)?.[1] ?? 0);
      const rightNumber = Number(/slide(\d+)\.xml$/u.exec(right)?.[1] ?? 0);
      return leftNumber - rightNumber;
    });
  const parts: string[] = [];
  for (const name of slides) {
    const number = Number(/slide(\d+)\.xml$/u.exec(name)?.[1] ?? 0);
    const xml = decodeText(files[name]);
    const texts = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/gu)].map((match) => decodeXml(match[1]));
    parts.push(`# Slide ${number}`, ...texts);
  }
  return parts.join('\n');
}

async function extractPdf(data: Uint8Array): Promise<string> {
  const result = await extractPdfText(new Uint8Array(data), { mergePages: true });
  return result.text;
}

export async function extractText(filename: string, data: Uint8Array): Promise<string> {
  const extension = extensionOf(filename);
  let text: string;
  try {
    if (extension === 'pdf') text = await extractPdf(data);
    else if (extension === 'docx') text = await extractDocx(data);
    else if (extension === 'xlsx') text = await extractXlsx(data);
    else if (extension === 'pptx') text = extractPptx(data);
    else if (LEGACY_FORMATS.has(extension)) {
      throw new AppError(503, 'document_converter_unavailable', '旧版 Office 文件转换器尚未接入当前 Node 服务。');
    } else text = decodeText(data);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(422, 'parse_failed', '无法解析该文件。', { cause: error });
  }
  return text.slice(0, MAX_EXTRACTED_CHARS);
}
