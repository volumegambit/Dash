// Re-exported from @dash/paths, which owns all on-disk path resolution. Kept
// here so existing `@dash/mc` consumers (and its public index export) continue
// to resolve `getPlatformDataDir` without a breaking import change.
export { getPlatformDataDir } from '@dash/paths';
