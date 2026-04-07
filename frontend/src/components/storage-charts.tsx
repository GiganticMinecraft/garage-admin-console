import { useMemo } from 'react'
import ReactEChartsCore from 'echarts-for-react/lib/core'
import * as echarts from 'echarts/core'
import { PieChart, BarChart } from 'echarts/charts'
import { TooltipComponent, LegendComponent, GridComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import type { ClusterNode } from '@/api'

echarts.use([PieChart, BarChart, TooltipComponent, LegendComponent, GridComponent, CanvasRenderer])

function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let value = bytes
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i++
  }
  return `${value.toFixed(1)} ${units[i]}`
}

export default function StorageCharts({ nodes }: { nodes: ClusterNode[] }) {
  const pieOption = useMemo(() => {
    const totalData = nodes.reduce((sum, n) => sum + n.dataPartition.total, 0)
    const usedData = nodes.reduce((sum, n) => sum + (n.dataPartition.total - n.dataPartition.available), 0)
    const totalMeta = nodes.reduce((sum, n) => sum + n.metadataPartition.total, 0)
    const usedMeta = nodes.reduce((sum, n) => sum + (n.metadataPartition.total - n.metadataPartition.available), 0)

    return {
      tooltip: { trigger: 'item' as const, formatter: '{b}: {c} ({d}%)' },
      legend: { bottom: 0 },
      series: [
        {
          name: 'データ',
          type: 'pie' as const,
          radius: ['40%', '65%'],
          center: ['25%', '45%'],
          data: [
            { value: usedData, name: `使用中 (${formatBytes(usedData)})` },
            { value: totalData - usedData, name: `空き (${formatBytes(totalData - usedData)})` },
          ],
          itemStyle: { borderRadius: 4 },
          label: { show: false },
          emphasis: { label: { show: true } },
        },
        {
          name: 'メタデータ',
          type: 'pie' as const,
          radius: ['40%', '65%'],
          center: ['75%', '45%'],
          data: [
            { value: usedMeta, name: `使用中 (${formatBytes(usedMeta)})` },
            { value: totalMeta - usedMeta, name: `空き (${formatBytes(totalMeta - usedMeta)})` },
          ],
          itemStyle: { borderRadius: 4 },
          label: { show: false },
          emphasis: { label: { show: true } },
        },
      ],
    }
  }, [nodes])

  const barOption = useMemo(() => ({
    tooltip: {
      trigger: 'axis' as const,
      formatter: (params: Array<{ seriesName: string; name: string; value: number }>) =>
        params.map((p) => `${p.seriesName}: ${formatBytes(p.value)}`).join('<br/>'),
    },
    legend: { bottom: 0 },
    grid: { left: 60, right: 20, top: 20, bottom: 40 },
    xAxis: {
      type: 'category' as const,
      data: nodes.map((n) => n.hostname),
      axisLabel: { rotate: nodes.length > 4 ? 30 : 0 },
    },
    yAxis: {
      type: 'value' as const,
      axisLabel: { formatter: (v: number) => formatBytes(v) },
    },
    series: [
      {
        name: 'データ使用量',
        type: 'bar' as const,
        stack: 'data',
        data: nodes.map((n) => n.dataPartition.total - n.dataPartition.available),
        color: '#3b82f6',
      },
      {
        name: 'データ空き',
        type: 'bar' as const,
        stack: 'data',
        data: nodes.map((n) => n.dataPartition.available),
        color: '#93c5fd',
      },
      {
        name: 'メタデータ使用量',
        type: 'bar' as const,
        stack: 'meta',
        data: nodes.map((n) => n.metadataPartition.total - n.metadataPartition.available),
        color: '#8b5cf6',
      },
      {
        name: 'メタデータ空き',
        type: 'bar' as const,
        stack: 'meta',
        data: nodes.map((n) => n.metadataPartition.available),
        color: '#c4b5fd',
      },
    ],
  }), [nodes])

  return (
    <div className="space-y-3">
      <h2 className="text-lg font-semibold">ストレージ使用状況</h2>
      <div className="grid gap-4 md:grid-cols-2">
        <div className="rounded-lg border p-4">
          <h3 className="text-sm font-medium text-muted-foreground mb-2">全体使用率</h3>
          <ReactEChartsCore echarts={echarts} option={pieOption} style={{ height: 240 }} />
          <div className="flex justify-around text-xs text-muted-foreground mt-1">
            <span>データ</span>
            <span>メタデータ</span>
          </div>
        </div>
        <div className="rounded-lg border p-4">
          <h3 className="text-sm font-medium text-muted-foreground mb-2">ノード別使用量</h3>
          <ReactEChartsCore echarts={echarts} option={barOption} style={{ height: 260 }} />
        </div>
      </div>
    </div>
  )
}
