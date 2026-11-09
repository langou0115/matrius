import re
import uuid
from datetime import datetime
from typing import Any, Literal

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy import select, tuple_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_db
from app.errors import conflict, invalid, not_found
from app.instance.dependencies import InstanceContext, read_rate_limit, write_rate_limit
from app.models import ConversationDeletion, MemoryEntry, Preference, Profile, ProfileField
from app.utils import (
    clamp_page_size,
    decode_cursor,
    encode_cursor,
    ensure_aware,
    to_ms,
    utcnow,
    validate_client_id,
)
from app.workspace.import_service import MAX_IMPORT_BYTES, run_import
from app.workspace.schemas import (
    ImportRequest,
    MemoryCreate,
    MemoryPatch,
    PreferencesUpdate,
    ProfileFieldUpdate,
    ProfileUpdate,
)

router = APIRouter(prefix="/api", tags=["instance"])

FIELD_KEY_RE = re.compile(r"^[^\s\x00-\x1f\x7f]{1,64}$")


async def _get_or_create_preferences(db: AsyncSession, instance_id: int) -> Preference:
    preferences = (
        await db.execute(select(Preference).where(Preference.instance_id == instance_id))
    ).scalar_one_or_none()
    if preferences is not None:
        return preferences

    preferences = Preference(instance_id=instance_id)
    db.add(preferences)
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        preferences = (
            await db.execute(select(Preference).where(Preference.instance_id == instance_id))
        ).scalar_one()
    return preferences


async def _get_or_create_profile(db: AsyncSession, instance_id: int) -> Profile:
    profile = (
        await db.execute(select(Profile).where(Profile.instance_id == instance_id))
    ).scalar_one_or_none()
    if profile is not None:
        return profile

    profile = Profile(instance_id=instance_id)
    db.add(profile)
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        profile = (
            await db.execute(select(Profile).where(Profile.instance_id == instance_id))
        ).scalar_one()
    return profile


def _preferences_out(preferences: Preference) -> dict[str, Any]:
    return {
        "themeId": preferences.theme_id,
        "mode": preferences.mode,
        "revision": preferences.revision,
    }


def _profile_out(profile: Profile) -> dict[str, Any]:
    return {
        "customInstructions": profile.custom_instructions,
        "aboutName": profile.about_name,
        "occupation": profile.occupation,
        "aboutMore": profile.about_more,
        "revision": profile.revision,
    }


def _field_out(field: ProfileField) -> dict[str, Any]:
    return {
        "key": field.key,
        "value": field.value,
        "source": field.source,
        "updatedAt": field.client_updated_at_ms
        if field.client_updated_at_ms is not None
        else to_ms(field.updated_at),
        "revision": field.revision,
    }


def _memory_out(memory: MemoryEntry) -> dict[str, Any]:
    return {
        "id": str(memory.id),
        "clientId": memory.client_id,
        "scope": memory.scope,
        "type": memory.type,
        "status": memory.status,
        "content": memory.content,
        "source": memory.source,
        "revision": memory.revision,
        "createdAt": memory.client_created_at_ms
        if memory.client_created_at_ms is not None
        else to_ms(memory.created_at),
        "updatedAt": memory.client_updated_at_ms
        if memory.client_updated_at_ms is not None
        else to_ms(memory.updated_at),
    }


async def _get_field(db: AsyncSession, instance_id: int, key: str, *, lock: bool = False) -> ProfileField:
    stmt = select(ProfileField).where(
        ProfileField.instance_id == instance_id, ProfileField.key == key
    )
    if lock:
        stmt = stmt.with_for_update()
    field = (await db.execute(stmt)).scalar_one_or_none()
    if field is None:
        raise not_found("画像字段不存在。")
    return field


def _check_key(key: str) -> str:
    if not FIELD_KEY_RE.fullmatch(key):
        raise invalid("字段名必须是 1–64 个不含空白或控制字符的字符。")
    return key


@router.get("/preferences")
async def get_preferences(
    ctx: InstanceContext = Depends(read_rate_limit), db: AsyncSession = Depends(get_db)
) -> dict[str, Any]:
    return _preferences_out(await _get_or_create_preferences(db, ctx.instance_id))


@router.put("/preferences")
async def put_preferences(
    payload: PreferencesUpdate,
    ctx: InstanceContext = Depends(write_rate_limit),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    preferences = await _get_or_create_preferences(db, ctx.instance_id)
    if preferences.revision != payload.baseRevision:
        raise conflict("设置已在其他设备更新，请刷新后重试。", current=_preferences_out(preferences))
    preferences.theme_id = payload.themeId
    preferences.mode = payload.mode
    preferences.revision += 1
    preferences.updated_at = utcnow()
    await db.commit()
    return _preferences_out(preferences)


@router.get("/profile")
async def get_profile(
    ctx: InstanceContext = Depends(read_rate_limit), db: AsyncSession = Depends(get_db)
) -> dict[str, Any]:
    return _profile_out(await _get_or_create_profile(db, ctx.instance_id))


@router.put("/profile")
async def put_profile(
    payload: ProfileUpdate,
    ctx: InstanceContext = Depends(write_rate_limit),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    profile = await _get_or_create_profile(db, ctx.instance_id)
    if profile.revision != payload.baseRevision:
        raise conflict("个性化设置已在其他设备更新，请刷新后重试。", current=_profile_out(profile))
    profile.custom_instructions = payload.customInstructions
    profile.about_name = payload.aboutName
    profile.occupation = payload.occupation
    profile.about_more = payload.aboutMore
    profile.revision += 1
    profile.updated_at = utcnow()
    await db.commit()
    return _profile_out(profile)


@router.get("/profile/fields")
async def list_profile_fields(
    ctx: InstanceContext = Depends(read_rate_limit), db: AsyncSession = Depends(get_db)
) -> dict[str, Any]:
    fields = (
        await db.execute(
            select(ProfileField)
            .where(ProfileField.instance_id == ctx.instance_id)
            .order_by(ProfileField.key)
        )
    ).scalars().all()
    return {"items": [_field_out(field) for field in fields]}


@router.get("/profile/fields/{key}")
async def get_profile_field(
    key: str,
    ctx: InstanceContext = Depends(read_rate_limit),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    return _field_out(await _get_field(db, ctx.instance_id, key))


@router.put("/profile/fields/{key}")
async def put_profile_field(
    key: str,
    payload: ProfileFieldUpdate,
    ctx: InstanceContext = Depends(write_rate_limit),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    _check_key(key)
    field = (
        await db.execute(
            select(ProfileField)
            .where(ProfileField.instance_id == ctx.instance_id, ProfileField.key == key)
            .with_for_update()
        )
    ).scalar_one_or_none()

    if field is None:
        field = ProfileField(
            instance_id=ctx.instance_id,
            key=key,
            value=payload.value,
            source=payload.source,
            client_updated_at_ms=payload.updatedAt,
        )
        db.add(field)
    else:
        if payload.baseRevision is not None and field.revision != payload.baseRevision:
            raise conflict("字段已在其他设备更新，请刷新后重试。", current=_field_out(field))
        field.value = payload.value
        field.source = payload.source
        field.client_updated_at_ms = payload.updatedAt
        field.revision += 1
        field.updated_at = utcnow()

    await db.commit()
    return _field_out(field)


@router.delete("/profile/fields/{key}")
async def delete_profile_field(
    key: str,
    baseRevision: int | None = Query(default=None, ge=1),
    ctx: InstanceContext = Depends(write_rate_limit),
    db: AsyncSession = Depends(get_db),
) -> dict[str, bool]:
    field = await _get_field(db, ctx.instance_id, key, lock=True)
    if baseRevision is not None and field.revision != baseRevision:
        raise conflict("字段已在其他设备更新，请刷新后重试。", current=_field_out(field))
    await db.delete(field)
    await db.commit()
    return {"ok": True}


def _parse_memory_cursor(cursor: str) -> tuple[datetime, uuid.UUID]:
    updated_raw, id_raw = decode_cursor(cursor, 2)
    try:
        return ensure_aware(datetime.fromisoformat(updated_raw)), uuid.UUID(id_raw)
    except (ValueError, TypeError) as exc:
        raise invalid("分页游标无效。") from exc


@router.get("/memories")
async def list_memories(
    limit: int = Query(default=50, ge=1),
    cursor: str | None = None,
    status: Literal["active", "archived"] | None = None,
    scope: Literal["global", "conversation"] | None = None,
    ctx: InstanceContext = Depends(read_rate_limit),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    page_size = clamp_page_size(limit)
    stmt = select(MemoryEntry).where(MemoryEntry.instance_id == ctx.instance_id)
    if status is not None:
        stmt = stmt.where(MemoryEntry.status == status)
    if scope is not None:
        stmt = stmt.where(MemoryEntry.scope == scope)
    if cursor:
        updated_at, memory_id = _parse_memory_cursor(cursor)
        stmt = stmt.where(
            tuple_(MemoryEntry.updated_at, MemoryEntry.id) < tuple_(updated_at, memory_id)
        )
    stmt = stmt.order_by(MemoryEntry.updated_at.desc(), MemoryEntry.id.desc()).limit(page_size + 1)

    rows = list((await db.execute(stmt)).scalars().all())
    has_more = len(rows) > page_size
    rows = rows[:page_size]
    next_cursor = None
    if has_more and rows:
        last = rows[-1]
        next_cursor = encode_cursor(ensure_aware(last.updated_at).isoformat(), str(last.id))
    return {"items": [_memory_out(memory) for memory in rows], "nextCursor": next_cursor}


@router.post("/memories", status_code=201)
async def create_memory(
    payload: MemoryCreate,
    ctx: InstanceContext = Depends(write_rate_limit),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    client_id = validate_client_id(payload.clientId)
    if payload.id is not None:
        existing = (
            await db.execute(select(MemoryEntry).where(MemoryEntry.id == payload.id))
        ).scalar_one_or_none()
        if existing is not None:
            if existing.instance_id != ctx.instance_id:
                raise conflict("该标识已被占用。")
            return _memory_out(existing)
    if client_id is not None:
        existing = (
            await db.execute(
                select(MemoryEntry).where(
                    MemoryEntry.instance_id == ctx.instance_id, MemoryEntry.client_id == client_id
                )
            )
        ).scalar_one_or_none()
        if existing is not None:
            return _memory_out(existing)

    memory = MemoryEntry(
        id=payload.id or uuid.uuid4(),
        instance_id=ctx.instance_id,
        client_id=client_id,
        scope=payload.scope,
        type=payload.type,
        status=payload.status,
        content=payload.content,
        source=payload.source,
        client_created_at_ms=payload.createdAt,
        client_updated_at_ms=payload.updatedAt,
    )
    db.add(memory)
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise conflict("记忆已存在，请刷新后重试。") from None
    return _memory_out(memory)


@router.patch("/memories/{memory_id}")
async def update_memory(
    memory_id: uuid.UUID,
    payload: MemoryPatch,
    ctx: InstanceContext = Depends(write_rate_limit),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    memory = (
        await db.execute(
            select(MemoryEntry)
            .where(MemoryEntry.id == memory_id, MemoryEntry.instance_id == ctx.instance_id)
            .with_for_update()
        )
    ).scalar_one_or_none()
    if memory is None:
        raise not_found("记忆不存在。")
    if memory.revision != payload.baseRevision:
        raise conflict("记忆已在其他设备更新，请刷新后重试。", current=_memory_out(memory))

    fields = payload.model_dump(exclude_unset=True)
    mapping = {
        "scope": "scope",
        "type": "type",
        "status": "status",
        "content": "content",
        "source": "source",
        "updatedAt": "client_updated_at_ms",
    }
    for name, attribute in mapping.items():
        if name in fields and fields[name] is not None:
            setattr(memory, attribute, fields[name])

    memory.revision += 1
    memory.updated_at = utcnow()
    await db.commit()
    return _memory_out(memory)


@router.delete("/memories/{memory_id}")
async def archive_memory(
    memory_id: uuid.UUID,
    baseRevision: int = Query(ge=1),
    ctx: InstanceContext = Depends(write_rate_limit),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    memory = (
        await db.execute(
            select(MemoryEntry)
            .where(MemoryEntry.id == memory_id, MemoryEntry.instance_id == ctx.instance_id)
            .with_for_update()
        )
    ).scalar_one_or_none()
    if memory is None:
        raise not_found("记忆不存在。")
    if memory.revision != baseRevision:
        raise conflict("记忆已在其他设备更新，请刷新后重试。", current=_memory_out(memory))
    if memory.status != "archived":
        memory.status = "archived"
        memory.revision += 1
        memory.updated_at = utcnow()
        await db.commit()
    return _memory_out(memory)


@router.get("/workspace/conversation-deletions")
async def list_conversation_deletions(
    limit: int = Query(default=100, ge=1),
    cursor: str | None = None,
    ctx: InstanceContext = Depends(read_rate_limit),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    page_size = clamp_page_size(limit)
    stmt = select(ConversationDeletion.client_id).where(ConversationDeletion.instance_id == ctx.instance_id)
    if cursor:
        (client_id,) = decode_cursor(cursor, 1)
        stmt = stmt.where(ConversationDeletion.client_id > client_id)
    rows = list((await db.execute(stmt.order_by(ConversationDeletion.client_id).limit(page_size + 1))).scalars())
    items = rows[:page_size]
    return {"items": items, "nextCursor": encode_cursor(items[-1]) if len(rows) > page_size else None}


@router.post("/workspace/import")
async def import_workspace(
    payload: ImportRequest,
    request: Request,
    ctx: InstanceContext = Depends(write_rate_limit),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    content_length = request.headers.get("content-length")
    if content_length is not None:
        try:
            if int(content_length) > MAX_IMPORT_BYTES:
                raise invalid("导入数据超过单批 8 MiB 限制。")
        except ValueError:
            raise invalid("Content-Length 不合法。") from None
    return await run_import(db, ctx.instance_id, payload)
