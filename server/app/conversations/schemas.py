import uuid
from typing import Literal

from pydantic import BaseModel, Field


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


class MessagePatch(BaseModel):
    baseRevision: int = Field(ge=1)
    content: str | None = Field(default=None, max_length=1_000_000)
    quote: str | None = Field(default=None, max_length=1_000_000)
    reasoning: str | None = Field(default=None, max_length=1_000_000)
    thinkingMs: int | None = Field(default=None, ge=0)
    status: Literal["complete", "stopped", "error"] | None = None
    error: str | None = Field(default=None, max_length=10_000)
    feedback: Literal["good", "bad"] | None = None
