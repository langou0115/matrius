"""Text extraction for stored files. Everything unknown is treated as plain text."""

import io
from pathlib import PurePath

from charset_normalizer import from_bytes
from docx import Document
from openpyxl import load_workbook
from pptx import Presentation
from pypdf import PdfReader

MAX_EXTRACTED_CHARS = 2_000_000

TEXT_EXTENSIONS = {
    "txt", "md", "markdown", "csv", "tsv", "json", "jsonl", "log", "yaml", "yml", "toml",
    "ini", "cfg", "conf", "env", "xml", "html", "htm", "css", "scss", "less", "js", "jsx",
    "mjs", "cjs", "ts", "tsx", "py", "rb", "go", "rs", "java", "kt", "swift", "c", "h",
    "cpp", "hpp", "cs", "php", "sh", "bash", "zsh", "sql", "graphql", "gql", "vue", "svelte",
}


class ParseError(Exception):
    pass


class UnsupportedFile(ParseError):
    pass


def _decode_text(data: bytes) -> str:
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        match = from_bytes(data).best()
        if match is None:
            return data.decode("utf-8", errors="replace")
        return str(match)


def _extract_pdf(data: bytes) -> str:
    reader = PdfReader(io.BytesIO(data))
    parts: list[str] = []
    for page in reader.pages:
        parts.append(page.extract_text() or "")
    return "\n\n".join(parts)


def _extract_docx(data: bytes) -> str:
    document = Document(io.BytesIO(data))
    parts = [paragraph.text for paragraph in document.paragraphs]
    for table in document.tables:
        for row in table.rows:
            parts.append("\t".join(cell.text for cell in row.cells))
    return "\n".join(parts)


def _extract_xlsx(data: bytes) -> str:
    workbook = load_workbook(io.BytesIO(data), read_only=True, data_only=True)
    parts: list[str] = []
    try:
        for sheet in workbook.worksheets:
            parts.append(f"# {sheet.title}")
            for row in sheet.iter_rows(values_only=True):
                parts.append("\t".join("" if value is None else str(value) for value in row))
    finally:
        workbook.close()
    return "\n".join(parts)


def _extract_pptx(data: bytes) -> str:
    presentation = Presentation(io.BytesIO(data))
    parts: list[str] = []
    for index, slide in enumerate(presentation.slides, start=1):
        parts.append(f"# Slide {index}")
        for shape in slide.shapes:
            if getattr(shape, "has_text_frame", False):
                parts.append(shape.text_frame.text)
            if getattr(shape, "has_table", False):
                for row in shape.table.rows:
                    parts.append("\t".join(cell.text for cell in row.cells))
    return "\n".join(parts)


def extract_text(filename: str, data: bytes) -> str:
    suffix = PurePath(filename).suffix.lower().lstrip(".")
    try:
        if suffix == "pdf":
            text = _extract_pdf(data)
        elif suffix == "docx":
            text = _extract_docx(data)
        elif suffix == "xlsx":
            text = _extract_xlsx(data)
        elif suffix == "pptx":
            text = _extract_pptx(data)
        else:
            text = _decode_text(data)
    except ParseError:
        raise
    except Exception as exc:  # noqa: BLE001 - parser failures become a stable API error
        raise ParseError(str(exc)) from exc

    return text[:MAX_EXTRACTED_CHARS]
