import { AlertTriangle } from 'lucide-react'
import type { LayoutApplyResult, LayoutPreview as LayoutPreviewResult } from '@/api'
import { Badge } from '@/components/ui/badge'
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table'
import { formatBytes } from '@/lib/format'
import { nodeDisplayName } from '@/lib/nodes'

function percent(part: number, total: number): string {
  if (!total) return '-'
  return `${((100 * part) / total).toFixed(1)}%`
}

interface LayoutPreviewProps {
  /** A PreviewClusterLayoutChanges or ApplyClusterLayout response. */
  result: LayoutPreviewResult | LayoutApplyResult
  /** Resolves a node ID to a display name (hostname when known). */
  nameOf: (id: string) => string
}

/**
 * Structured view of a layout computation (PreviewClusterLayoutChanges /
 * ApplyClusterLayout). Shows Garage's computation error when the staged
 * layout cannot be computed, and falls back to Garage's raw text when the
 * server does not return `statistics` (Garage < v2.4.0).
 */
export function LayoutPreview({ result, nameOf }: LayoutPreviewProps) {
  if ('error' in result) {
    return (
      <div className="flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        <div>
          <p className="font-medium">このステージ内容ではレイアウトを計算できません</p>
          <p className="whitespace-pre-wrap">{result.error}</p>
        </div>
      </div>
    )
  }
  const message = result.message ?? []
  const s = result.statistics
  if (!s) {
    return (
      <pre className="max-h-80 overflow-auto rounded bg-muted p-3 text-xs whitespace-pre-wrap">
        {message.join('\n')}
      </pre>
    )
  }

  const moved = s.totalMovedPartitions
  const warnings: string[] = []
  if (s.lowPartitionSize) {
    warnings.push(
      'パーティションサイズが非常に小さくなっています。各ノードの容量の単位 (バイト) が正しいか確認してください。',
    )
  }
  if (s.lowUsableCapacity) {
    warnings.push(
      `利用可能容量が総容量の ${percent(s.usableCapacity, s.totalCapacity)} しかありません。ゾーン構成や冗長性の制約で容量の小さいノード/ゾーンが律速になっている可能性があります。`,
    )
  }
  if (moved != null && moved > 0) {
    warnings.push(
      `${moved} 個のパーティションのコピーが新しいノードへ転送されます。適用後はリシンクが完了するまでクラスタの負荷が上がります。`,
    )
  }

  return (
    <div className="space-y-3">
      {warnings.length > 0 && (
        <div className="space-y-1 rounded-md border border-amber-400 bg-amber-100/60 p-3 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          {warnings.map((w) => (
            <p key={w} className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <span>{w}</span>
            </p>
          ))}
        </div>
      )}

      <dl className="grid grid-cols-2 gap-3 rounded-md border bg-background p-3 text-sm md:grid-cols-4">
        <div>
          <dt className="text-muted-foreground">レプリケーション</dt>
          <dd className="font-medium">
            {s.replicationFactor} 複製 / {s.effectiveZoneRedundancy} ゾーン以上
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">パーティションサイズ</dt>
          <dd className="font-medium">
            {s.previousPartitionSize != null && s.previousPartitionSize !== s.partitionSize && (
              <>
                <span className="text-muted-foreground">{formatBytes(s.previousPartitionSize)}</span>
                {' → '}
              </>
            )}
            {formatBytes(s.partitionSize)}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">利用可能 / 総容量</dt>
          <dd className="font-medium">
            {formatBytes(s.usableCapacity)} / {formatBytes(s.totalCapacity)}
            <span className="ml-1 text-xs text-muted-foreground">({percent(s.usableCapacity, s.totalCapacity)})</span>
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">実効容量</dt>
          <dd className="font-medium">{formatBytes(s.effectiveCapacity)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">移動するパーティション</dt>
          <dd className="font-medium">{moved ?? '-'}</dd>
        </div>
      </dl>

      <div className="overflow-x-auto rounded-md border bg-background">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>ゾーン</TableHead>
              <TableHead className="text-right">ユニークパーティション</TableHead>
              <TableHead className="text-right">複製パーティション</TableHead>
              <TableHead className="text-right">利用可能容量</TableHead>
              <TableHead className="text-right">総容量</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {s.zones.map((z) => (
              <TableRow key={z.name}>
                <TableCell className="font-medium">{z.name}</TableCell>
                <TableCell className="text-right">{z.uniquePartitions}</TableCell>
                <TableCell className="text-right">{z.totalReplicatedPartitions}</TableCell>
                <TableCell className="text-right">
                  {formatBytes(z.usableCapacity)}
                  <span className="ml-1 text-xs text-muted-foreground">({percent(z.usableCapacity, z.totalCapacity)})</span>
                </TableCell>
                <TableCell className="text-right">{formatBytes(z.totalCapacity)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <div className="overflow-x-auto rounded-md border bg-background">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>ノード</TableHead>
              <TableHead>ゾーン</TableHead>
              <TableHead>タグ</TableHead>
              <TableHead className="text-right">パーティション</TableHead>
              <TableHead className="text-right">利用可能容量</TableHead>
              <TableHead className="text-right">総容量</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {s.zones.flatMap((z) =>
              z.nodes.map((n) => (
                <TableRow key={n.id}>
                  <TableCell>
                    <div className="font-medium">{nameOf(n.id)}</div>
                    <div className="font-mono text-xs text-muted-foreground">{nodeDisplayName({ id: n.id, hostname: null })}</div>
                  </TableCell>
                  <TableCell>{z.name}</TableCell>
                  <TableCell>
                    {n.tags.length > 0
                      ? n.tags.map((t) => <Badge key={t} variant="outline" className="mr-1">{t}</Badge>)
                      : <span className="text-muted-foreground">-</span>}
                  </TableCell>
                  <TableCell className="text-right">
                    {n.storedPartitions}
                    {n.newPartitions > 0 && (
                      <Badge variant="secondary" className="ml-2">{n.newPartitions} New</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    {formatBytes(n.usableCapacity)}
                    <span className="ml-1 text-xs text-muted-foreground">({percent(n.usableCapacity, n.totalCapacity)})</span>
                  </TableCell>
                  <TableCell className="text-right">{formatBytes(n.totalCapacity)}</TableCell>
                </TableRow>
              )),
            )}
          </TableBody>
        </Table>
      </div>

      <details className="text-xs">
        <summary className="cursor-pointer text-muted-foreground">Garage の出力 (テキスト)</summary>
        <pre className="mt-2 max-h-80 overflow-auto rounded bg-muted p-3 whitespace-pre-wrap">{message.join('\n')}</pre>
      </details>
    </div>
  )
}
