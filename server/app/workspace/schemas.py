import uuid
from typing import Annotated, Literal

from pydantic import BaseModel, Field

from app.conversations.schemas import ContextSummary, ProcessActivity, WebActivity

MemoryType = Literal["identity", "workflow", "voice", "instruction"]
MemorySource = Literal["manual", "tool", "extracted"]
MemoryScope = Literal["global", "conversation"]
MemoryStatus = Literal["active", "archived"]


class PreferencesUpdate(BaseModel):
    baseRevision: int = Field(ge=1)
    themeId: str = Field(min_length=1, max_length=64)
    mode: Literal["light", "dark", "system"]


class ProfileUpdate(BaseModel):
    baseRevision: int = Field(ge=1)
    customInstructions: str = Field(default="", max_length=10_000)
    aboutName: str = Field(default="", max_length=100)
    occupation: str = Field(default="", max_length=100)
    aboutMore: str = Field(default="", max_length=4_000)


class ProfileFieldUpdate(BaseModel):
    baseRevision: int | None = Field(default=None, ge=1)
    value: str = Field(default="", max_length=20_000)
    source: str = Field(default="manual", max_length=32)
    updatedAt: int | None = None


class MemoryCreate(BaseModel):
    id: uuid.UUID | None = None
    clientId: str | None = None
    scope: MemoryScope = "global"
    type: MemoryType
    status: MemoryStatus = "active"
    content: str = Field(min_length=1, max_length=20_000)
    source: MemorySource = "manual"
    createdAt: int | None = None
    updatedAt: int | None = None


class MemoryPatch(BaseModel):
    baseRevision: int = Field(ge=1)
    scope: MemoryScope | None = None
    type: MemoryType | None = None
    status: MemoryStatus | None = None
    content: str | None = Field(default=None, min_length=1, max_length=20_000)
    source: MemorySource | None = None
    updatedAt: int | None = None


class ImportMessage(BaseModel):
    id: str | None = Field(default=None, max_length=128)
    role: Literal["user", "assistant"]
    content: str = Field(default="", max_length=1_000_000)
    steering: bool = False
    quote: str | None = Field(default=None, max_length=1_000_000)
    feedback: Literal["good", "bad"] | None = None
    reasoning: str | None = Field(default=None, max_length=1_000_000)
    thinkingMs: int | None = Field(default=None, ge=0)
    status: Literal["complete", "stopped", "error"] = "complete"
    error: str | None = Field(default=None, max_length=10_000)
    # Cloud file ids only; local exports predate cloud storage and leave this empty.
    fileIds: list[uuid.UUID] = Field(default_factory=list, max_length=20)
    activities: list[WebActivity] = Field(default_factory=list, max_length=50)
    process: list[ProcessActivity] | None = Field(default=None, max_length=100)


class ImportReadMarker(BaseModel):
    state: Literal["absent", "unread", "read"]
    readAt: int | None = None


class ImportReadState(BaseModel):
    completed: ImportReadMarker | None = None
    error: ImportReadMarker | None = None


class ImportConversation(BaseModel):
    id: str = Field(min_length=1, max_length=128)
    title: str = Field(default="", max_length=500)
    pinned: bool = False
    updatedAt: int | None = None
    modelId: str | None = Field(default=None, max_length=200)
    titleSource: Literal["auto", "ai", "manual"] | None = None
    contextSummary: ContextSummary | None = None
    readState: ImportReadState | None = None
    messages: list[ImportMessage] = Field(default_factory=list)


class ImportChat(BaseModel):
    conversations: list[ImportConversation] = Field(default_factory=list)
    deletedConversationIds: list[Annotated[str, Field(min_length=1, max_length=128)]] = Field(
        default_factory=list, max_length=2000
    )


class ImportAppearance(BaseModel):
    themeId: str = Field(min_length=1, max_length=64)
    mode: Literal["light", "dark", "system"]


class ImportPersonalization(BaseModel):
    customInstructions: str = Field(default="", max_length=10_000)
    aboutName: str = Field(default="", max_length=100)
    occupation: str = Field(default="", max_length=100)
    aboutMore: str = Field(default="", max_length=4_000)


class ImportRequest(BaseModel):
    schemaVersion: int
    chat: ImportChat = Field(default_factory=ImportChat)
    appearance: ImportAppearance | None = None
    personalization: ImportPersonalization | None = None
