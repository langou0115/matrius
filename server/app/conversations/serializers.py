from typing import Any

from app.files.service import file_summary
from app.models import Conversation, Message, StoredFile
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
        "contextSummary": conversation.context_summary,
        "clientUpdatedAt": conversation.client_updated_at_ms,
        "readState": {
            "completed": read_state(conversation.completed_state, conversation.completed_read_at_ms),
            "error": read_state(conversation.error_state, conversation.error_read_at_ms),
        },
        "revision": conversation.revision,
        "createdAt": to_ms(conversation.created_at),
        "updatedAt": to_ms(conversation.updated_at),
    }


def message_out(
    message: Message, files_by_id: dict[str, StoredFile] | None = None
) -> dict[str, Any]:
    files = []
    if files_by_id:
        for raw_id in message.file_ids or []:
            stored = files_by_id.get(raw_id)
            if stored is not None:
                files.append(file_summary(stored))
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
        "activities": message.activities,
        "process": message.process,
        "uiArtifacts": message.ui_artifacts,
        "thinkingMs": message.thinking_ms,
        "status": message.status,
        "error": message.error,
        "fileIds": message.file_ids or [],
        "files": files,
        "revision": message.revision,
        "createdAt": to_ms(message.created_at),
        "updatedAt": to_ms(message.updated_at),
    }
