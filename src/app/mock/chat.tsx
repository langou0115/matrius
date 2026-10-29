import { Redirect } from 'expo-router';

import ChatScreen from '@/features/chat/chat-route.web';

export default function MockChatRoute() {
  return __DEV__ ? <ChatScreen /> : <Redirect href="/" />;
}
