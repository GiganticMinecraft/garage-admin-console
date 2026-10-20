import { useQuery } from '@tanstack/react-query'
import { getConsoleScope } from '@/api'

/**
 * The Admin API endpoints the console backend calls. The list is fixed per
 * backend build, so it is fetched once per page load.
 */
export function useConsoleScope() {
  return useQuery({
    queryKey: ['console-scope'],
    queryFn: getConsoleScope,
    staleTime: Infinity,
  })
}
