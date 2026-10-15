import { Redirect } from 'expo-router';

import ChatScreen from '@/features/chat/chat-screen.web';

export default function MockChatRoute() {
  return __DEV__ ? <ChatScreen /> : <Redirect href="/" />;
}
