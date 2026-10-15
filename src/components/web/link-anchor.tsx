import type { LinkProps } from 'expo-router';
import type { ComponentProps } from 'react';

type Props = ComponentProps<'a'> & Pick<LinkProps, 'onPress'>;

export function LinkAnchor(props: Props) {
  const anchorProps = { ...props };
  // Expo Router already handles Web navigation through onClick. Keep its
  // additional native onPress handler off the DOM without invoking it twice.
  delete anchorProps.onPress;
  return <a {...anchorProps} />;
}
