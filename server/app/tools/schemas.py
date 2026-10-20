import uuid
from typing import Literal

from pydantic import BaseModel, Field


class SearchRequest(BaseModel):
    query: str = Field(min_length=1, max_length=500)
    limit: int = Field(default=10, ge=1, le=20)


class FetchRequest(BaseModel):
    url: str = Field(min_length=1, max_length=2000)
    mode: Literal["fast", "full"] = "fast"


class FileReadRequest(BaseModel):
    fileId: uuid.UUID
    start: int = Field(default=1, ge=1)
    end: int | None = Field(default=None, ge=1)
    maxChars: int = Field(default=50000, ge=1, le=50000)


class FileGrepRequest(BaseModel):
    fileId: uuid.UUID
    pattern: str = Field(min_length=1, max_length=200)
    context: int = Field(default=1, ge=0, le=5)
    maxMatches: int = Field(default=50, ge=1, le=200)
