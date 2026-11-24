import type ExcelJS from 'exceljs';

type UniverColor = { rgb: string };
type UniverBorderEdge = { s: number; cl: UniverColor };
type UniverStyleData = {
  ff?: string;
  fs?: number;
  bl?: 0 | 1;
  it?: 0 | 1;
  ul?: { s: 0 | 1 };
  st?: { s: 0 | 1 };
  cl?: UniverColor;
  bg?: UniverColor;
  ht?: 1 | 2 | 3;
  vt?: 1 | 2 | 3;
  tb?: 1 | 2 | 3;
  bd?: {
    t?: UniverBorderEdge;
    b?: UniverBorderEdge;
    l?: UniverBorderEdge;
    r?: UniverBorderEdge;
  };
};

type UniverCellData = {
  v?: string | number | boolean;
  f?: string;
  t?: 1 | 2 | 3;
  s?: string | UniverStyleData;
};

type UniverMergeRange = {
  startRow: number;
  endRow: number;
  startColumn: number;
  endColumn: number;
};

type UniverWorksheetData = {
  id: string;
  name: string;
  tabColor?: string;
  hidden?: 0 | 1;
  rowCount: number;
  columnCount: number;
  defaultColumnWidth: number;
  defaultRowHeight: number;
  freeze?: {
    xSplit: number;
    ySplit: number;
    startRow: number;
    startColumn: number;
  };
  mergeData: UniverMergeRange[];
  cellData: Record<number, Record<number, UniverCellData>>;
  rowData: Record<number, { h?: number; hd?: 0 | 1 }>;
  columnData: Record<number, { w?: number; hd?: 0 | 1 }>;
};

export type UniverWorkbookSnapshot = {
  id: string;
  name: string;
  appVersion: string;
  locale: string;
  styles: Record<string, UniverStyleData>;
  sheetOrder: string[];
  sheets: Record<string, UniverWorksheetData>;
};

const MAX_UNIVER_SHEETS = 30;
const MAX_UNIVER_ROWS = 2000;
const MAX_UNIVER_COLS = 100;

function argbToRgbHex(argb?: string): string | undefined {
  if (!argb || typeof argb !== 'string') return undefined;
  const clean = argb.replace(/^#/u, '').trim();
  if (clean.length === 8) return `#${clean.slice(2).toUpperCase()}`;
  if (clean.length === 6) return `#${clean.toUpperCase()}`;
  return undefined;
}

function rgbHexToArgb(rgb?: string): string | undefined {
  if (!rgb || typeof rgb !== 'string') return undefined;
  const clean = rgb.replace(/^#/u, '').trim();
  if (clean.length === 6 && /^[0-9a-f]{6}$/iu.test(clean)) return `FF${clean.toUpperCase()}`;
  if (clean.length === 8 && /^[0-9a-f]{8}$/iu.test(clean)) return clean.toUpperCase();
  return undefined;
}

function excelBorderStyleToUniver(style?: ExcelJS.BorderStyle): number {
  switch (style) {
    case 'medium':
      return 8;
    case 'thick':
      return 13;
    case 'dashed':
      return 3;
    case 'dotted':
      return 4;
    case 'double':
      return 7;
    default:
      return 1;
  }
}

function univerBorderStyleToExcel(style?: number): ExcelJS.BorderStyle {
  switch (style) {
    case 8:
      return 'medium';
    case 13:
      return 'thick';
    case 3:
      return 'dashed';
    case 4:
      return 'dotted';
    case 7:
      return 'double';
    default:
      return 'thin';
  }
}

function extractExcelCellStyle(cell: ExcelJS.Cell): UniverStyleData | null {
  const style: UniverStyleData = {};
  let hasAny = false;

  if (cell.font) {
    if (cell.font.name) { style.ff = cell.font.name; hasAny = true; }
    if (typeof cell.font.size === 'number' && cell.font.size > 0) { style.fs = cell.font.size; hasAny = true; }
    if (cell.font.bold) { style.bl = 1; hasAny = true; }
    if (cell.font.italic) { style.it = 1; hasAny = true; }
    if (cell.font.underline) { style.ul = { s: 1 }; hasAny = true; }
    if (cell.font.strike) { style.st = { s: 1 }; hasAny = true; }
    const fontRgb = argbToRgbHex(cell.font.color?.argb);
    if (fontRgb) { style.cl = { rgb: fontRgb }; hasAny = true; }
  }

  if (cell.fill && cell.fill.type === 'pattern' && cell.fill.pattern === 'solid') {
    const bgRgb = argbToRgbHex(cell.fill.fgColor?.argb);
    if (bgRgb) { style.bg = { rgb: bgRgb }; hasAny = true; }
  }

  if (cell.alignment) {
    if (cell.alignment.horizontal === 'left') { style.ht = 1; hasAny = true; }
    else if (cell.alignment.horizontal === 'center') { style.ht = 2; hasAny = true; }
    else if (cell.alignment.horizontal === 'right') { style.ht = 3; hasAny = true; }

    if (cell.alignment.vertical === 'top') { style.vt = 1; hasAny = true; }
    else if (cell.alignment.vertical === 'middle') { style.vt = 2; hasAny = true; }
    else if (cell.alignment.vertical === 'bottom') { style.vt = 3; hasAny = true; }

    if (cell.alignment.wrapText) { style.tb = 3; hasAny = true; }
  }

  if (cell.border) {
    const bd: NonNullable<UniverStyleData['bd']> = {};
    const sides = [
      ['top', 't'],
      ['bottom', 'b'],
      ['left', 'l'],
      ['right', 'r'],
    ] as const;
    for (const [excelSide, univerSide] of sides) {
      const edge = cell.border[excelSide];
      if (edge?.style) {
        bd[univerSide] = {
          s: excelBorderStyleToUniver(edge.style),
          cl: { rgb: argbToRgbHex(edge.color?.argb) ?? '#D0D7DE' },
        };
      }
    }
    if (Object.keys(bd).length > 0) {
      style.bd = bd;
      hasAny = true;
    }
  }

  return hasAny ? style : null;
}

function parseA1Ref(ref: string): { row: number; col: number } | null {
  const match = /^\$?([A-Z]+)\$?(\d+)$/iu.exec(ref.trim());
  if (!match) return null;
  const colLetters = match[1].toUpperCase();
  let col = 0;
  for (let i = 0; i < colLetters.length; i += 1) {
    col = col * 26 + (colLetters.charCodeAt(i) - 64);
  }
  return { row: Number(match[2]) - 1, col: col - 1 };
}

function extractCellValue(cell: ExcelJS.Cell): UniverCellData | null {
  const value = cell.value;
  if (value === null || value === undefined) return null;

  if (typeof value === 'string') {
    return value === '' ? null : { v: value, t: 1 };
  }
  if (typeof value === 'number') {
    return { v: value, t: 2 };
  }
  if (typeof value === 'boolean') {
    return { v: value ? 1 : 0, t: 3 };
  }
  if (value instanceof Date) {
    return { v: value.toISOString().slice(0, 10), t: 1 };
  }
  if (typeof value === 'object') {
    if ('formula' in value && typeof value.formula === 'string') {
      const formula = value.formula.startsWith('=') ? value.formula : `=${value.formula}`;
      const result = 'result' in value ? value.result : undefined;
      if (typeof result === 'number') return { f: formula, v: result, t: 2 };
      if (typeof result === 'string') return { f: formula, v: result, t: 1 };
      if (typeof result === 'boolean') return { f: formula, v: result ? 1 : 0, t: 3 };
      return { f: formula };
    }
    if ('richText' in value && Array.isArray(value.richText)) {
      const text = value.richText.map((part) => part.text ?? '').join('');
      return text ? { v: text, t: 1 } : null;
    }
    if ('text' in value && typeof value.text === 'string') {
      return value.text ? { v: value.text, t: 1 } : null;
    }
    if ('result' in value && value.result !== undefined && value.result !== null) {
      if (typeof value.result === 'number') return { v: value.result, t: 2 };
      return { v: String(value.result), t: 1 };
    }
  }
  return null;
}

export async function excelBufferToUniverWorkbook(
  data: Uint8Array,
  workbookName: string,
): Promise<UniverWorkbookSnapshot> {
  const { default: ExcelJS } = await import('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(data) as unknown as ExcelJS.Buffer);

  const styles: Record<string, UniverStyleData> = {};
  const styleKeyToId = new Map<string, string>();
  let styleSeq = 1;

  function registerStyle(style: UniverStyleData): string {
    const key = JSON.stringify(style);
    const existing = styleKeyToId.get(key);
    if (existing) return existing;
    const id = `s${styleSeq++}`;
    styleKeyToId.set(key, id);
    styles[id] = style;
    return id;
  }

  const sheetOrder: string[] = [];
  const sheets: Record<string, UniverWorksheetData> = {};

  const worksheets = wb.worksheets.slice(0, MAX_UNIVER_SHEETS);
  worksheets.forEach((ws, idx) => {
    const sheetId = `sheet-${idx + 1}`;
    sheetOrder.push(sheetId);

    const cellData: Record<number, Record<number, UniverCellData>> = {};
    const rowData: Record<number, { h?: number; hd?: 0 | 1 }> = {};
    const columnData: Record<number, { w?: number; hd?: 0 | 1 }> = {};
    const mergeData: UniverMergeRange[] = [];

    const maxRows = Math.min(ws.rowCount, MAX_UNIVER_ROWS);
    const maxCols = Math.min(Math.max(ws.columnCount, 1), MAX_UNIVER_COLS);

    // Column widths
    for (let c = 1; c <= maxCols; c += 1) {
      const col = ws.getColumn(c);
      const entry: { w?: number; hd?: 0 | 1 } = {};
      if (typeof col.width === 'number' && col.width > 0) {
        entry.w = Math.max(24, Math.round(col.width * 7.5 + 8));
      }
      if (col.hidden) entry.hd = 1;
      if (entry.w !== undefined || entry.hd !== undefined) {
        columnData[c - 1] = entry;
      }
    }

    // Cells & row heights
    for (let r = 1; r <= maxRows; r += 1) {
      const row = ws.getRow(r);
      const rEntry: { h?: number; hd?: 0 | 1 } = {};
      if (typeof row.height === 'number' && row.height > 0) {
        rEntry.h = Math.max(16, Math.round(row.height * 1.333));
      }
      if (row.hidden) rEntry.hd = 1;
      if (rEntry.h !== undefined || rEntry.hd !== undefined) {
        rowData[r - 1] = rEntry;
      }

      let rowCells: Record<number, UniverCellData> | null = null;
      for (let c = 1; c <= maxCols; c += 1) {
        const cell = row.getCell(c);
        const isMergedSlave = cell.isMerged && cell.master && cell.master.address !== cell.address;
        const val = isMergedSlave ? null : extractCellValue(cell);
        const style = extractExcelCellStyle(cell);
        if (!val && !style) continue;
        const cellObj: UniverCellData = { ...(val ?? {}) };
        if (style) cellObj.s = registerStyle(style);
        if (!rowCells) rowCells = {};
        rowCells[c - 1] = cellObj;
      }
      if (rowCells) cellData[r - 1] = rowCells;
    }

    // Merged ranges
    const rawMerges = (ws.model as { merges?: string[] } | undefined)?.merges ?? [];
    for (const range of rawMerges) {
      const [startStr, endStr] = range.split(':');
      if (!startStr || !endStr) continue;
      const start = parseA1Ref(startStr);
      const end = parseA1Ref(endStr);
      if (!start || !end) continue;
      if (start.row >= MAX_UNIVER_ROWS || start.col >= MAX_UNIVER_COLS) continue;
      mergeData.push({
        startRow: start.row,
        endRow: Math.min(end.row, MAX_UNIVER_ROWS - 1),
        startColumn: start.col,
        endColumn: Math.min(end.col, MAX_UNIVER_COLS - 1),
      });
    }

    // Freeze pane
    let freeze: UniverWorksheetData['freeze'];
    const firstView = ws.views?.[0];
    if (firstView && firstView.state === 'frozen') {
      const xSplit = firstView.xSplit ?? 0;
      const ySplit = firstView.ySplit ?? 0;
      if (xSplit > 0 || ySplit > 0) {
        freeze = { xSplit, ySplit, startRow: ySplit, startColumn: xSplit };
      }
    }

    sheets[sheetId] = {
      id: sheetId,
      name: ws.name,
      hidden: ws.state === 'hidden' || ws.state === 'veryHidden' ? 1 : 0,
      rowCount: Math.max(100, maxRows + 30),
      columnCount: Math.max(26, maxCols + 10),
      defaultColumnWidth: 88,
      defaultRowHeight: 24,
      ...(freeze ? { freeze } : {}),
      mergeData,
      cellData,
      rowData,
      columnData,
    };
  });

  if (sheetOrder.length === 0) {
    sheetOrder.push('sheet-1');
    sheets['sheet-1'] = {
      id: 'sheet-1',
      name: 'Sheet1',
      rowCount: 100,
      columnCount: 26,
      defaultColumnWidth: 88,
      defaultRowHeight: 24,
      mergeData: [],
      cellData: {},
      rowData: {},
      columnData: {},
    };
  }

  return {
    id: 'matrius-workbook',
    name: workbookName,
    appVersion: '3.0.0-alpha',
    locale: 'zhCN',
    styles,
    sheetOrder,
    sheets,
  };
}

function resolveUniverStyle(
  styleRef: string | UniverStyleData | undefined,
  styles: Record<string, UniverStyleData>,
): UniverStyleData | null {
  if (!styleRef) return null;
  if (typeof styleRef === 'string') return styles[styleRef] ?? null;
  return styleRef;
}

function applyUniverStyleToExcelCell(cell: ExcelJS.Cell, style: UniverStyleData): void {
  const font: Partial<ExcelJS.Font> = {};
  if (style.ff) font.name = style.ff;
  if (typeof style.fs === 'number' && style.fs > 0) font.size = style.fs;
  if (style.bl === 1) font.bold = true;
  if (style.it === 1) font.italic = true;
  if (style.ul?.s === 1) font.underline = true;
  if (style.st?.s === 1) font.strike = true;
  const fontArgb = rgbHexToArgb(style.cl?.rgb);
  if (fontArgb) font.color = { argb: fontArgb };
  if (Object.keys(font).length > 0) cell.font = font;

  const bgArgb = rgbHexToArgb(style.bg?.rgb);
  if (bgArgb) {
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: bgArgb },
    };
  }

  const alignment: Partial<ExcelJS.Alignment> = {};
  if (style.ht === 1) alignment.horizontal = 'left';
  else if (style.ht === 2) alignment.horizontal = 'center';
  else if (style.ht === 3) alignment.horizontal = 'right';
  if (style.vt === 1) alignment.vertical = 'top';
  else if (style.vt === 2) alignment.vertical = 'middle';
  else if (style.vt === 3) alignment.vertical = 'bottom';
  if (style.tb === 3) alignment.wrapText = true;
  if (Object.keys(alignment).length > 0) cell.alignment = alignment;

  if (style.bd) {
    const border: Partial<ExcelJS.Borders> = {};
    const sides = [
      ['t', 'top'],
      ['b', 'bottom'],
      ['l', 'left'],
      ['r', 'right'],
    ] as const;
    for (const [uSide, eSide] of sides) {
      const edge = style.bd[uSide];
      if (!edge) continue;
      const argb = rgbHexToArgb(edge.cl?.rgb) ?? 'FFD0D7DE';
      border[eSide] = {
        style: univerBorderStyleToExcel(edge.s),
        color: { argb },
      };
    }
    if (Object.keys(border).length > 0) cell.border = border;
  }
}

export async function univerWorkbookToExcelBuffer(snapshot: Record<string, unknown>): Promise<Buffer> {
  const { default: ExcelJS } = await import('exceljs');
  const wb = new ExcelJS.Workbook();

  const styles = (snapshot.styles && typeof snapshot.styles === 'object'
    ? snapshot.styles
    : {}) as Record<string, UniverStyleData>;
  const rawSheets = (snapshot.sheets && typeof snapshot.sheets === 'object'
    ? snapshot.sheets
    : {}) as Record<string, Partial<UniverWorksheetData>>;
  const sheetOrder = Array.isArray(snapshot.sheetOrder)
    ? snapshot.sheetOrder.filter((id): id is string => typeof id === 'string' && id in rawSheets)
    : Object.keys(rawSheets);

  for (const sheetId of sheetOrder) {
    const sheetData = rawSheets[sheetId];
    if (!sheetData) continue;
    const sheetName = (typeof sheetData.name === 'string' && sheetData.name.trim()
      ? sheetData.name.trim()
      : sheetId).slice(0, 31);
    const ws = wb.addWorksheet(sheetName, {
      state: sheetData.hidden === 1 ? 'hidden' : 'visible',
    });

    if (sheetData.freeze && ((sheetData.freeze.xSplit ?? 0) > 0 || (sheetData.freeze.ySplit ?? 0) > 0)) {
      ws.views = [{
        state: 'frozen',
        xSplit: sheetData.freeze.xSplit ?? 0,
        ySplit: sheetData.freeze.ySplit ?? 0,
      }];
    }

    if (sheetData.columnData && typeof sheetData.columnData === 'object') {
      for (const [colKey, colMeta] of Object.entries(sheetData.columnData)) {
        const colIdx = Number(colKey);
        if (!Number.isInteger(colIdx) || colIdx < 0 || !colMeta) continue;
        const col = ws.getColumn(colIdx + 1);
        if (typeof colMeta.w === 'number' && colMeta.w > 0) {
          col.width = Math.max(4, Number(((colMeta.w - 8) / 7.5).toFixed(2)));
        }
        if (colMeta.hd === 1) col.hidden = true;
      }
    }

    if (sheetData.rowData && typeof sheetData.rowData === 'object') {
      for (const [rowKey, rowMeta] of Object.entries(sheetData.rowData)) {
        const rowIdx = Number(rowKey);
        if (!Number.isInteger(rowIdx) || rowIdx < 0 || !rowMeta) continue;
        const row = ws.getRow(rowIdx + 1);
        if (typeof rowMeta.h === 'number' && rowMeta.h > 0) {
          row.height = Math.max(12, Number((rowMeta.h / 1.333).toFixed(2)));
        }
        if (rowMeta.hd === 1) row.hidden = true;
      }
    }

    if (sheetData.cellData && typeof sheetData.cellData === 'object') {
      for (const [rowKey, rowObj] of Object.entries(sheetData.cellData)) {
        const rowIdx = Number(rowKey);
        if (!Number.isInteger(rowIdx) || rowIdx < 0 || !rowObj || typeof rowObj !== 'object') continue;
        const row = ws.getRow(rowIdx + 1);
        for (const [colKey, cellObj] of Object.entries(rowObj)) {
          const colIdx = Number(colKey);
          if (!Number.isInteger(colIdx) || colIdx < 0 || !cellObj || typeof cellObj !== 'object') continue;
          const cell = row.getCell(colIdx + 1);
          if (typeof cellObj.f === 'string' && cellObj.f.trim()) {
            const formula = cellObj.f.startsWith('=') ? cellObj.f.slice(1) : cellObj.f;
            cell.value = {
              formula,
              ...(cellObj.v !== undefined ? { result: cellObj.v } : {}),
            };
          } else if (cellObj.v !== undefined && cellObj.v !== null) {
            if (cellObj.t === 3) {
              cell.value = Boolean(cellObj.v);
            } else {
              cell.value = cellObj.v;
            }
          }
          const resolvedStyle = resolveUniverStyle(cellObj.s, styles);
          if (resolvedStyle) applyUniverStyleToExcelCell(cell, resolvedStyle);
        }
      }
    }

    if (Array.isArray(sheetData.mergeData)) {
      for (const merge of sheetData.mergeData) {
        if (
          typeof merge?.startRow === 'number'
          && typeof merge?.endRow === 'number'
          && typeof merge?.startColumn === 'number'
          && typeof merge?.endColumn === 'number'
        ) {
          try {
            ws.mergeCells(merge.startRow + 1, merge.startColumn + 1, merge.endRow + 1, merge.endColumn + 1);
          } catch {
            // Skip overlapping/invalid merge ranges
          }
        }
      }
    }
  }

  if (wb.worksheets.length === 0) {
    wb.addWorksheet('Sheet1');
  }

  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out);
}
