import { useMemo } from 'react'
import EChartsReactCore from 'echarts-for-react/lib/core'
import * as echarts from 'echarts/core'
import { PieChart, BarChart } from 'echarts/charts'
import { TooltipComponent, GridComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import type { ClusterNode, PartitionUsage } from '@/api'
import { formatBytes } from '@/lib/format'
import { nodeDisplayName } from '@/lib/nodes'
import { USAGE_CRIT, USAGE_WARN } from '@/lib/thresholds'

echarts.use([PieChart, BarChart, TooltipComponent, GridComponent, CanvasRenderer])

// echarts-for-react/lib/core is CJS with { default: Component }.
// ESM default import resolves to the wrapper object, not the component itself.
const ReactEChartsCore = ('default' in EChartsReactCore
  ? (EChartsReactCore as unknown as { default: typeof EChartsReactCore }).default
  : EChartsReactCore) as typeof EChartsReactCore

// One hue per partition kind (the same blue / purple as the node table's
// bars): the used part is the saturated step, free space the light step of
// that hue. At or above the thresholds the used colour switches to a status
// colour so the chart signals pressure, not only magnitude.
type PartitionKind = 'data' | 'meta'

const PALETTE: Record<PartitionKind, { used: string; free: string }> = {
  data: { used: '#3b82f6', free: '#bfdbfe' }, // blue-500 / blue-200
  meta: { used: '#a855f7', free: '#e9d5ff' }, // purple-500 / purple-200
}
const WARN_COLOR = '#f59e0b' // amber-500
const CRIT_COLOR = '#ef4444' // red-500
const WARN_PERCENT = USAGE_WARN * 100
const CRIT_PERCENT = USAGE_CRIT * 100

// Chart chrome uses neutral text colours, never the series colour.
const AXIS_TEXT = '#71717a' // zinc-500
const LABEL_TEXT = '#52525b' // zinc-600
const GRID_LINE = 'rgba(113, 113, 122, 0.2)'
// Surface-coloured edge that leaves a 2px gap between touching segments.
const SURFACE = '#ffffff'

const TITLES: Record<PartitionKind, string> = {
  data: 'データパーティション',
  meta: 'メタデータパーティション',
}

function usedColor(kind: PartitionKind, percent: number): string {
  if (percent >= CRIT_PERCENT) return CRIT_COLOR
  if (percent >= WARN_PERCENT) return WARN_COLOR
  return PALETTE[kind].used
}

interface Usage {
  used: number
  free: number
  total: number
  percent: number
}

function toUsage(used: number, total: number): Usage {
  return { used, free: Math.max(total - used, 0), total, percent: total > 0 ? (used / total) * 100 : 0 }
}

function partitionUsage(p: PartitionUsage): Usage {
  return toUsage(Math.max(p.total - p.available, 0), p.total)
}

function usageLabel(u: Usage): string {
  return `${formatBytes(u.used)} / ${formatBytes(u.total)} (${u.percent.toFixed(1)}%)`
}

function usageTooltip(title: string, u: Usage, approx = false): string {
  return [
    `<b>${title}</b>`,
    `使用中: ${formatBytes(u.used)} (${u.percent.toFixed(1)}%)`,
    `空き: ${approx ? '~' : ''}${formatBytes(u.free)}`,
    `合計: ${formatBytes(u.total)}`,
  ].join('<br/>')
}

interface MeasuredNode {
  name: string
  data: Usage
  meta: Usage
}

function Swatch({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: color }} />
      {label}
    </span>
  )
}

function ThresholdLegend() {
  return (
    <span className="inline-flex items-center gap-3">
      <Swatch color={WARN_COLOR} label={`${WARN_PERCENT}% 以上`} />
      <Swatch color={CRIT_COLOR} label={`${CRIT_PERCENT}% 以上`} />
    </span>
  )
}

/** Cluster-wide donut for one partition kind, with the usage in its centre. */
function UsageDonut({ kind, u, approx }: { kind: PartitionKind; u: Usage; approx: boolean }) {
  const color = usedColor(kind, u.percent)
  const option = useMemo(
    () => ({
      tooltip: {
        trigger: 'item' as const,
        formatter: () => usageTooltip(TITLES[kind], u, approx),
      },
      series: [
        {
          name: TITLES[kind],
          type: 'pie' as const,
          radius: ['64%', '88%'],
          label: { show: false },
          labelLine: { show: false },
          emphasis: { scale: false },
          itemStyle: { borderColor: SURFACE, borderWidth: 2 },
          data: [
            { value: u.used, name: '使用中', itemStyle: { color } },
            { value: u.free, name: '空き', itemStyle: { color: PALETTE[kind].free } },
          ],
        },
      ],
    }),
    [kind, u, approx, color],
  )

  return (
    <div className="flex flex-col items-center gap-2">
      <h4 className="text-sm font-medium">{TITLES[kind]}</h4>
      <div className="relative h-44 w-44">
        <ReactEChartsCore echarts={echarts} option={option} style={{ height: '100%', width: '100%' }} />
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-2xl font-semibold tabular-nums">{u.percent.toFixed(1)}%</span>
          <span className="text-xs tabular-nums text-muted-foreground">
            {formatBytes(u.used)} / {formatBytes(u.total)}
          </span>
        </div>
      </div>
      <div className="flex flex-wrap justify-center gap-3 text-xs text-muted-foreground">
        <Swatch color={color} label="使用中" />
        <Swatch color={PALETTE[kind].free} label={approx ? '空き (~ 推定値)' : '空き'} />
      </div>
    </div>
  )
}

/** One horizontal used + free stacked bar per node, on the panel's own scale. */
function NodePanel({ kind, nodes }: { kind: PartitionKind; nodes: MeasuredNode[] }) {
  const option = useMemo(() => {
    const rows = nodes.map((n) => ({ name: n.name, u: n[kind] }))
    const maxTotal = Math.max(0, ...rows.map((r) => r.u.total))
    const rowAt = (p: { dataIndex: number }) => rows[p.dataIndex]
    return {
      tooltip: {
        trigger: 'item' as const,
        formatter: (p: { dataIndex: number }) => {
          const r = rowAt(p)
          return r ? usageTooltip(r.name, r.u) : ''
        },
      },
      // The right margin reserves room for the end-of-bar label.
      grid: { left: 8, right: 180, top: 4, bottom: 4, containLabel: true },
      xAxis: {
        type: 'value' as const,
        max: maxTotal > 0 ? maxTotal : undefined,
        splitNumber: 3,
        axisLabel: { color: AXIS_TEXT, formatter: (v: number) => formatBytes(v) },
        splitLine: { lineStyle: { color: GRID_LINE } },
      },
      yAxis: {
        type: 'category' as const,
        inverse: true,
        data: rows.map((r) => r.name),
        axisTick: { show: false },
        axisLine: { show: false },
        axisLabel: { color: AXIS_TEXT, width: 140, overflow: 'truncate' as const },
      },
      series: [
        {
          name: '使用中',
          type: 'bar' as const,
          stack: 'usage',
          barMaxWidth: 18,
          data: rows.map((r) => ({
            value: r.u.used,
            itemStyle: { color: usedColor(kind, r.u.percent), borderColor: SURFACE, borderWidth: 1 },
          })),
        },
        {
          name: '空き',
          type: 'bar' as const,
          stack: 'usage',
          barMaxWidth: 18,
          itemStyle: {
            color: PALETTE[kind].free,
            borderColor: SURFACE,
            borderWidth: 1,
            borderRadius: [0, 4, 4, 0],
          },
          label: {
            show: true,
            position: 'right' as const,
            color: LABEL_TEXT,
            formatter: (p: { dataIndex: number }) => {
              const r = rowAt(p)
              return r ? usageLabel(r.u) : ''
            },
          },
          data: rows.map((r) => r.u.free),
        },
      ],
    }
  }, [kind, nodes])

  return (
    <div className="rounded-lg border p-4">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium text-muted-foreground">{TITLES[kind]} (ノード別)</h3>
        <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          <Swatch color={PALETTE[kind].used} label="使用中" />
          <Swatch color={PALETTE[kind].free} label="空き" />
          <ThresholdLegend />
        </div>
      </div>
      <ReactEChartsCore echarts={echarts} option={option} style={{ height: 40 + nodes.length * 36 }} />
    </div>
  )
}

export default function StorageCharts({
  nodes: allNodes,
  incompleteAvailInfo = false,
}: {
  nodes: ClusterNode[]
  /** GetClusterStatistics.incompleteAvailInfo: some nodes did not report free space. */
  incompleteAvailInfo?: boolean
}) {
  // Nodes that are down or have no role report null partitions; chart only
  // the ones that actually have numbers.
  const nodes = useMemo<MeasuredNode[]>(
    () =>
      allNodes.flatMap((n) =>
        n.dataPartition && n.metadataPartition
          ? [
              {
                name: nodeDisplayName(n),
                data: partitionUsage(n.dataPartition),
                meta: partitionUsage(n.metadataPartition),
              },
            ]
          : [],
      ),
    [allNodes],
  )

  const totals = useMemo(() => {
    const sum = (kind: PartitionKind) =>
      toUsage(
        nodes.reduce((s, n) => s + n[kind].used, 0),
        nodes.reduce((s, n) => s + n[kind].total, 0),
      )
    return { data: sum('data'), meta: sum('meta') }
  }, [nodes])

  if (nodes.length === 0) {
    return (
      <div className="space-y-3">
        <h2 className="text-lg font-semibold">ストレージ使用状況</h2>
        <p className="text-sm text-muted-foreground">ストレージ情報を報告しているノードがありません</p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <h2 className="text-lg font-semibold">ストレージ使用状況</h2>
      <div className="grid gap-4 md:grid-cols-2">
        <div className="rounded-lg border p-4 md:row-span-2">
          <h3 className="mb-4 text-sm font-medium text-muted-foreground">全体使用率</h3>
          <div className="grid gap-6 sm:grid-cols-2 md:grid-cols-1 xl:grid-cols-2">
            <UsageDonut kind="data" u={totals.data} approx={incompleteAvailInfo} />
            <UsageDonut kind="meta" u={totals.meta} approx={incompleteAvailInfo} />
          </div>
          <div className="mt-4 flex justify-center text-xs text-muted-foreground">
            <ThresholdLegend />
          </div>
          {incompleteAvailInfo && (
            <p className="mt-2 text-center text-xs text-muted-foreground">
              ~ 推定値: 一部のノードが空き容量を報告していないため、実際の空き容量とは異なる可能性があります
            </p>
          )}
        </div>
        <NodePanel kind="data" nodes={nodes} />
        <NodePanel kind="meta" nodes={nodes} />
      </div>
    </div>
  )
}
