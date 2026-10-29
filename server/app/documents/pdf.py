"""PDF inspection and editing.

Page operations use pypdf; text is rendered onto transparent overlays with
reportlab and merged into the target page. Coordinates are points with the
origin at the top-left corner of the page, matching how editors present them.
"""

import io
import json
import threading
from typing import Any

from pypdf import PdfReader, PdfWriter
from pypdf._page import PageObject
from pypdf.generic import BooleanObject, NameObject
from reportlab.lib.colors import HexColor
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas

from app.config import get_settings
from app.documents.binaries import font_path
from app.errors import AppError

MAX_PDF_PAGES = 2000
A4_WIDTH = 595.28
A4_HEIGHT = 841.89
FONT_NAME = "MatriusNotoSC"
_LINE_HEIGHT = 1.4
_font_lock = threading.Lock()
_font_ready = False


def _ensure_font() -> None:
    global _font_ready
    if _font_ready:
        return
    with _font_lock:
        if _font_ready:
            return
        try:
            pdfmetrics.registerFont(TTFont(FONT_NAME, str(font_path())))
        except Exception as exc:  # noqa: BLE001
            raise AppError(503, "document_engine_error", "无法加载中文字体。") from exc
        _font_ready = True


def _reader(data: bytes) -> PdfReader:
    try:
        reader = PdfReader(io.BytesIO(data))
    except Exception as exc:  # noqa: BLE001
        raise AppError(422, "parse_failed", "无法解析 PDF 文件。") from exc
    if reader.is_encrypted:
        raise AppError(422, "parse_failed", "暂不支持加密 PDF。")
    if len(reader.pages) > MAX_PDF_PAGES:
        raise AppError(422, "document_too_large", "PDF 页数超过 2000 页。")
    return reader


def inspect_pdf(data: bytes) -> str:
    reader = _reader(data)
    pages: list[dict[str, Any]] = []
    for index, page in enumerate(reader.pages):
        box = page.mediabox
        text = ""
        try:
            text = (page.extract_text() or "").strip().replace("\x00", "")
        except Exception:  # noqa: BLE001 - extraction is best effort
            text = ""
        pages.append(
            {
                "page": index + 1,
                "width": round(float(box.width), 2),
                "height": round(float(box.height), 2),
                "rotation": int(page.get("/Rotate", 0) or 0),
                "text": text[:2000],
            }
        )
    fields: list[dict[str, str]] = []
    try:
        for name, field in (reader.get_fields() or {}).items():
            fields.append({"name": name, "type": str(field.get("/FT", ""))})
    except Exception:  # noqa: BLE001
        pass
    return json.dumps({"pageCount": len(reader.pages), "pages": pages, "fields": fields}, ensure_ascii=False, indent=2)


def _wrap(text: str, size: float, max_width: float) -> list[str]:
    lines: list[str] = []
    for paragraph in text.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        if not paragraph:
            lines.append("")
            continue
        current = ""
        for char in paragraph:
            candidate = current + char
            if current and pdfmetrics.stringWidth(candidate, FONT_NAME, size) > max_width:
                lines.append(current)
                current = char
            else:
                current = candidate
        lines.append(current)
    return lines


def _overlay(
    width: float,
    height: float,
    text: str,
    x: float,
    y: float,
    size: float,
    color: str,
) -> Any:
    _ensure_font()
    if not text:
        return None
    max_width = width - x
    if max_width <= 0:
        raise AppError(422, "invalid_document_operation", "文本坐标超出页面范围。")
    lines = _wrap(text, size, max_width)
    current_y = height - y - size
    if current_y < 0:
        raise AppError(422, "invalid_document_operation", "文本坐标超出页面范围。")
    total_height = len(lines) * size * _LINE_HEIGHT
    if current_y - total_height < -size:
        raise AppError(422, "invalid_document_operation", "文本超出页面高度，请缩小字号或分段绘制。")

    buffer = io.BytesIO()
    pdf = canvas.Canvas(buffer, pagesize=(width, height))
    pdf.setFont(FONT_NAME, size)
    pdf.setFillColor(HexColor(color))
    for line in lines:
        pdf.drawString(x, current_y, line)
        current_y -= size * _LINE_HEIGHT
    pdf.save()
    return PdfReader(io.BytesIO(buffer.getvalue())).pages[0]


def _merge_text(page: Any, text: str, x: float, y: float, size: float, color: str) -> None:
    overlay = _overlay(float(page.mediabox.width), float(page.mediabox.height), text, x, y, size, color)
    if overlay is not None:
        page.merge_page(overlay)


def apply_pdf_changes(data: bytes | None, changes: list[Any]) -> bytes:
    _ensure_font()
    if data is None:
        writer = PdfWriter()
        writer.add_blank_page(width=A4_WIDTH, height=A4_HEIGHT)
    else:
        writer = PdfWriter(clone_from=_reader(data))

    field_values: dict[str, str] = {}
    for change in changes:
        operation = change.operation
        page_count = len(writer.pages)
        if operation == "draw_text":
            _require_page(change.page, page_count)
            _merge_text(writer.pages[change.page - 1], change.text, change.x, change.y, change.size, change.color)
        elif operation == "replace_page":
            _require_page(change.page, page_count)
            old = writer.pages[change.page - 1]
            width, height = float(old.mediabox.width), float(old.mediabox.height)
            writer.remove_page(change.page - 1)
            blank = PageObject.create_blank_page(width=width, height=height)
            writer.insert_page(blank, change.page - 1)
            _merge_text(writer.pages[change.page - 1], change.text, change.x, change.y, change.size, change.color)
        elif operation == "add_page":
            index = page_count if change.page is None else min(change.page - 1, page_count)
            if change.width and change.height:
                width, height = change.width, change.height
            elif page_count:
                source = writer.pages[max(0, min(index, page_count - 1))]
                width, height = float(source.mediabox.width), float(source.mediabox.height)
            else:
                width, height = A4_WIDTH, A4_HEIGHT
            blank = PageObject.create_blank_page(width=width, height=height)
            writer.insert_page(blank, index)
            _merge_text(writer.pages[index], change.text, change.x, change.y, change.size, change.color)
        elif operation == "remove_page":
            _require_page(change.page, page_count)
            if page_count <= 1:
                raise AppError(422, "invalid_document_operation", "不能删除 PDF 的唯一一页。")
            writer.remove_page(change.page - 1)
        elif operation == "rotate_page":
            _require_page(change.page, page_count)
            page = writer.pages[change.page - 1]
            page.rotate(change.degrees - int(page.get("/Rotate", 0) or 0))
        elif operation == "set_field":
            field_values[change.name] = change.text

    if field_values:
        try:
            for page in writer.pages:
                writer.update_page_form_field_values(page, field_values, auto_regenerate=False)
            writer.set_need_appearances_writer(True)
        except Exception as exc:  # noqa: BLE001
            raise AppError(422, "invalid_document_operation", "PDF 表单字段写入失败。") from exc
        root = writer._root_object
        acroform = root.get("/AcroForm")
        if acroform is not None:
            acroform[NameObject("/NeedAppearances")] = BooleanObject(True)

    output = io.BytesIO()
    writer.write(output)
    result = output.getvalue()
    if len(result) > get_settings().max_upload_bytes:
        raise AppError(413, "document_too_large", "生成的 PDF 超过 20 MiB。")
    return result


def _require_page(page: int, page_count: int) -> None:
    if page < 1 or page > page_count:
        raise AppError(422, "invalid_document_operation", f"页面 {page} 不存在（共 {page_count} 页）。")
