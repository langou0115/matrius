from dataclasses import dataclass

from fastapi import Depends

from app.cache import enforce_rate_limit


@dataclass(frozen=True)
class InstanceContext:
    instance_id: int = 1


@dataclass(frozen=True)
class ToolCaller:
    identity: str = "instance"
    instance_id: int = 1


async def get_instance() -> InstanceContext:
    return InstanceContext()


async def get_tool_caller() -> ToolCaller:
    return ToolCaller()


async def read_rate_limit(ctx: InstanceContext = Depends(get_instance)) -> InstanceContext:
    await enforce_rate_limit("read", "instance", 240)
    return ctx


async def write_rate_limit(ctx: InstanceContext = Depends(get_instance)) -> InstanceContext:
    await enforce_rate_limit("write", "instance", 120)
    return ctx
