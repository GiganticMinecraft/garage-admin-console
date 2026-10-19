/** useQuery options that refetch every `ms`, pausing while the tab is hidden. */
export function pollEvery(ms: number) {
  return { refetchInterval: ms, refetchIntervalInBackground: false } as const
}

/** 30 s auto-refresh for the workers and maintenance pages. */
export const PAGE_POLLING = pollEvery(30_000)
