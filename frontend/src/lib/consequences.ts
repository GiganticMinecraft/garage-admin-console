import type { RepairType } from '@/api'
import { formatBytes, formatCount } from '@/lib/format'

// 「何が起きるか」の箇条書き。破壊的操作の確認ダイアログ (ConfirmDialog の
// consequences) に渡す文言をここに集める。Garage v2.4.1 の Admin API の挙動
// (doc/api/garage-admin-v2.json の各 endpoint の説明) に合わせている。

/** バケット削除 (DeleteBucket)。 */
export function bucketDeleteConsequences(bucket: {
  globalAliases: string[]
  localAliases: unknown[]
  objects: number | null
  keyCount: number | null
}): string[] {
  const aliasCount = bucket.globalAliases.length + bucket.localAliases.length
  const out = [
    aliasCount > 0
      ? `このバケットのエイリアス ${aliasCount} 件 (グローバル ${bucket.globalAliases.length} / ローカル ${bucket.localAliases.length}) もすべて削除されます`
      : 'このバケットのエイリアスもすべて削除されます',
  ]
  if (bucket.keyCount != null && bucket.keyCount > 0) {
    out.push(`このバケットに権限を持つキー ${bucket.keyCount} 個からアクセス権が外れます`)
  }
  out.push(
    bucketHasObjects(bucket)
      ? `オブジェクトが ${formatCount(bucket.objects)} 件残っているため削除できません。先にバケットを空にしてください`
      : 'オブジェクトが残っていると削除できません',
  )
  return out
}

/** 一覧の統計でオブジェクトが残っているとわかる (null = 不明は false)。削除ボタンを止めるのに使う。 */
export function bucketHasObjects(bucket: { objects: number | null }): boolean {
  return bucket.objects != null && bucket.objects > 0
}

/**
 * アクセスキー削除 (DeleteKey)。bucketCount は一覧 API の値で、権限のあるバケットに
 * 加えてローカルエイリアスだけを持つバケットも数える (不明なら null)。
 */
export function keyDeleteConsequences(bucketCount: number | null): string[] {
  return [
    'このキーを使っている S3 クライアントは直ちに認証できなくなります',
    bucketCount == null
      ? 'このキーが持つすべてのバケットへの権限とローカルエイリアスが外れます'
      : bucketCount > 0
        ? `関連するバケット ${bucketCount} 個 (権限またはローカルエイリアス) から、このキーの権限とローカルエイリアスがすべて外れます`
        : '関連するバケット (権限またはローカルエイリアス) はありません',
    // Garage v2.4.1 の delete_key は purge_local_bucket_alias を使い、最後の
    // エイリアスかどうかを確かめない (RemoveBucketAlias とは違い拒否されない)。
    'ローカルエイリアスがバケット唯一の名前でも削除は拒否されません。バケット自体は削除されず、名前の無いまま残ります',
  ]
}

/** 管理トークン削除 (DeleteAdminToken)。isCurrent はコンソール自身のトークンか。 */
export function adminTokenDeleteConsequences(isCurrent: boolean): string[] {
  if (isCurrent) {
    return [
      'これはこのコンソール自身が Garage の操作に使っているトークンです',
      '削除した瞬間からこのコンソールは Garage を操作できなくなります',
      '復旧するには、別の管理トークンを発行してコンソールの設定 (GARAGE_ADMIN_TOKEN) を差し替える必要があります',
    ]
  }
  return ['このトークンを使っているクライアントは直ちに Admin API を呼べなくなります']
}

export type AliasRemoveTarget = {
  kind: 'global' | 'local'
  /** バケットに残る唯一のグローバルエイリアスで、ローカルエイリアスは残っている。 */
  lastGlobal: boolean
}

/**
 * エイリアス削除 (RemoveBucketAlias)。最後のエイリアスは Garage が拒否するため
 * 削除ボタン自体が無効になっており、ここには来ない。
 */
export function aliasRemoveConsequences(t: AliasRemoveTarget): string[] {
  const out = [
    t.kind === 'global'
      ? 'この名前ではどのキーからもバケットにアクセスできなくなります'
      : 'このキーからはこの名前でバケットにアクセスできなくなります',
  ]
  if (t.lastGlobal) {
    out.push('バケットのグローバルな名前が無くなり、ローカルエイリアスを持つキーからしか名前で参照できなくなります')
  }
  out.push('バケット本体とオブジェクト、キーの権限はそのまま残ります')
  return out
}

/**
 * キーのバケット権限の取り消し (DenyBucketKey で read / write / owner をすべて外す)。
 * localAliasCount はこのキーがこのバケットに持つローカルエイリアスの数。
 */
export function permissionRevokeConsequences(
  p: { read: boolean; write: boolean; owner: boolean },
  localAliasCount = 0,
): string[] {
  const flags = (['read', 'write', 'owner'] as const).filter((f) => p[f])
  const out = [
    `${flags.length > 0 ? flags.join(' / ') : 'すべての権限'} が外れ、このキーからこのバケットにアクセスできなくなります`,
  ]
  if (p.owner) out.push('owner が外れるため、このキーからバケット設定の変更やバケットの削除もできなくなります')
  if (localAliasCount > 0) {
    out.push(`このキーのローカルエイリアス ${localAliasCount} 件は残りますが、権限が無いためその名前でもアクセスできません`)
  }
  out.push('バケット本体とオブジェクトは削除されません')
  return out
}

/** オブジェクト 1 件の削除。 */
export function objectDeleteConsequences(): string[] {
  return ['オブジェクトは即座に削除されます。Garage にはバージョニングが無いため復元できません']
}

/** 選択したオブジェクトの一括削除。 */
export function bulkObjectDeleteConsequences(count: number): string[] {
  return [
    `選択した ${formatCount(count)} 件のオブジェクトが削除されます。Garage にはバージョニングが無いため復元できません`,
    '一部だけ失敗した場合、失敗したオブジェクトは残ります',
  ]
}

/** プレフィックス以下の削除。 */
export function prefixDeleteConsequences(p: {
  prefix: string
  count: number
  bytes: number
  truncated: boolean
}): string[] {
  if (p.count === 0) return []
  const more = p.truncated ? ' 以上' : ''
  const out = [
    `「${p.prefix}」で始まる ${formatCount(p.count)} 件${p.truncated ? '以上' : ''}のオブジェクト (${formatBytes(p.bytes)}${more}) が削除されます`,
    'サブフォルダ内のオブジェクトも含まれます',
  ]
  if (p.truncated) out.push('1 回の操作で削除できるのは上限件数までです。残りは再度実行してください')
  return out
}

/** ブロックの purge (PurgeBlocks)。 */
export function blockPurgeConsequences(count: number): string[] {
  return [
    `選択した ${formatCount(count)} 件のブロックを含むオブジェクトと進行中のマルチパートアップロードが、それぞれのバケットから完全に削除されます`,
    'オブジェクトからもこれらのブロックへの参照が消え、ブロックエラーの一覧からも外れます',
    'ブロックが別のノードに残っていても復旧には使われなくなります。喪失が確定したブロックだけを purge してください',
  ]
}

/** リシンクキューのクリア (ClearResyncQueue)。 */
export function clearResyncQueueConsequences(): string[] {
  return [
    'リシンクキューに残っているブロックはすべてスキップされます',
    '不足しているレプリカは、次に「ブロック整合性検証」を実行するまで補われません',
  ]
}

/** Scrub のキャンセル。 */
export function scrubCancelConsequences(): string[] {
  return [
    '実行中または一時停止中の Scrub が中止され、途中経過 (チェックポイント) は破棄されます',
    '次に開始すると最初のブロックから検証し直します。最終完了日時は更新されません',
  ]
}

/**
 * 修復操作 (LaunchRepairOperation) のうち、結果を戻せないものの箇条書き。
 * 該当しない操作は undefined (ダイアログは説明文だけ出す)。
 */
export function repairConsequences(repairType: RepairType): string[] | undefined {
  if (repairType === 'clearResyncQueue') return clearResyncQueueConsequences()
  if (typeof repairType === 'object' && repairType.scrub === 'cancel') return scrubCancelConsequences()
  return undefined
}

/** レイアウトの適用 (ApplyClusterLayout)。 */
export function layoutApplyConsequences(version: number): string[] {
  return [
    `レイアウト v${version} がクラスタの現在のレイアウトになり、パーティションの再配置が始まります`,
    '再配置が終わるまでクラスタの負荷が上がり、データブロックのリシンクには数時間かかることがあります',
    '適用後に元へ戻す操作はありません。戻すには元の構成をステージし直して再度適用します',
  ]
}

/** ステージ中のレイアウト変更の取り消し (RevertClusterLayout)。 */
export function layoutRevertConsequences(): string[] {
  return [
    'ステージ中のロール変更とパラメータ変更がすべて破棄されます',
    '適用済みのレイアウトには影響しません',
  ]
}

/** Website access の無効化。ruleCount はルーティングルール数。 */
export function websiteDisableConsequences(ruleCount: number): string[] {
  return [
    'Website エンドポイントからこのバケットを配信しなくなります',
    'インデックス / エラードキュメントの設定が破棄されます',
    ruleCount > 0
      ? `ルーティングルール ${ruleCount} 件も破棄されます`
      : 'ルーティングルールの設定も破棄されます',
    '再度有効にしても元の設定には戻りません',
  ]
}

/** メタデータスナップショットの作成 (CreateMetadataSnapshot)。 */
export function metadataSnapshotConsequences(allNodes: boolean): string[] {
  return [
    `${allNodes ? '全ノード' : 'このノード'}で完了までディスク I/O が増え、メタデータディレクトリの容量を消費します`,
    '各ノードに残るスナップショットは最新 2 世代までで、それより古いものは自動で削除されます',
  ]
}

/** worker 変数を全ノードに適用 (SetWorkerVariable, node="*")。 */
export function workerVariableAllNodesConsequences(variable: string, value: string): string[] {
  return [
    `クラスタの全ノードで ${variable} が ${value} に変更され、ノードごとの現在値は上書きされます`,
    '変更は即座に反映され、ノードの再起動後も保持されます',
    '応答しなかったノードには適用されません (結果の通知で失敗ノードを確認してください)',
  ]
}
