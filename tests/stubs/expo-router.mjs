// The Node test runner loads application modules directly. `expo-router` ships a build that
// Node cannot evaluate outside Metro, so component tests get this minimal stand-in. It only
// needs the surface the app imports; navigation itself is never exercised by these tests.

export const router = {
  push() {}, replace() {}, back() {}, dismiss() {}, navigate() {}, prefetch() {}, canGoBack: () => false,
};

export function useRouter() { return router; }
export function usePathname() { return '/'; }
export function useSegments() { return []; }
export function useLocalSearchParams() { return {}; }
export function useGlobalSearchParams() { return {}; }

export function Link({ children }) { return children ?? null; }
export function Redirect() { return null; }
export function Slot({ children }) { return children ?? null; }
export function Stack({ children }) { return children ?? null; }
export function Tabs({ children }) { return children ?? null; }
export function Navigator({ children }) { return children ?? null; }
export const ExpoRoot = () => null;

/** `expo-router/head` resolves here too; page metadata is irrelevant to these tests. */
export default function Head() { return null; }
