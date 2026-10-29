import { useLocalSearchParams } from 'expo-router';

import { ChatScreen } from '@/features/chat/native/chat-screen';

export default function ConversationScreen() {
  const { conversationId } = useLocalSearchParams<{ conversationId: string | string[] }>();
  return <ChatScreen conversationId={Array.isArray(conversationId) ? conversationId[0] ?? null : conversationId ?? null} />;
}
