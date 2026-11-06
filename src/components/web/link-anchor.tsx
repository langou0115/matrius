import type { ComponentProps } from 'react';

/** The DOM anchor `<Link asChild>` decorates with its href and navigation handler. */
export function LinkAnchor(props: ComponentProps<'a'>) {
  return <a {...props} />;
}
