import uuid
from typing import Annotated, Any, Literal

from pydantic import AfterValidator, BaseModel, Field, model_validator
from pydantic_core import PydanticCustomError


def _http_url(value: str) -> str:
    if not value.startswith(("http://", "https://")):
        # A plain ValueError would put a non-serialisable object in `ctx` and break the
        # shared 422 handler.
        raise PydanticCustomError("invalid_url", "URL must use http or https.")
    return value


HttpUrl = Annotated[str, Field(min_length=1, max_length=2_000), AfterValidator(_http_url)]


class WebSearchResult(BaseModel):
    """One source shown under a search step. Snippets stay out of the synced payload."""

    title: str = Field(default="", max_length=300)
    url: HttpUrl
    domain: str = Field(default="", max_length=300)
    rank: int = Field(default=0, ge=0)


class WebActivity(BaseModel):
    """A web search, page read or document operation made while composing a reply.

    Shape mirrors the client's `WebActivity`. The full ordered `process` (thinking segments
    and tools interleaved) travels separately so history keeps the real sequence.
    """

    id: str = Field(min_length=1, max_length=128)
    kind: Literal["search", "fetch", "file"]
    status: Literal["running", "complete", "stopped", "error"]
    query: str | None = Field(default=None, max_length=500)
    results: list[WebSearchResult] = Field(default_factory=list, max_length=20)
    url: HttpUrl | None = None
    urls: list[HttpUrl] = Field(default_factory=list, max_length=4)
    title: str | None = Field(default=None, max_length=300)
    # Document operations. fileId may be a draft handle; savedFileId is a Library file.
    operation: str | None = Field(default=None, max_length=40)
    fileId: str | None = Field(default=None, max_length=80)
    savedFileId: str | None = Field(default=None, max_length=80)
    filename: str | None = Field(default=None, max_length=300)
    size: int | None = Field(default=None, ge=0)
    warning: str | None = Field(default=None, max_length=1_000)
    tookMs: int | None = Field(default=None, ge=0)
    error: str | None = Field(default=None, max_length=1_000)
    startedAt: int | None = Field(default=None, ge=0)
    endedAt: int | None = Field(default=None, ge=0)


def activities_payload(values: list[WebActivity] | None) -> list[dict[str, Any]] | None:
    return [value.model_dump(exclude_none=True, exclude_defaults=True) for value in values] if values else None


class ThinkingActivity(BaseModel):
    """One reasoning segment; display-only and never sent back to the model."""

    id: str = Field(min_length=1, max_length=128)
    kind: Literal["thinking"]
    content: str = Field(default="", max_length=1_000_000)
    status: Literal["running", "complete", "stopped", "error"]
    startedAt: int | None = Field(default=None, ge=0)
    endedAt: int | None = Field(default=None, ge=0)


ProcessActivity = Annotated[ThinkingActivity | WebActivity, Field(discriminator="kind")]


def process_payload(values: list[ProcessActivity] | None) -> list[dict[str, Any]] | None:
    """Keep the event order: thinking segments and tool calls are interleaved on purpose."""
    if not values:
        return None
    return [value.model_dump(exclude_none=True, exclude_defaults=isinstance(value, WebActivity)) for value in values]


class ReadMarker(BaseModel):
    state: Literal["absent", "unread", "read"]
    readAt: int | None = None


class ReadStateUpdate(BaseModel):
    completed: ReadMarker | None = None
    error: ReadMarker | None = None


class ContextSummary(BaseModel):
    """The client's rolling summary of turns before `coveredUntilMessageId`."""

    coveredUntilMessageId: str = Field(min_length=1, max_length=128)
    summary: str = Field(min_length=1, max_length=100_000)


class ConversationCreate(BaseModel):
    id: uuid.UUID | None = None
    clientId: str | None = None
    title: str = Field(default="", max_length=500)
    pinned: bool = False
    modelId: str | None = Field(default=None, max_length=200)
    titleSource: Literal["auto", "ai", "manual"] | None = None
    contextSummary: ContextSummary | None = None
    updatedAt: int | None = None


class ConversationPatch(BaseModel):
    baseRevision: int = Field(ge=1)
    title: str | None = Field(default=None, max_length=500)
    pinned: bool | None = None
    modelId: str | None = Field(default=None, max_length=200)
    titleSource: Literal["auto", "ai", "manual"] | None = None
    contextSummary: ContextSummary | None = None
    readState: ReadStateUpdate | None = None


class UiTableProps(BaseModel):
    title: str = Field(max_length=300)
    columns: list[Annotated[str, Field(max_length=300)]] = Field(min_length=1, max_length=8)
    rows: list[Annotated[list[Annotated[str, Field(max_length=2000)]], Field(max_length=8)]] = Field(max_length=50)
    note: str | None = Field(default=None, max_length=2000)


class UiCardItem(BaseModel):
    label: str = Field(max_length=300)
    value: str = Field(max_length=2000)


class UiCardProps(BaseModel):
    title: str = Field(max_length=300)
    items: list[UiCardItem] = Field(min_length=1, max_length=12)
    note: str | None = Field(default=None, max_length=2000)


class UiStep(BaseModel):
    title: str = Field(max_length=300)
    detail: str | None = Field(default=None, max_length=2000)


class UiStepsProps(BaseModel):
    title: str = Field(max_length=300)
    steps: list[UiStep] = Field(min_length=1, max_length=12)


class UiSandboxProps(BaseModel):
    initialHeight: int = Field(ge=160, le=1200)
    placeholderMessages: list[Annotated[str, Field(max_length=300)]] = Field(max_length=5)
    css: str = Field(max_length=50000)
    html: str = Field(max_length=100000)
    jsFunctions: str = Field(max_length=50000)
    jsExpressions: str = Field(max_length=50000)


class UiArtifact(BaseModel):
    textOffset: int | None = Field(default=None, ge=0, le=1000000)
    streaming: bool | None = None
    id: str = Field(min_length=1, max_length=128)
    name: Literal["comparisonTable", "keyValueCard", "stepsList", "generateSandboxedUi"]
    props: dict[str, Any]

    @model_validator(mode="after")
    def validate_props(self):
        schema = {
            "comparisonTable": UiTableProps,
            "keyValueCard": UiCardProps,
            "stepsList": UiStepsProps,
            "generateSandboxedUi": UiSandboxProps,
        }[self.name]
        self.props = schema.model_validate(self.props).model_dump(exclude_none=True)
        return self


class MessageCreate(BaseModel):
    uiArtifacts: list[UiArtifact] = Field(default_factory=list, max_length=12)
    id: uuid.UUID | None = None
    clientId: str | None = None
    role: Literal["user", "assistant"]
    content: str = Field(default="", max_length=1_000_000)
    steering: bool = False
    quote: str | None = Field(default=None, max_length=1_000_000)
    reasoning: str | None = Field(default=None, max_length=1_000_000)
    thinkingMs: int | None = Field(default=None, ge=0)
    status: Literal["complete", "stopped", "error"] = "complete"
    error: str | None = Field(default=None, max_length=10_000)
    feedback: Literal["good", "bad"] | None = None
    fileIds: list[uuid.UUID] = Field(default_factory=list)
    activities: list[WebActivity] = Field(default_factory=list, max_length=50)
    process: list[ProcessActivity] | None = Field(default=None, max_length=100)


class MessagePatch(BaseModel):
    uiArtifacts: list[UiArtifact] | None = Field(default=None, max_length=12)
    baseRevision: int = Field(ge=1)
    content: str | None = Field(default=None, max_length=1_000_000)
    quote: str | None = Field(default=None, max_length=1_000_000)
    reasoning: str | None = Field(default=None, max_length=1_000_000)
    thinkingMs: int | None = Field(default=None, ge=0)
    status: Literal["complete", "stopped", "error"] | None = None
    error: str | None = Field(default=None, max_length=10_000)
    feedback: Literal["good", "bad"] | None = None
    fileIds: list[uuid.UUID] | None = Field(default=None, max_length=20)
    activities: list[WebActivity] | None = Field(default=None, max_length=50)
    process: list[ProcessActivity] | None = Field(default=None, max_length=100)
