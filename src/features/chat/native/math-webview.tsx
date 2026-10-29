import * as Clipboard from 'expo-clipboard';
import { useMemo, useState } from 'react';
import { Linking, StyleSheet, View } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';

import { useNativeTheme } from '@/theme/native-theme';
import { renderMessageHtml } from './message-html';

type Message = { type: 'height'; height: number } | { type: 'copy'; text: string };

function isExternal(url: string) {
  return /^https?:\/\//i.test(url);
}

/** A completed message containing math is rendered by one WebView, which gives us
    KaTeX's MathML output without pulling a DOM renderer into Hermes. Streaming messages
    stay plain text so the view is not remounted on every token. */
export function MathWebView({ markdown }: { markdown: string }) {
  const theme = useNativeTheme();
  const [height, setHeight] = useState(1);
  const source = useMemo(() => ({ html: renderMessageHtml(markdown, theme), baseUrl: 'about:blank' }), [markdown, theme]);

  function onMessage(event: WebViewMessageEvent) {
    let message: Message;
    try { message = JSON.parse(event.nativeEvent.data) as Message; } catch { return; }
    if (message.type === 'height' && Number.isFinite(message.height)) {
      setHeight(Math.max(1, Math.ceil(message.height)));
    } else if (message.type === 'copy' && typeof message.text === 'string') {
      void Clipboard.setStringAsync(message.text);
    }
  }

  return (
    <View style={[styles.container, { height }]}>
      <WebView
        source={source}
        style={styles.web}
        containerStyle={styles.web}
        originWhitelist={['*']}
        javaScriptEnabled
        scrollEnabled={false}
        setSupportMultipleWindows={false}
        onMessage={onMessage}
        onShouldStartLoadWithRequest={(request) => {
          if (!isExternal(request.url)) return true;
          void Linking.openURL(request.url).catch(() => {});
          return false;
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { width: '100%', overflow: 'hidden' },
  web: { flex: 1, backgroundColor: 'transparent' },
});
