import { useMemo, useSyncExternalStore } from 'react'
import EChartsReactCore from 'echarts-for-react/lib/core'
import * as echarts from 'echarts/core'
import { PieChart, BarChart } from 'echarts/charts'
import { TooltipComponent, GridComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import type { ClusterNode, PartitionUsage } from '@/api'
import { useChartChrome, type PartitionKind } from '@/lib/chart-theme'
import { clampUsed, formatBytes, formatUsage, usagePercent } from '@/lib/format'
import { nodeDisplayName } from '@/lib/nodes'
import { USAGE_CRIT, USAGE_WARN } from '@/lib/thresholds'

echarts.use([PieChart, BarChart, TooltipComponent, GridComponent, CanvasRenderer])

// echarts-for-react/lib/core is CJS with { default: Component }.
// ESM default import resolves to the wrapper object, not the component itself.
const ReactEChartsCore = ('default' in EChartsReactCore
  ? (EChartsReactCore as unknown as { default: typeof EChartsReactCore }).default
  : EChartsReactCore) as typeof EChartsReactCore

// One hue per partition kind (the same blue / purple as the node table's
// bars): the used part is the saturated step of that hue, free space a
// theme-dependent secondary step (lib/chart-theme.ts). At or above the
// thresholds the used colour switches to a status colour so the chart
// signals pressure, not only magnitude.
const USED: Record<PartitionKind, string> = {
  data: '#3b82f6', // blue-500
  meta: '#a855f7', // purple-500
}
const WARN_COLOR = '#f59e0b' // amber-500
const CRIT_COLOR = '#ef4444' // red-500
const WARN_PERCENT = USAGE_WARN * 100
const CRIT_PERCENT = USAGE_CRIT * 100

// Chart chrome (axis / label text, grid, the surface-coloured edge that leaves
// a gap between touching segments, tooltip box) follows the colour theme and
// never uses the series colour; see lib/chart-theme.ts.
const LABEL_FONT_SIZE = 12
// Below Tailwind's `sm` breakpoint the bars drop their end labels (the
// tooltip still carries the numbers) so the bars keep usable width.
const NARROW_QUERY = '(max-width: 639px)'

const TITLES: Record<PartitionKind, string> = {
  data: 'データパーティション',
  meta: 'メタデータパーティション',
}

function usedColor(kind: PartitionKind, percent: number): string {
  if (percent >= CRIT_PERCENT) return CRIT_COLOR
  if (percent >= WARN_PERCENT) return WARN_COLOR
  return USED[kind]
}

interface Usage {
  used: number
  free: number
  total: number
  percent: number
}

function toUsage(used: number, total: number): Usage {
  const u = clampUsed(used, total)
  return { used: u, free: Math.max(total - u, 0), total, percent: usagePercent(u, total) }
}

function partitionUsage(p: PartitionUsage): Usage {
  return toUsage(p.total - p.available, p.total)
}

// Tooltips are rendered as HTML; hostnames come from the cluster and must not
// be interpreted as markup.
function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  )
}

function usageTooltip(title: string, u: Usage): string {
  return [
    `<b>${escapeHtml(title)}</b>`,
    `使用中: ${formatBytes(u.used)} (${u.percent.toFixed(1)}%)`,
    `空き: ${formatBytes(u.free)}`,
    `合計: ${formatBytes(u.total)}`,
  ].join('<br/>')
}

/** Rough rendered width of a label in px (CJK glyphs are about twice as wide). */
function textWidth(s: string): number {
  let w = 0
  for (const ch of s) w += ch.charCodeAt(0) > 0xff ? LABEL_FONT_SIZE : LABEL_FONT_SIZE * 0.6
  return Math.ceil(w)
}

function subscribeNarrow(onChange: () => void): () => void {
  const mql = window.matchMedia(NARROW_QUERY)
  mql.addEventListener('change', onChange)
  return () => mql.removeEventListener('change', onChange)
}

function useNarrow(): boolean {
  return useSyncExternalStore(
    subscribeNarrow,
    () => window.matchMedia(NARROW_QUERY).matches,
    () => false,
  )
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

/** Cluster-wide donut for one partition kind, with the usage in its centre. */
function UsageDonut({ kind, u }: { kind: PartitionKind; u: Usage }) {
  const chrome = useChartChrome()
  const color = usedColor(kind, u.percent)
  const option = useMemo(
    () => ({
      tooltip: {
        ...chrome.tooltip,
        trigger: 'item' as const,
        formatter: () => usageTooltip(TITLES[kind], u),
      },
      series: [
        {
          name: TITLES[kind],
          type: 'pie' as const,
          radius: ['64%', '88%'],
          label: { show: false },
          labelLine: { show: false },
          emphasis: { scale: false },
          itemStyle: { borderColor: chrome.surface, borderWidth: 2 },
          data: [
            { value: u.used, name: '使用中', itemStyle: { color: usedColor(kind, u.percent) } },
            { value: u.free, name: '空き', itemStyle: { color: chrome.free[kind] } },
          ],
        },
      ],
    }),
    [kind, u, chrome],
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
        <Swatch color={chrome.free[kind]} label="空き" />
      </div>
    </div>
  )
}

/** One horizontal used + free stacked bar per node, on the panel's own scale. */
function NodePanel({ kind, nodes, narrow }: { kind: PartitionKind; nodes: MeasuredNode[]; narrow: boolean }) {
  const chrome = useChartChrome()
  const option = useMemo(() => {
    const rows = nodes.map((n) => ({ name: n.name, u: n[kind], label: formatUsage(n[kind].used, n[kind].total) }))
    const maxTotal = Math.max(0, ...rows.map((r) => r.u.total))
    // Reserve exactly the room the longest end-of-bar label needs.
    const labelRoom = narrow ? 12 : Math.max(0, ...rows.map((r) => textWidth(r.label))) + 16
    const rowAt = (p: { dataIndex: number }) => rows[p.dataIndex]
    return {
      tooltip: {
        ...chrome.tooltip,
        trigger: 'item' as const,
        confine: true,
        formatter: (p: { dataIndex: number }) => {
          const r = rowAt(p)
          return r ? usageTooltip(r.name, r.u) : ''
        },
      },
      grid: { left: 8, right: labelRoom, top: 4, bottom: 4, containLabel: true },
      xAxis: {
        type: 'value' as const,
        max: maxTotal > 0 ? maxTotal : undefined,
        splitNumber: narrow ? 2 : 3,
        axisLabel: { color: chrome.axisText, formatter: (v: number) => formatBytes(v) },
        splitLine: { lineStyle: { color: chrome.gridLine } },
      },
      yAxis: {
        type: 'category' as const,
        inverse: true,
        data: rows.map((r) => r.name),
        axisTick: { show: false },
        axisLine: { show: false },
        axisLabel: { color: chrome.axisText, width: narrow ? 88 : 140, overflow: 'truncate' as const },
      },
      series: [
        {
          name: '使用中',
          type: 'bar' as const,
          stack: 'usage',
          barMaxWidth: 18,
          data: rows.map((r) => ({
            value: r.u.used,
            itemStyle: { color: usedColor(kind, r.u.percent), borderColor: chrome.surface, borderWidth: 1 },
          })),
        },
        {
          name: '空き',
          type: 'bar' as const,
          stack: 'usage',
          barMaxWidth: 18,
          itemStyle: {
            color: chrome.free[kind],
            borderColor: chrome.surface,
            borderWidth: 1,
            borderRadius: [0, 4, 4, 0],
          },
          label: {
            show: !narrow,
            position: 'right' as const,
            color: chrome.labelText,
            fontSize: LABEL_FONT_SIZE,
            formatter: (p: { dataIndex: number }) => rowAt(p)?.label ?? '',
          },
          data: rows.map((r) => r.u.free),
        },
      ],
    }
  }, [kind, nodes, narrow, chrome])

  return (
    <div className="rounded-lg border p-4">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium text-muted-foreground">{TITLES[kind]} (ノード別)</h3>
        <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          <Swatch color={USED[kind]} label="使用中" />
          <Swatch color={chrome.free[kind]} label="空き" />
        </div>
      </div>
      <ReactEChartsCore echarts={echarts} option={option} style={{ height: 40 + nodes.length * 36 }} />
    </div>
  )
}

export default function StorageCharts({ nodes: allNodes }: { nodes: ClusterNode[] }) {
  const narrow = useNarrow()
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
  const unreported = allNodes.length - nodes.length

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
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">ストレージ使用状況</h2>
        <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          <span>使用率</span>
          <Swatch color={WARN_COLOR} label={`${WARN_PERCENT}% 以上`} />
          <Swatch color={CRIT_COLOR} label={`${CRIT_PERCENT}% 以上`} />
        </div>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <div className="rounded-lg border p-4 md:row-span-2">
          <h3 className="mb-4 text-sm font-medium text-muted-foreground">全体使用率</h3>
          <div className="grid gap-6 sm:grid-cols-2 md:grid-cols-1 xl:grid-cols-2">
            <UsageDonut kind="data" u={totals.data} />
            <UsageDonut kind="meta" u={totals.meta} />
          </div>
          {unreported > 0 && (
            <p className="mt-4 text-center text-xs text-muted-foreground">
              {unreported} ノードは情報なしのため合計に含まれていません
            </p>
          )}
        </div>
        <NodePanel kind="data" nodes={nodes} narrow={narrow} />
        <NodePanel kind="meta" nodes={nodes} narrow={narrow} />
      </div>
    </div>
  )
}
