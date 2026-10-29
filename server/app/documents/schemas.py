"""Validated document operations.

Everything the model can ask for is expressed as structured data: no raw XML,
no extra CLI flags, no filesystem paths. The schemas mirror openstudio's
``document-schema.ts`` so the two implementations accept the same documents.
"""

import uuid
from typing import Annotated, Literal

from pydantic import AfterValidator, BaseModel, Field, model_validator

OfficeFormat = Literal["docx", "xlsx", "pptx", "pdf"]
OFFICE_FORMATS = {"docx", "xlsx", "pptx"}

# Attributes the model may add or change. Anything else is rejected instead of
# being forwarded to OfficeCLI.
OFFICE_PROPERTIES = frozenset(
    """
    text value formula name title background color fill font size fontsize bold italic
    underline strike highlight align alignment valign style styleid liststyle numlevel
    spacebefore spaceafter linespacing linerule indent firstline width height left top x y
    rotation opacity border bordercolor borderwidth cols rows numberformat format wraptext
    merge hidden layout notes margin padding halign wrap alignment.horizontal
    alignment.vertical alignment.wraptext alignment.indent alignment.shrinktofit
    alignment.textrotation alignment.readingorder font.name font.size font.color font.bold
    font.italic autofit shape geometry strokecolor strokewidth stroke
    """.split()
)

MAX_COMMANDS = 100
MAX_TEXT = 50_000


def _validate_path(value: str) -> str:
    if not value.startswith("/"):
        raise ValueError("文档路径必须以 / 开头。")
    if ".." in value or "\x00" in value or "\n" in value or "\r" in value:
        raise ValueError("文档路径包含非法字符。")
    if len(value) > 500:
        raise ValueError("文档路径过长。")
    return value


def _validate_filename(value: str) -> str:
    if any(char in value for char in ("/", "\\", "\x00", "\n", "\r")):
        raise ValueError("文件名不能包含路径分隔符。")
    stripped = value.strip()
    if not stripped:
        raise ValueError("文件名不能为空。")
    return stripped


OfficePath = Annotated[str, AfterValidator(_validate_path)]
OfficeFileName = Annotated[str, AfterValidator(_validate_filename)]
OfficePropValue = str | int | float | bool


def _validate_props(props: dict[str, OfficePropValue]) -> dict[str, OfficePropValue]:
    for key, value in props.items():
        if key not in OFFICE_PROPERTIES:
            raise ValueError(f"不支持的文档属性：{key}")
        if isinstance(value, str) and len(value) > MAX_TEXT:
            raise ValueError(f"属性 {key} 的文本过长。")
    return props


class OfficeAddCommand(BaseModel):
    command: Literal["add"]
    parent: OfficePath
    type: Literal["paragraph", "run", "table", "row", "cell", "sheet", "slide", "shape"]
    props: dict[str, OfficePropValue] = Field(default_factory=dict)

    @model_validator(mode="after")
    def check_props(self) -> "OfficeAddCommand":
        _validate_props(self.props)
        return self


class OfficeSetCommand(BaseModel):
    command: Literal["set"]
    path: OfficePath
    props: dict[str, OfficePropValue] = Field(min_length=1)

    @model_validator(mode="after")
    def check_props(self) -> "OfficeSetCommand":
        _validate_props(self.props)
        return self


class OfficeRemoveCommand(BaseModel):
    command: Literal["remove"]
    path: OfficePath


OfficeCommand = Annotated[
    OfficeAddCommand | OfficeSetCommand | OfficeRemoveCommand,
    Field(discriminator="command"),
]

_HEX_COLOR = r"^#[0-9a-fA-F]{6}$"


class PdfDrawText(BaseModel):
    operation: Literal["draw_text"]
    page: int = Field(ge=1, le=2000)
    text: str = Field(max_length=MAX_TEXT)
    x: float = Field(default=0, ge=0, le=14400)
    y: float = Field(default=0, ge=0, le=14400)
    size: float = Field(default=12, ge=6, le=144)
    color: str = Field(default="#000000", pattern=_HEX_COLOR)


class PdfReplacePage(BaseModel):
    operation: Literal["replace_page"]
    page: int = Field(ge=1, le=2000)
    text: str = Field(default="", max_length=MAX_TEXT)
    x: float = Field(default=0, ge=0, le=14400)
    y: float = Field(default=0, ge=0, le=14400)
    size: float = Field(default=12, ge=6, le=144)
    color: str = Field(default="#000000", pattern=_HEX_COLOR)


class PdfAddPage(BaseModel):
    operation: Literal["add_page"]
    page: int | None = Field(default=None, ge=1, le=2001)
    width: float | None = Field(default=None, ge=72, le=14400)
    height: float | None = Field(default=None, ge=72, le=14400)
    text: str = Field(default="", max_length=MAX_TEXT)
    x: float = Field(default=0, ge=0, le=14400)
    y: float = Field(default=0, ge=0, le=14400)
    size: float = Field(default=12, ge=6, le=144)
    color: str = Field(default="#000000", pattern=_HEX_COLOR)


class PdfRemovePage(BaseModel):
    operation: Literal["remove_page"]
    page: int = Field(ge=1, le=2000)


class PdfRotatePage(BaseModel):
    operation: Literal["rotate_page"]
    page: int = Field(ge=1, le=2000)
    degrees: Literal[0, 90, 180, 270]


class PdfSetField(BaseModel):
    operation: Literal["set_field"]
    name: str = Field(min_length=1, max_length=200)
    text: str = Field(max_length=MAX_TEXT)


PdfChange = Annotated[
    PdfDrawText | PdfReplacePage | PdfAddPage | PdfRemovePage | PdfRotatePage | PdfSetField,
    Field(discriminator="operation"),
]


class FileToolRequest(BaseModel):
    operation: Literal["list", "read", "grep", "help", "inspect", "create", "edit", "save"]
    conversationId: uuid.UUID | None = None
    # UUID for a stored file, or ``draft:<uuid>`` for an in-progress document.
    fileId: str | None = Field(default=None, max_length=80)
    filename: OfficeFileName | None = None
    format: OfficeFormat | None = None
    element: str | None = Field(default=None, max_length=100)
    path: OfficePath | None = None
    commands: list[OfficeCommand] | None = Field(default=None, max_length=MAX_COMMANDS)
    pdfChanges: list[PdfChange] | None = Field(default=None, max_length=MAX_COMMANDS)
    save: bool = False
    start: int = Field(default=1, ge=1)
    end: int | None = Field(default=None, ge=1)
    maxChars: int = Field(default=30000, ge=1, le=50000)
    pattern: str | None = Field(default=None, max_length=200)
    context: int = Field(default=1, ge=0, le=5)
    maxMatches: int = Field(default=50, ge=1, le=200)

    @model_validator(mode="after")
    def check_operation(self) -> "FileToolRequest":
        operation = self.operation
        if operation == "list":
            return self
        if operation in {"read", "grep", "inspect", "edit", "save"} and not self.fileId:
            raise ValueError(f"{operation} 需要 fileId。")
        if operation == "grep" and not (self.pattern and self.pattern.strip()):
            raise ValueError("grep 需要非空的 pattern。")
        if operation == "save" and not self.fileId.startswith("draft:"):
            raise ValueError("save 只能保存草稿。")
        if operation == "create":
            if self.fileId:
                raise ValueError("create 不能带 fileId。")
            if not self.format and not self.filename:
                raise ValueError("create 需要 format 或 filename。")
            if self.commands and self.pdfChanges:
                raise ValueError("commands 与 pdfChanges 不能同时提供。")
        if operation == "edit":
            if bool(self.commands) == bool(self.pdfChanges):
                raise ValueError("edit 需要 commands 或 pdfChanges 之一。")
        if operation == "help" and not (self.format or self.fileId):
            raise ValueError("help 需要 format 或 fileId。")
        return self
