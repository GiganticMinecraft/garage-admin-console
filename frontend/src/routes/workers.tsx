import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { listWorkers } from '@/api'
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'

export const Route = createFileRoute('/workers')({
  component: WorkersPage,
})

function WorkersPage() {
  const { data: workers, isLoading, isError } = useQuery({
    queryKey: ['workers'],
    queryFn: listWorkers,
  })

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">ワーカー</h1>

      {isLoading ? (
        <p className="text-muted-foreground">読み込み中...</p>
      ) : isError ? (
        <p className="text-destructive">ワーカーの読み込みに失敗しました</p>
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/50">
                <TableHead>名前</TableHead>
                <TableHead>状態</TableHead>
                <TableHead>詳細</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {workers?.map((worker, i) => (
                <TableRow key={i}>
                  <TableCell className="font-medium">
                    {String(worker.name ?? '-')}
                  </TableCell>
                  <TableCell>
                    {worker.state === 'idle' ? (
                      <Badge variant="secondary">idle</Badge>
                    ) : worker.state === 'busy' ? (
                      <Badge>busy</Badge>
                    ) : (
                      <Badge variant="outline">{String(worker.state ?? 'unknown')}</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    <div className="max-h-40 overflow-auto">
                      <pre className="text-xs">
                        {JSON.stringify(worker, null, 2)}
                      </pre>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {workers?.length === 0 && (
                <TableRow>
                  <TableCell colSpan={3} className="px-4 py-8 text-center text-muted-foreground">
                    ワーカーがありません
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  )
}
