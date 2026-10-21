/** Capabilities come exclusively from the authenticated server response. */
export function hasFeature(user: { mustChangePassword: boolean; features: readonly string[] } | null, feature: string) {
  return Boolean(user && !user.mustChangePassword && user.features.includes(feature));
}
