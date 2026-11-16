import type { Conversation, Message } from './chat-state';

function collectFileIds(message: Message, ids: Set<string>): void {
  for (const id of message.fileIds ?? []) ids.add(id);
  for (const file of message.files ?? []) ids.add(file.id);
  // Images only carry their upload id while this session still has the message in memory;
  // stored snapshots strip the bytes and the id with them.
  for (const image of message.images ?? []) if (image.fileId) ids.add(image.fileId);
}

/**
 * File ids one conversation points at: uploaded documents, files a reply saved to the Library
 * and, until the page reloads, uploaded images. Ids another conversation still references (a
 * fork, or a document reused elsewhere) are left out so cleanup cannot rewrite their history.
 */
export function conversationFileIds(conversation: Conversation, others: Conversation[] = []): string[] {
  const own = new Set<string>();
  for (const message of conversation.messages) collectFileIds(message, own);
  if (!own.size || !others.length) return [...own];
  const shared = new Set<string>();
  for (const other of others) {
    if (other.id === conversation.id) continue;
    for (const message of other.messages) collectFileIds(message, shared);
  }
  return [...own].filter((id) => !shared.has(id));
}
