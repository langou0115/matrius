// The Node test runner loads application modules directly. React Router needs a
// mounted router for its hooks, and these component tests never navigate, so they
// get this minimal stand-in for `@/router` instead of the real navigation surface.

export const router = { push() {}, replace() {}, back() {} };

export function RouterNavigationBridge() { return null; }
export function usePathname() { return '/'; }
export function useLocalSearchParams() { return {}; }
export function Link({ children }) { return children ?? null; }
export function Redirect() { return null; }
