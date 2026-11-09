import uuid
from datetime import date as calendar_date
from datetime import timedelta
from typing import Any

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, select
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_db
from app.errors import AppError, invalid
from app.features.registry import enabled_features
from app.instance.dependencies import InstanceContext, read_rate_limit, write_rate_limit
from app.models import (
    Conversation,
    Message,
    StoredFile,
    TokenUsageDaily,
    TokenUsageEstimateDaily,
    UsageBackfill,
)
from app.usage.estimate import estimate_conversation
from app.utils import utcnow

router = APIRouter(prefix="/api/usage", tags=["usage"])

# Bounds a single report; a run cannot legitimately spend more than this many tokens.
MAX_REPORT_TOKENS = 100_000_000
# The client sends its local calendar day. Two days of slack covers every time zone without
# letting a bad clock or a crafted request write far-future statistics.
MAX_DAY_OFFSET = 2
MAX_WINDOW_DAYS = 1095
MAX_UTC_OFFSET_MINUTES = 840


class UsageReport(BaseModel):
    """Counters for one finished reply. Missing fields default to zero."""

    date: calendar_date | None = None
    inputTokens: int = Field(default=0, ge=0, le=MAX_REPORT_TOKENS)
    outputTokens: int = Field(default=0, ge=0, le=MAX_REPORT_TOKENS)
    cacheReadTokens: int = Field(default=0, ge=0, le=MAX_REPORT_TOKENS)
    cacheWriteTokens: int = Field(default=0, ge=0, le=MAX_REPORT_TOKENS)


class BackfillRequest(BaseModel):
    """The browser's `getTimezoneOffset()` keeps history on the reader's local calendar."""

    utcOffsetMinutes: int = Field(default=0, ge=-MAX_UTC_OFFSET_MINUTES, le=MAX_UTC_OFFSET_MINUTES)


def _report_day(value: calendar_date | None) -> calendar_date:
    today = utcnow().date()
    day = value or today
    if abs((day - today).days) > MAX_DAY_OFFSET:
        raise invalid("用量日期超出允许范围。")
    return day


def _require_enabled(ctx: InstanceContext) -> InstanceContext:
    if "usage" not in enabled_features():
        raise AppError(403, "feature_unavailable", "当前实例尚未开放此功能。")
    return ctx


async def usage_read(ctx: InstanceContext = Depends(read_rate_limit)) -> InstanceContext:
    return _require_enabled(ctx)


async def usage_write(ctx: InstanceContext = Depends(write_rate_limit)) -> InstanceContext:
    return _require_enabled(ctx)


def _totals(**values: int) -> dict[str, int]:
    total = values.get("input", 0) + values.get("output", 0)
    return {**values, "total": total}


@router.post("")
async def record_usage(
    payload: UsageReport,
    ctx: InstanceContext = Depends(usage_write),
    db: AsyncSession = Depends(get_db),
) -> dict[str, bool]:
    # A stopped or failed reply can still have produced zero tokens; nothing to accumulate.
    tokens = payload.inputTokens + payload.outputTokens + payload.cacheReadTokens + payload.cacheWriteTokens
    if tokens <= 0:
        return {"ok": True}

    now = utcnow()
    statement = sqlite_insert(TokenUsageDaily).values(
        id=uuid.uuid4(),
        instance_id=ctx.instance_id,
        day=_report_day(payload.date),
        input_tokens=payload.inputTokens,
        output_tokens=payload.outputTokens,
        cache_read_tokens=payload.cacheReadTokens,
        cache_write_tokens=payload.cacheWriteTokens,
        requests=1,
        created_at=now,
        updated_at=now,
    )
    statement = statement.on_conflict_do_update(
        index_elements=["instance_id", "day"],
        set_={
            "input_tokens": TokenUsageDaily.input_tokens + statement.excluded.input_tokens,
            "output_tokens": TokenUsageDaily.output_tokens + statement.excluded.output_tokens,
            "cache_read_tokens": TokenUsageDaily.cache_read_tokens + statement.excluded.cache_read_tokens,
            "cache_write_tokens": TokenUsageDaily.cache_write_tokens + statement.excluded.cache_write_tokens,
            "requests": TokenUsageDaily.requests + 1,
            "updated_at": now,
        },
    )
    await db.execute(statement)
    await db.commit()
    return {"ok": True}


async def _estimate_history(
    db: AsyncSession, instance_id: int, utc_offset_minutes: int
) -> dict[calendar_date, list[int]]:
    """Walk the instance's stored conversations once and bucket the estimates by local day."""
    conversation_ids = (
        await db.execute(select(Conversation.id).where(Conversation.instance_id == instance_id))
    ).scalars().all()
    image_ids = {
        str(file_id)
        for file_id in (
            await db.execute(
                select(StoredFile.id).where(
                    StoredFile.instance_id == instance_id,
                    StoredFile.content_type.like("image/%"),
                )
            )
        ).scalars()
    }
    days: dict[calendar_date, list[int]] = {}
    for conversation_id in conversation_ids:
        messages = (
            await db.execute(
                select(Message)
                .where(
                    Message.conversation_id == conversation_id,
                    Message.instance_id == instance_id,
                )
                .order_by(Message.position)
            )
        ).scalars().all()
        for day, (input_tokens, output_tokens, requests) in estimate_conversation(
            messages, utc_offset_minutes=utc_offset_minutes, image_ids=image_ids
        ).items():
            bucket = days.setdefault(day, [0, 0, 0])
            bucket[0] += input_tokens
            bucket[1] += output_tokens
            bucket[2] += requests
    return days


@router.post("/backfill")
async def backfill_usage(
    payload: BackfillRequest,
    ctx: InstanceContext = Depends(usage_write),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Estimate usage for conversations that predate recording. Runs once per instance.

    Exact history does not exist: provider counters never reached the server. The estimate is
    kept separate from reported usage and is labelled as such in the usage panel.
    """
    if await db.get(UsageBackfill, ctx.instance_id) is not None:
        return {"backfilled": True, "skipped": True}

    days = await _estimate_history(db, ctx.instance_id, payload.utcOffsetMinutes)
    now = utcnow()
    await db.execute(
        delete(TokenUsageEstimateDaily).where(TokenUsageEstimateDaily.instance_id == ctx.instance_id)
    )
    for day, (input_tokens, output_tokens, requests) in days.items():
        db.add(
            TokenUsageEstimateDaily(
                id=uuid.uuid4(),
                instance_id=ctx.instance_id,
                day=day,
                input_tokens=input_tokens,
                output_tokens=output_tokens,
                requests=requests,
                created_at=now,
                updated_at=now,
            )
        )
    db.add(UsageBackfill(instance_id=ctx.instance_id, created_at=now, updated_at=now))
    try:
        await db.commit()
    except IntegrityError:
        # Another tab finished the same one-time estimate first; its rows are equivalent.
        await db.rollback()
        return {"backfilled": True, "skipped": True}
    return {
        "backfilled": True,
        "skipped": False,
        "days": len(days),
        "requests": sum(bucket[2] for bucket in days.values()),
        "total": sum(bucket[0] + bucket[1] for bucket in days.values()),
    }


@router.get("")
async def get_usage(
    days: int = Query(default=366, ge=1, le=MAX_WINDOW_DAYS),
    ctx: InstanceContext = Depends(usage_read),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    today = utcnow().date()
    start = today - timedelta(days=days - 1)
    end = today + timedelta(days=1)

    def _window(model):
        return select(model).where(
            model.instance_id == ctx.instance_id,
            model.day >= start,
            # Include tomorrow's bucket as well: a reader east of UTC may already have
            # recorded a reply under their local date.
            model.day <= end,
        )

    actual_rows = (await db.execute(_window(TokenUsageDaily).order_by(TokenUsageDaily.day))).scalars().all()
    estimate_rows = (
        await db.execute(_window(TokenUsageEstimateDaily).order_by(TokenUsageEstimateDaily.day))
    ).scalars().all()

    # Reported and estimated tokens are merged per day for display but never in storage.
    merged: dict[str, dict[str, int | bool]] = {}
    for row in actual_rows:
        merged[row.day.isoformat()] = {
            "input": row.input_tokens,
            "output": row.output_tokens,
            "cacheRead": row.cache_read_tokens,
            "cacheWrite": row.cache_write_tokens,
            "requests": row.requests,
            "estimated": False,
        }
    for row in estimate_rows:
        item = merged.setdefault(row.day.isoformat(), {
            "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0,
            "requests": 0, "estimated": False,
        })
        item["input"] = int(item["input"]) + row.input_tokens
        item["output"] = int(item["output"]) + row.output_tokens
        item["requests"] = int(item["requests"]) + row.requests
        item["estimated"] = True
    items = [
        {
            "date": day,
            **values,
            "total": (
                int(values["input"]) + int(values["output"])
                + int(values["cacheRead"]) + int(values["cacheWrite"])
            ),
        }
        for day, values in sorted(merged.items())
    ]

    async def _sums(model):
        return (
            await db.execute(
                select(
                    func.coalesce(func.sum(model.input_tokens), 0),
                    func.coalesce(func.sum(model.output_tokens), 0),
                    func.coalesce(func.sum(model.requests), 0),
                ).where(model.instance_id == ctx.instance_id)
            )
        ).one()

    actual_input, actual_output, actual_requests = await _sums(TokenUsageDaily)
    actual_cache = (
        await db.execute(
            select(
                func.coalesce(func.sum(TokenUsageDaily.cache_read_tokens), 0),
                func.coalesce(func.sum(TokenUsageDaily.cache_write_tokens), 0),
            ).where(TokenUsageDaily.instance_id == ctx.instance_id)
        )
    ).one()
    estimate_input, estimate_output, estimate_requests = await _sums(TokenUsageEstimateDaily)

    lifetime = {
        "input": int(actual_input) + int(estimate_input),
        "output": int(actual_output) + int(estimate_output),
        "cacheRead": int(actual_cache[0]),
        "cacheWrite": int(actual_cache[1]),
        "requests": int(actual_requests) + int(estimate_requests),
    }
    lifetime["total"] = (
        lifetime["input"] + lifetime["output"] + lifetime["cacheRead"] + lifetime["cacheWrite"]
    )
    return {
        "items": items,
        "lifetime": lifetime,
        "estimated": _totals(
            input=int(estimate_input),
            output=int(estimate_output),
            requests=int(estimate_requests),
        ),
        "backfilled": (await db.get(UsageBackfill, ctx.instance_id)) is not None,
    }
