import { RouterProvider, createRouter, Link, type ErrorComponentProps } from '@tanstack/react-router'
import { Button } from '@/components/ui/button'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { TooltipProvider } from '@/components/ui/tooltip'
import { routeTree } from './routeTree.gen'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
    },
  },
})

/**
 * Rendered in place of a page that threw during render, so an unexpected
 * response shape from Garage no longer blanks the whole console.
 */
function RouteErrorFallback({ error, reset }: ErrorComponentProps) {
  return (
    <div className="space-y-4 rounded-lg border border-destructive/40 p-6">
      <h1 className="text-xl font-bold">ページの表示中にエラーが発生しました</h1>
      <pre className="overflow-x-auto rounded bg-muted p-3 text-xs">
        {error instanceof Error ? error.message : String(error)}
      </pre>
      <div className="flex gap-2">
        <Button variant="outline" onClick={reset}>
          再試行
        </Button>
        <Button asChild variant="ghost">
          <Link to="/">ダッシュボードへ</Link>
        </Button>
      </div>
    </div>
  )
}

function RouteNotFound() {
  return (
    <div className="space-y-4 p-6 text-center">
      <h1 className="text-xl font-bold">ページが見つかりません</h1>
      <Button asChild variant="outline">
        <Link to="/">ダッシュボードへ</Link>
      </Button>
    </div>
  )
}

const router = createRouter({
  routeTree,
  defaultErrorComponent: RouteErrorFallback,
  defaultNotFoundComponent: RouteNotFound,
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <RouterProvider router={router} />
      </TooltipProvider>
    </QueryClientProvider>
  )
}

export default App
