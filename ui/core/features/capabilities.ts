/** Capabilities are supplied by the instance. */
export function hasFeature(info: { features: readonly string[] } | null, feature: string) {
  return Boolean(info?.features.includes(feature));
}
