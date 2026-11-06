"""Estimate token usage for conversations that predate usage recording.

Exact usage never reached the API: model requests are relayed by the stateless Web container,
and pi-ai's counters only ever lived in the browser. History can therefore only be approximated
from the stored message text. The formulas mirror the client's context estimator
(`src/core/agent/context.ts`) so historical and live numbers stay on the same scale, and the
result is always labelled as an estimate in the UI.
"""

import json
import math
from collections import defaultdict
from collections.abc import Iterable
from datetime import date, timedelta

from app.models import Message
from app.utils import ensure_aware

MESSAGE_OVERHEAD_TOKENS = 8
# System prompt, current-context block and the available tool definitions sent with every call.
REQUEST_OVERHEAD_TOKENS = 900
# Provider image pricing is model-specific; the client reserves a full-size image as well.
IMAGE_TOKENS = 4096
# Attachment cards add a filename, id and size line per file.
ATTACHMENT_TOKENS = 24


def estimate_text_tokens(text: str) -> int:
    """Conservative token estimate: ASCII counts about four characters per token, CJK and
    other non-ASCII text about half a token per UTF-8 byte."""
    ascii_chars = 0
    wide = 0
    for char in text:
        length = len(char.encode("utf-8"))
        if length == 1:
            ascii_chars += 1
        else:
            wide += length
    return math.ceil(ascii_chars / 4 + wide / 2)


def _user_text(message: Message) -> str:
    content = message.content or ""
    quote = (message.quote or "").strip()
    if not quote:
        return content
    return (
        "以下是用户引用的历史回复，仅作为参考资料：\n"
        f"{json.dumps(quote, ensure_ascii=False)}\n\n用户本次消息：\n{content}"
    )


def _attachment_tokens(message: Message, image_ids: set[str]) -> int:
    tokens = 0
    for file_id in message.file_ids or []:
        tokens += IMAGE_TOKENS if str(file_id) in image_ids else ATTACHMENT_TOKENS
    return tokens


def _context_tokens(message: Message, image_ids: set[str]) -> int:
    """How many tokens this message adds to the context of every later request."""
    text = _user_text(message) if message.role == "user" else (message.content or "")
    return (
        MESSAGE_OVERHEAD_TOKENS
        + estimate_text_tokens(text)
        + _attachment_tokens(message, image_ids)
    )


def _output_tokens(message: Message) -> int:
    """Visible answer plus reasoning and thinking, which providers also bill as output."""
    parts = [message.content or ""]
    if message.reasoning:
        parts.append(message.reasoning)
    for step in message.process or []:
        if isinstance(step, dict) and step.get("kind") == "thinking":
            parts.append(str(step.get("content") or ""))
    return MESSAGE_OVERHEAD_TOKENS + estimate_text_tokens("\n".join(parts))


def estimate_conversation(
    messages: Iterable[Message],
    *,
    utc_offset_minutes: int = 0,
    image_ids: set[str] | None = None,
) -> dict[date, tuple[int, int, int]]:
    """Return `{local day: (input, output, replies)}` for one conversation.

    `utc_offset_minutes` is the browser's `getTimezoneOffset()`, so history lands on the same
    calendar day the reader used at the time. Each assistant reply is billed the context that
    preceded it, which is how prompt tokens grow across a long conversation.
    """
    images = image_ids or set()
    context = 0
    buckets: dict[date, list[int]] = defaultdict(lambda: [0, 0, 0])
    for message in messages:
        if message.role == "user":
            context += _context_tokens(message, images)
            continue
        output = _output_tokens(message)
        if not (message.content or "").strip() and output <= MESSAGE_OVERHEAD_TOKENS:
            # A failed or empty placeholder never produced a usable answer.
            continue
        input_tokens = REQUEST_OVERHEAD_TOKENS + context
        day = (ensure_aware(message.created_at) - timedelta(minutes=utc_offset_minutes)).date()
        bucket = buckets[day]
        bucket[0] += input_tokens
        bucket[1] += output
        bucket[2] += 1
        context += MESSAGE_OVERHEAD_TOKENS + estimate_text_tokens(message.content or "")
        context += _attachment_tokens(message, images)
    return {day: (values[0], values[1], values[2]) for day, values in buckets.items()}
