import uuid
from typing import Annotated, Any, Literal

from pydantic import AfterValidator, BaseModel, Field
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
    urls: list[HttpUrl] = Field(default_factory=list, max_length=10)
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
    return [
        value.model_dump(exclude_none=True, exclude_defaults=isinstance(value, WebActivity))
        for value in values
    ]


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


class MessageCreate(BaseModel):
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
