import uuid
from typing import Literal

from pydantic import BaseModel, Field, model_validator


class SearchRequest(BaseModel):
    query: str | None = Field(default=None, min_length=1, max_length=500)
    queries: list[str] | None = Field(default=None, min_length=1, max_length=4)
    limit: int = Field(default=10, ge=1, le=50)

    @model_validator(mode="after")
    def _normalize_queries(self) -> "SearchRequest":
        candidates = [*(self.queries or []), *([self.query] if self.query else [])]
        cleaned: list[str] = []
        seen: set[str] = set()
        for candidate in candidates:
            value = candidate.strip()
            if not value or value in seen:
                continue
            seen.add(value)
            cleaned.append(value)
        if not cleaned:
            raise ValueError("搜索关键词不能为空。")
        if len(cleaned) > 4:
            raise ValueError("一次最多提供 4 个搜索关键词。")
        self.query = cleaned[0]
        self.queries = cleaned
        return self


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
