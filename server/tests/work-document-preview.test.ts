import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import ExcelJS from 'exceljs';
import { strToU8, zipSync } from 'fflate';
import { PDFDocument } from 'pdf-lib';

import { buildApp } from '../app';
import { loadSettings } from '../config';
import { renderWorkDocumentPreview, sanitizeWordHtml } from '../services/work-document-preview';
import { excelBufferToXSpreadsheet, xSpreadsheetToExcelBuffer } from '../services/work-excel-spreadsheet';

function buildMinimalDocx(bodyXml: string): Uint8Array {
  return zipSync({
    '[Content_Types].xml': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
      + '<Default Extension="xml" ContentType="application/xml"/>'
      + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
      + '</Types>',
    ),
    '_rels/.rels': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
      + '</Relationships>',
    ),
    'word/document.xml': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
      + `<w:body>${bodyXml}</w:body></w:document>`,
    ),
  });
}

function buildMinimalPptx(): Uint8Array {
  return zipSync({
    'ppt/slides/slide1.xml': strToU8(
      '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">'
      + '<p:cSld><p:spTree>'
      + '<p:sp><p:nvSpPr><p:nvPr><p:ph type="ctrTitle"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>季度汇报</a:t></a:r></a:p></p:txBody></p:sp>'
      + '<p:sp><p:nvSpPr><p:nvPr/></p:nvSpPr><p:txBody><a:p><a:pPr lvl="1"/><a:r><a:t>核心指标达成</a:t></a:r></a:p></p:txBody></p:sp>'
      + '<a:tbl><a:tr><a:tc><a:txBody><a:p><a:r><a:t>项目</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:p><a:r><a:t>进度</a:t></a:r></a:p></a:txBody></a:tc></a:tr>'
      + '<a:tr><a:tc><a:txBody><a:p><a:r><a:t>Matrius</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:p><a:r><a:t>100%</a:t></a:r></a:p></a:txBody></a:tc></a:tr></a:tbl>'
      + '</p:spTree></p:cSld></p:sld>',
    ),
    'ppt/notesSlides/notesSlide1.xml': strToU8(
      '<p:notes xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">'
      + '<p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>重点强调交付速度</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>',
    ),
  });
}

test('sanitizeWordHtml strips scripts, inline handlers, and unsafe URLs while keeping semantic HTML', () => {
  const dirty = '<h1>标题</h1><script>alert(1)</script><p onclick="evil()">正文 <a href="javascript:alert(2)">坏链</a> <a href="https://example.com">好链</a></p>';
  const clean = sanitizeWordHtml(dirty);
  assert.match(clean, /<h1>标题<\/h1>/u);
  assert.doesNotMatch(clean, /script|onclick|javascript:/iu);
  assert.match(clean, /href="https:\/\/example\.com"/u);
  assert.match(clean, /rel="noreferrer noopener"/u);
});

test('renderWorkDocumentPreview renders docx, xlsx, and pptx into structured previews', async () => {
  const docx = buildMinimalDocx('<w:p><w:r><w:t>Hello Word 文档</w:t></w:r></w:p>');
  const wordRes = await renderWorkDocumentPreview('notes.docx', docx);
  assert.equal(wordRes.kind, 'word');
  assert.match(wordRes.html, /Hello Word 文档/u);

  const wb = new ExcelJS.Workbook();
  const s1 = wb.addWorksheet('汇总');
  s1.addRow(['名称', '数值']);
  s1.addRow(['延迟', 12]);
  const s2 = wb.addWorksheet('明细');
  s2.addRow(['条目']);
  const xlsxBuf = new Uint8Array(await wb.xlsx.writeBuffer());
  const excelRes = await renderWorkDocumentPreview('report.xlsx', xlsxBuf);
  assert.equal(excelRes.kind, 'excel');
  assert.equal(excelRes.sheets.length, 2);
  assert.equal(excelRes.sheets[0].name, '汇总');
  assert.deepEqual(excelRes.sheets[0].rows, [['名称', '数值'], ['延迟', '12']]);
  assert.equal(excelRes.sheets[1].name, '明细');

  const pptRes = await renderWorkDocumentPreview('deck.pptx', buildMinimalPptx());
  assert.equal(pptRes.kind, 'powerpoint');
  assert.equal(pptRes.slides.length, 1);
  assert.equal(pptRes.slides[0].title, '季度汇报');
  assert.deepEqual(pptRes.slides[0].blocks[0], { kind: 'paragraph', text: '核心指标达成', level: 1 });
  assert.deepEqual(pptRes.slides[0].blocks[1], { kind: 'table', rows: [['项目', '进度'], ['Matrius', '100%']] });
  assert.equal(pptRes.slides[0].notes, '重点强调交付速度');
});

test('host fs document and raw endpoints serve Office previews and inline PDFs', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'matrius-doc-preview-'));
  const settings = loadSettings({ APP_ENV: 'test', MATRIUS_DESKTOP_DEV: 'true', DATA_DIR: directory, LOG_LEVEL: 'silent' });
  const built = await buildApp({ settings });
  t.after(async () => {
    await built.app.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const docxPath = join(directory, 'sample.docx');
  writeFileSync(docxPath, buildMinimalDocx('<w:p><w:r><w:t>接口联调成功</w:t></w:r></w:p>'));

  const pdfDoc = await PDFDocument.create();
  pdfDoc.addPage([200, 200]);
  const pdfBytes = await pdfDoc.save();
  const pdfPath = join(directory, 'sample.pdf');
  writeFileSync(pdfPath, pdfBytes);

  const docRes = await built.app.inject({
    method: 'GET',
    url: `/api/hosts/local/fs/document?path=${encodeURIComponent(docxPath)}`,
  });
  assert.equal(docRes.statusCode, 200);
  const docJson = docRes.json();
  assert.equal(docJson.kind, 'word');
  assert.match(docJson.html, /接口联调成功/u);

  const rawRes = await built.app.inject({
    method: 'GET',
    url: `/api/hosts/local/fs/raw?path=${encodeURIComponent(pdfPath)}`,
  });
  assert.equal(rawRes.statusCode, 200);
  assert.equal(rawRes.headers['content-type'], 'application/pdf');
  assert.equal(rawRes.headers['content-disposition'], 'inline');
  assert.equal(rawRes.headers['x-content-type-options'], 'nosniff');
  assert.ok(rawRes.rawPayload.subarray(0, 4).equals(Buffer.from('%PDF')));

  const rawDocx = await built.app.inject({
    method: 'GET',
    url: `/api/hosts/local/fs/raw?path=${encodeURIComponent(docxPath)}`,
  });
  assert.equal(rawDocx.statusCode, 200);
  assert.equal(rawDocx.headers['content-type'], 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  assert.match(String(rawDocx.headers['x-file-revision'] ?? ''), /^[a-f0-9]{64}$/u);

  const txtPath = join(directory, 'plain.txt');
  writeFileSync(txtPath, 'hello');
  const badRaw = await built.app.inject({
    method: 'GET',
    url: `/api/hosts/local/fs/raw?path=${encodeURIComponent(txtPath)}`,
  });
  assert.equal(badRaw.statusCode, 415);
});

test('excelBufferToXSpreadsheet and xSpreadsheetToExcelBuffer round-trip sheets, values, formulas, and styles', async () => {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet('预算');
  sheet.getColumn(1).width = 20;
  sheet.getRow(1).height = 24;
  const titleCell = sheet.getCell('A1');
  titleCell.value = '项目';
  titleCell.font = { bold: true, color: { argb: 'FF1F2328' } };
  titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F4F6' } };
  sheet.getCell('B1').value = 100;
  sheet.getCell('B2').value = { formula: 'B1*2', result: 200 };
  sheet.mergeCells('C1:D1');

  const initialBytes = new Uint8Array(await wb.xlsx.writeBuffer());
  const sheets = await excelBufferToXSpreadsheet(initialBytes);
  assert.equal(sheets.length, 1);
  const s0 = sheets[0];
  assert.equal(s0.name, '预算');
  const row0 = s0.rows['0'] as { cells: Record<string, { text?: string }> };
  const row1 = s0.rows['1'] as { cells: Record<string, { text?: string }> };
  assert.equal(row0.cells['0'].text, '项目');
  assert.equal(row0.cells['1'].text, '100');
  assert.equal(row1.cells['1'].text, '=B1*2');
  assert.equal(s0.merges.length, 1);

  // Edit cell and round-trip back to xlsx
  row0.cells['1'] = { text: '250' };
  const savedBuf = await xSpreadsheetToExcelBuffer(sheets);
  const reloaded = new ExcelJS.Workbook();
  await reloaded.xlsx.load(savedBuf as unknown as ExcelJS.Buffer);
  const reloadedSheet = reloaded.getWorksheet('预算');
  assert.ok(reloadedSheet);
  assert.equal(reloadedSheet.getCell('A1').value, '项目');
  assert.equal(reloadedSheet.getCell('B1').value, 250);
  assert.equal(reloadedSheet.getCell('A1').font?.bold, true);
});
