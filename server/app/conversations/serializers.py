from typing import Any

from app.models import Conversation, Message
from app.utils import to_ms


def read_state(state: str, read_at_ms: int | None) -> dict[str, Any]:
    if state == "read":
        return {"state": "read", "readAt": read_at_ms}
    return {"state": state}


def conversation_out(conversation: Conversation) -> dict[str, Any]:
    return {
        "id": str(conversation.id),
        "clientId": conversation.client_id,
        "title": conversation.title,
        "pinned": conversation.pinned,
        "modelId": conversation.model_id,
        "titleSource": conversation.title_source,
        "clientUpdatedAt": conversation.client_updated_at_ms,
        "readState": {
            "completed": read_state(conversation.completed_state, conversation.completed_read_at_ms),
            "error": read_state(conversation.error_state, conversation.error_read_at_ms),
        },
        "revision": conversation.revision,
        "createdAt": to_ms(conversation.created_at),
        "updatedAt": to_ms(conversation.updated_at),
    }


def message_out(message: Message) -> dict[str, Any]:
    return {
        "id": str(message.id),
        "clientId": message.client_id,
        "conversationId": str(message.conversation_id),
        "position": message.position,
        "role": message.role,
        "content": message.content,
        "steering": message.steering,
        "quote": message.quote,
        "feedback": message.feedback,
        "reasoning": message.reasoning,
        "thinkingMs": message.thinking_ms,
        "status": message.status,
        "error": message.error,
        "fileIds": message.file_ids or [],
        "revision": message.revision,
        "createdAt": to_ms(message.created_at),
        "updatedAt": to_ms(message.updated_at),
    }
