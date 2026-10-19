/**
 * useQuery options for pages that auto-refresh every 30 s (workers,
 * maintenance). Polling pauses while the tab is hidden, like the dashboard.
 */
export const PAGE_POLLING = {
  refetchInterval: 30_000,
  refetchIntervalInBackground: false,
} as const
