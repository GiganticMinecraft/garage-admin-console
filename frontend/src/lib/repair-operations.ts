import type { RepairType, ScrubCommand } from '@/api'

// Labels and guidance for Garage repair operations, shared by the cluster-wide
// maintenance page (/repair) and the per-node page (/nodes/$id).

export const REPAIR_OPERATIONS: {
  value: Exclude<RepairType, { scrub: ScrubCommand }>
  label: string
  description: string
  when: string
  caution: string
  severity: 'low' | 'medium' | 'high'
}[] = [
  {
    value: 'blocks',
    label: 'ブロック整合性検証',
    description: 'レプリカが不足しているブロックを検出し、他のノードからコピーして再配置します。',
    when: 'ノードの追加・削除・ゾーン変更などのレイアウト変更を適用した後、ノード障害や交換の後に実行します。',
    caution: 'リシンクが自然に収まるまで数時間待ってから実行してください。',
    severity: 'medium',
  },
  {
    value: 'blockRc',
    label: 'ブロック参照カウント修復',
    description: 'ブロックの参照カウントを全て再計算し、不整合を修正します。',
    when: 'ログに参照カウント不整合の警告が出ているとき、ブロックエラーが減らないとき。',
    caution: '原因がブロック参照側にある場合は blockRefs も合わせて実行してください。',
    severity: 'medium',
  },
  {
    value: 'tables',
    label: 'テーブル修復',
    description: 'メタデータテーブルの全体同期を手動で実行します。',
    when: 'メタデータの同期がおかしいとき、大規模障害からの復旧時に限定して使います。',
    caution: '毎時の自動同期があるため、通常は不要です。',
    severity: 'medium',
  },
  {
    value: 'versions',
    label: 'バージョン修復',
    description: '親オブジェクトが存在しない孤立バージョンを検出し、削除済みにマークします。',
    when: '複数ノードの長時間停止後にオブジェクトの一覧や取得がおかしいとき。',
    caution: '通常運用では使いません。ストレージノード切断中に実行すると生きたバージョンを削除扱いにするため、全ストレージノード稼働・全パーティション揃いのときだけ実行できます。',
    severity: 'medium',
  },
  {
    value: 'blockRefs',
    label: 'ブロック参照修復',
    description: '親バージョンが存在しない孤立ブロック参照を検出し、削除済みにマークします。',
    when: '孤立した参照がブロックの GC を妨げているとき。',
    caution: 'versions や blockRc と合わせて判断してください。ストレージノード切断中に実行すると生きた参照を削除扱いにするため、全ストレージノード稼働・全パーティション揃いのときだけ実行できます。',
    severity: 'medium',
  },
  {
    value: 'rebalance',
    label: 'リバランス',
    description: 'ストレージ間のデータ配置を均等化します。',
    when: 'ディスクやノードの追加後、容量配分の変更後に実行します。',
    caution: '障害対応ではなく、構成変更後の後処理です。',
    severity: 'low',
  },
  {
    value: 'multipartUploads',
    label: 'マルチパートアップロード修復',
    description: '親バージョンが存在しないマルチパートアップロードのメタデータを削除済みにマークします。',
    when: 'マルチパートアップロード周りだけが異常なとき。',
    caution: '一般的な障害対応で使うことはほぼありません。',
    severity: 'low',
  },
  {
    value: 'aliases',
    label: 'エイリアス修復',
    description: 'バケットエイリアスの不整合を修正します。',
    when: 'バケット名でのアクセスだけが壊れているとき。',
    caution: '非常にまれな用途です。',
    severity: 'low',
  },
  {
    value: 'clearResyncQueue',
    label: 'リシンクキューのクリア',
    description: 'リシンクキューを強制的に空にします。キューに残っているブロックは全てスキップされます。',
    when: '喪失が確定したブロックを purge した後、キューが空にならないときの最終手段です。',
    caution: '先にブロックエラーページで原因を確認し、必要な purge を済ませてから使ってください。',
    severity: 'high',
  },
]

export const SCRUB_COMMANDS: { value: ScrubCommand; label: string; description: string }[] = [
  { value: 'start', label: '開始', description: '全ブロックのチェックサム検証を開始します。ディスク I/O が増加します。' },
  { value: 'pause', label: '一時停止', description: '実行中の Scrub を一時停止します。' },
  { value: 'resume', label: '再開', description: '一時停止中の Scrub を再開します。' },
  { value: 'cancel', label: 'キャンセル', description: '実行中の Scrub を中止します。' },
]
