import {
  cloneElement, isValidElement, useEffect,
  type AnchorHTMLAttributes, type MouseEvent, type ReactElement,
} from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';

/**
 * The app's navigation surface. It mirrors the handful of Expo Router primitives the
 * screens were written against (`Link`, the imperative `router`, `Redirect`,
 * `usePathname`, `useLocalSearchParams`) on top of React Router, so features never
 * import the router library directly and tests can stub this module.
 */

/** An in-app path. React Router accepts the same string form. */
export type Href = string;

type Navigate = ReturnType<typeof useNavigate>;

/**
 * The router is only reachable from inside the router provider, while `router.push()`
 * is called from event handlers and async work. The bridge publishes it once effects
 * run, which is before any of those callbacks can fire.
 */
let navigate: Navigate | null = null;

/** Publishes the active router to the imperative helpers; rendered inside the router. */
export function RouterNavigationBridge() {
  const current = useNavigate();
  useEffect(() => {
    navigate = current;
    return () => { navigate = null; };
  }, [current]);
  return null;
}

export const router = {
  push(href: Href) {
    navigate?.(href);
  },
  replace(href: Href) {
    navigate?.(href, { replace: true });
  },
  back() {
    navigate?.(-1);
  },
};

export function usePathname(): string {
  return useLocation().pathname;
}

/** Query string values for the current page, matching Expo Router's object form. */
export function useLocalSearchParams<T extends Record<string, string | undefined> = Record<string, string | undefined>>(): T {
  const [params] = useSearchParams();
  const values: Record<string, string> = {};
  params.forEach((value, key) => { values[key] = value; });
  return values as T;
}

/** Skip the SPA navigation for anything the browser must handle itself. */
function isPlainNavigation(event: MouseEvent<HTMLAnchorElement>) {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey
    && !event.altKey && (!event.currentTarget.target || event.currentTarget.target === '_self');
}

type LinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> & {
  href: Href;
  replace?: boolean;
  /** Render the single child instead of an `<a>`, copying the navigation props onto it. */
  asChild?: boolean;
};

export function Link({ href, replace = false, asChild = false, onClick, children, ...rest }: LinkProps) {
  const navigate = useNavigate();
  const follow = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.defaultPrevented || !isPlainNavigation(event)) return;
    event.preventDefault();
    navigate(href, { replace });
  };
  if (asChild) {
    if (!isValidElement(children)) throw new Error('Link asChild requires a single element child.');
    const child = children as ReactElement<{ href?: string; onClick?: (event: MouseEvent<HTMLAnchorElement>) => void }>;
    return cloneElement(child, {
      href,
      onClick: (event: MouseEvent<HTMLAnchorElement>) => {
        child.props.onClick?.(event);
        follow(event);
      },
    });
  }
  return <a {...rest} href={href} onClick={(event) => { onClick?.(event); follow(event); }}>{children}</a>;
}

/** Navigates on mount, replacing the current entry so Back does not bounce. */
export function Redirect({ href, replace = true }: { href: Href; replace?: boolean }) {
  const navigate = useNavigate();
  useEffect(() => { navigate(href, { replace }); }, [href, navigate, replace]);
  return null;
}
