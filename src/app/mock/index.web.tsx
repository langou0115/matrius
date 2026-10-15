import { Redirect } from 'expo-router';

export default function MockIndexRoute() {
  return <Redirect href={__DEV__ ? '/mock/chat' : '/'} />;
}
