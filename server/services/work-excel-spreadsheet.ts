import type ExcelJS from 'exceljs';

export type XSpreadsheetBorderEdge = [string, string];

export type XSpreadsheetStyle = {
  bgcolor?: string;
  align?: 'left' | 'center' | 'right';
  valign?: 'top' | 'middle' | 'bottom';
  textwrap?: boolean;
  strike?: boolean;
  underline?: boolean;
  color?: string;
  font?: {
    name?: string;
    size?: number;
    bold?: boolean;
    italic?: boolean;
  };
  border?: {
    top?: XSpreadsheetBorderEdge;
    bottom?: XSpreadsheetBorderEdge;
    left?: XSpreadsheetBorderEdge;
    right?: XSpreadsheetBorderEdge;
  };
};

export type XSpreadsheetCell = {
  text?: string;
  style?: number;
  merge?: [number, number];
};

export type XSpreadsheetRow = {
  height?: number;
  cells: Record<string, XSpreadsheetCell>;
};

export type XSpreadsheetSheet = {
  name: string;
  freeze?: string;
  styles: XSpreadsheetStyle[];
  merges: string[];
  rows: Record<string, XSpreadsheetRow | number>;
  cols: Record<string, { width?: number } | number>;
};

const MAX_SHEETS = 30;
const MAX_ROWS = 1500;
const MAX_COLS = 80;

function colIndexToLetters(colIndex: number): string {
  let n = colIndex;
  let out = '';
  while (n >= 0) {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  }
  return out;
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

function argbToHex(argb?: string): string | undefined {
  if (!argb || typeof argb !== 'string') return undefined;
  const clean = argb.replace(/^#/u, '').trim();
  if (clean.length === 8 && /^[0-9a-f]{8}$/iu.test(clean)) return `#${clean.slice(2).toUpperCase()}`;
  if (clean.length === 6 && /^[0-9a-f]{6}$/iu.test(clean)) return `#${clean.toUpperCase()}`;
  return undefined;
}

function hexToArgb(hex?: string): string | undefined {
  if (!hex || typeof hex !== 'string') return undefined;
  const clean = hex.replace(/^#/u, '').trim();
  if (clean.length === 6 && /^[0-9a-f]{6}$/iu.test(clean)) return `FF${clean.toUpperCase()}`;
  if (clean.length === 8 && /^[0-9a-f]{8}$/iu.test(clean)) return clean.toUpperCase();
  return undefined;
}

function excelBorderType(style?: ExcelJS.BorderStyle): string {
  switch (style) {
    case 'medium':
    case 'thick':
    case 'dashed':
    case 'dotted':
    case 'double':
      return style;
    default:
      return 'thin';
  }
}

function xBorderTypeToExcel(type?: string): ExcelJS.BorderStyle {
  switch (type) {
    case 'medium':
    case 'thick':
    case 'dashed':
    case 'dotted':
    case 'double':
      return type;
    default:
      return 'thin';
  }
}

function extractCellStyle(cell: ExcelJS.Cell): XSpreadsheetStyle | null {
  const style: XSpreadsheetStyle = {};
  let hasAny = false;

  if (cell.font) {
    const font: NonNullable<XSpreadsheetStyle['font']> = {};
    if (cell.font.name) font.name = cell.font.name;
    if (typeof cell.font.size === 'number' && cell.font.size > 0) font.size = cell.font.size;
    if (cell.font.bold) font.bold = true;
    if (cell.font.italic) font.italic = true;
    if (Object.keys(font).length > 0) {
      style.font = font;
      hasAny = true;
    }
    if (cell.font.underline) { style.underline = true; hasAny = true; }
    if (cell.font.strike) { style.strike = true; hasAny = true; }
    const color = argbToHex(cell.font.color?.argb);
    if (color) { style.color = color; hasAny = true; }
  }

  if (cell.fill && cell.fill.type === 'pattern' && cell.fill.pattern === 'solid') {
    const bgcolor = argbToHex(cell.fill.fgColor?.argb);
    if (bgcolor) { style.bgcolor = bgcolor; hasAny = true; }
  }

  if (cell.alignment) {
    if (cell.alignment.horizontal === 'left' || cell.alignment.horizontal === 'center' || cell.alignment.horizontal === 'right') {
      style.align = cell.alignment.horizontal;
      hasAny = true;
    }
    if (cell.alignment.vertical === 'top' || cell.alignment.vertical === 'middle' || cell.alignment.vertical === 'bottom') {
      style.valign = cell.alignment.vertical;
      hasAny = true;
    }
    if (cell.alignment.wrapText) { style.textwrap = true; hasAny = true; }
  }

  if (cell.border) {
    const border: NonNullable<XSpreadsheetStyle['border']> = {};
    for (const side of ['top', 'bottom', 'left', 'right'] as const) {
      const edge = cell.border[side];
      if (edge?.style) {
        border[side] = [excelBorderType(edge.style), argbToHex(edge.color?.argb) ?? '#D0D7DE'];
      }
    }
    if (Object.keys(border).length > 0) {
      style.border = border;
      hasAny = true;
    }
  }

  return hasAny ? style : null;
}

function extractCellText(cell: ExcelJS.Cell): string {
  const value = cell.value;
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? '' : value.toISOString().slice(0, 10);
  if (typeof value === 'object') {
    if ('formula' in value && typeof value.formula === 'string') {
      return value.formula.startsWith('=') ? value.formula : `=${value.formula}`;
    }
    if ('sharedFormula' in value) {
      const result = 'result' in value ? value.result : undefined;
      return result !== undefined && result !== null ? String(result) : '';
    }
    if ('error' in value && typeof value.error === 'string') return value.error;
    if ('richText' in value && Array.isArray(value.richText)) {
      return value.richText.map((part) => part.text ?? '').join('');
    }
    if ('text' in value && typeof value.text === 'string') return value.text;
    if ('result' in value && value.result !== undefined && value.result !== null) {
      return String(value.result);
    }
  }
  return '';
}

export function excelWorkbookToXSpreadsheet(wb: ExcelJS.Workbook): XSpreadsheetSheet[] {
  const sheets: XSpreadsheetSheet[] = [];

  for (const ws of wb.worksheets.slice(0, MAX_SHEETS)) {
    const styles: XSpreadsheetStyle[] = [];
    const styleIndexMap = new Map<string, number>();

    function registerStyle(style: XSpreadsheetStyle): number {
      const key = JSON.stringify(style);
      const existing = styleIndexMap.get(key);
      if (existing !== undefined) return existing;
      const idx = styles.length;
      styles.push(style);
      styleIndexMap.set(key, idx);
      return idx;
    }

    const maxRows = Math.min(ws.rowCount, MAX_ROWS);
    const maxCols = Math.min(Math.max(ws.columnCount, 1), MAX_COLS);
    const rows: Record<string, XSpreadsheetRow | number> = { len: Math.max(100, maxRows + 30) };
    const cols: Record<string, { width?: number } | number> = { len: Math.max(26, maxCols + 8) };
    const merges: string[] = [];

    for (let c = 1; c <= maxCols; c += 1) {
      const col = ws.getColumn(c);
      if (typeof col.width === 'number' && col.width > 0) {
        cols[String(c - 1)] = { width: Math.max(40, Math.round(col.width * 7.5 + 10)) };
      }
    }

    const mergeMap = new Map<string, [number, number]>();
    const rawMerges = (ws.model as { merges?: string[] } | undefined)?.merges ?? [];
    for (const range of rawMerges) {
      const [startStr, endStr] = range.split(':');
      if (!startStr || !endStr) continue;
      const start = parseA1Ref(startStr);
      const end = parseA1Ref(endStr);
      if (!start || !end) continue;
      if (start.row >= MAX_ROWS || start.col >= MAX_COLS) continue;
      const clampedEndRow = Math.min(end.row, MAX_ROWS - 1);
      const clampedEndCol = Math.min(end.col, MAX_COLS - 1);
      merges.push(`${colIndexToLetters(start.col)}${start.row + 1}:${colIndexToLetters(clampedEndCol)}${clampedEndRow + 1}`);
      mergeMap.set(`${start.row}:${start.col}`, [clampedEndRow - start.row, clampedEndCol - start.col]);
    }

    for (let r = 1; r <= maxRows; r += 1) {
      const row = ws.getRow(r);
      const cells: Record<string, XSpreadsheetCell> = {};
      let hasCells = false;

      for (let c = 1; c <= maxCols; c += 1) {
        const cell = row.getCell(c);
        const isMergedSlave = cell.isMerged && cell.master && cell.master.address !== cell.address;
        const text = isMergedSlave ? '' : extractCellText(cell);
        const style = extractCellStyle(cell);
        const merge = mergeMap.get(`${r - 1}:${c - 1}`);
        if (!text && !style && !merge) continue;

        const outCell: XSpreadsheetCell = {};
        if (text) outCell.text = text;
        if (style) outCell.style = registerStyle(style);
        if (merge) outCell.merge = merge;
        cells[String(c - 1)] = outCell;
        hasCells = true;
      }

      const rowHeight = typeof row.height === 'number' && row.height > 0
        ? Math.max(20, Math.round(row.height * 1.333))
        : undefined;
      if (hasCells || rowHeight !== undefined) {
        rows[String(r - 1)] = {
          ...(rowHeight !== undefined ? { height: rowHeight } : {}),
          cells,
        };
      }
    }

    let freeze = 'A1';
    const firstView = ws.views?.[0];
    if (firstView && firstView.state === 'frozen') {
      const xSplit = firstView.xSplit ?? 0;
      const ySplit = firstView.ySplit ?? 0;
      if (xSplit > 0 || ySplit > 0) {
        freeze = `${colIndexToLetters(xSplit)}${ySplit + 1}`;
      }
    }

    sheets.push({
      name: ws.name,
      freeze,
      styles,
      merges,
      rows,
      cols,
    });
  }

  if (sheets.length === 0) {
    sheets.push({
      name: 'Sheet1',
      freeze: 'A1',
      styles: [],
      merges: [],
      rows: { len: 100 },
      cols: { len: 26 },
    });
  }

  return sheets;
}

export async function excelBufferToXSpreadsheet(data: Uint8Array): Promise<XSpreadsheetSheet[]> {
  const { default: ExcelJS } = await import('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(data) as unknown as ExcelJS.Buffer);
  return excelWorkbookToXSpreadsheet(wb);
}

function applyXStyleToExcelCell(cell: ExcelJS.Cell, style: XSpreadsheetStyle): void {
  const font: Partial<ExcelJS.Font> = {};
  if (style.font?.name) font.name = style.font.name;
  if (typeof style.font?.size === 'number' && style.font.size > 0) font.size = style.font.size;
  if (style.font?.bold) font.bold = true;
  if (style.font?.italic) font.italic = true;
  if (style.underline) font.underline = true;
  if (style.strike) font.strike = true;
  const colorArgb = hexToArgb(style.color);
  if (colorArgb) font.color = { argb: colorArgb };
  if (Object.keys(font).length > 0) cell.font = font;

  const bgArgb = hexToArgb(style.bgcolor);
  if (bgArgb) {
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: bgArgb },
    };
  }

  const alignment: Partial<ExcelJS.Alignment> = {};
  if (style.align) alignment.horizontal = style.align;
  if (style.valign) alignment.vertical = style.valign;
  if (style.textwrap) alignment.wrapText = true;
  if (Object.keys(alignment).length > 0) cell.alignment = alignment;

  if (style.border) {
    const border: Partial<ExcelJS.Borders> = {};
    for (const side of ['top', 'bottom', 'left', 'right'] as const) {
      const edge = style.border[side];
      if (!Array.isArray(edge) || edge.length < 2) continue;
      border[side] = {
        style: xBorderTypeToExcel(edge[0]),
        color: { argb: hexToArgb(edge[1]) ?? 'FFD0D7DE' },
      };
    }
    if (Object.keys(border).length > 0) cell.border = border;
  }
}

export async function xSpreadsheetToExcelBuffer(sheetsInput: unknown[]): Promise<Buffer> {
  const { default: ExcelJS } = await import('exceljs');
  const wb = new ExcelJS.Workbook();

  for (let index = 0; index < sheetsInput.length; index += 1) {
    const raw = sheetsInput[index] as Partial<XSpreadsheetSheet> | null;
    if (!raw || typeof raw !== 'object') continue;
    const sheetName = (typeof raw.name === 'string' && raw.name.trim()
      ? raw.name.trim()
      : `Sheet${index + 1}`).slice(0, 31);
    const ws = wb.addWorksheet(sheetName);
    const styles = Array.isArray(raw.styles) ? raw.styles : [];

    if (typeof raw.freeze === 'string' && raw.freeze !== 'A1') {
      const parsed = parseA1Ref(raw.freeze);
      if (parsed && (parsed.row > 0 || parsed.col > 0)) {
        ws.views = [{ state: 'frozen', xSplit: parsed.col, ySplit: parsed.row }];
      }
    }

    if (raw.cols && typeof raw.cols === 'object') {
      for (const [colKey, colMeta] of Object.entries(raw.cols)) {
        if (colKey === 'len' || !colMeta || typeof colMeta !== 'object') continue;
        const colIdx = Number(colKey);
        if (!Number.isInteger(colIdx) || colIdx < 0) continue;
        if (typeof colMeta.width === 'number' && colMeta.width > 0) {
          ws.getColumn(colIdx + 1).width = Math.max(4, Number(((colMeta.width - 10) / 7.5).toFixed(2)));
        }
      }
    }

    if (raw.rows && typeof raw.rows === 'object') {
      for (const [rowKey, rowMeta] of Object.entries(raw.rows)) {
        if (rowKey === 'len' || !rowMeta || typeof rowMeta !== 'object') continue;
        const rowIdx = Number(rowKey);
        if (!Number.isInteger(rowIdx) || rowIdx < 0) continue;
        const row = ws.getRow(rowIdx + 1);
        if (typeof rowMeta.height === 'number' && rowMeta.height > 0) {
          row.height = Math.max(12, Number((rowMeta.height / 1.333).toFixed(2)));
        }
        const cells = rowMeta.cells;
        if (cells && typeof cells === 'object') {
          for (const [colKey, cellData] of Object.entries(cells)) {
            const colIdx = Number(colKey);
            if (!Number.isInteger(colIdx) || colIdx < 0 || !cellData || typeof cellData !== 'object') continue;
            const cell = row.getCell(colIdx + 1);
            if (typeof cellData.text === 'string' && cellData.text.length > 0) {
              const rawText = cellData.text;
              if (rawText.startsWith('=') && rawText.length > 1) {
                cell.value = { formula: rawText.slice(1) };
              } else if (/^-?\d+(?:\.\d+)?$/u.test(rawText.trim()) && rawText.trim().length <= 15) {
                cell.value = Number(rawText.trim());
              } else if (rawText === 'TRUE' || rawText === 'FALSE') {
                cell.value = rawText === 'TRUE';
              } else {
                cell.value = rawText;
              }
            }
            if (typeof cellData.style === 'number' && styles[cellData.style]) {
              applyXStyleToExcelCell(cell, styles[cellData.style]);
            }
          }
        }
      }
    }

    if (Array.isArray(raw.merges)) {
      for (const range of raw.merges) {
        if (typeof range !== 'string' || !range.includes(':')) continue;
        try {
          ws.mergeCells(range);
        } catch {
          // Ignore invalid/overlapping merge ranges
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
