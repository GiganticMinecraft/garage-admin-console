import { describe, expect, it } from 'vitest'
import {
  adminTokenDeleteConsequences,
  aliasRemoveConsequences,
  blockPurgeConsequences,
  bucketDeleteConsequences,
  bucketHasObjects,
  bulkObjectDeleteConsequences,
  clearResyncQueueConsequences,
  keyDeleteConsequences,
  layoutApplyConsequences,
  layoutRevertConsequences,
  metadataSnapshotConsequences,
  objectDeleteConsequences,
  permissionRevokeConsequences,
  prefixDeleteConsequences,
  repairConsequences,
  scrubCancelConsequences,
  websiteDisableConsequences,
  workerVariableAllNodesConsequences,
} from './consequences'

describe('bucketDeleteConsequences', () => {
  it('エイリアスの削除と「空でないと削除できない」を必ず含む', () => {
    const out = bucketDeleteConsequences({
      globalAliases: ['photos'],
      localAliases: [{}, {}],
      objects: 1234,
      keyCount: 2,
    })
    expect(out).toEqual([
      'このバケットのエイリアス 3 件 (グローバル 1 / ローカル 2) もすべて削除されます',
      'このバケットに権限を持つキー 2 個からアクセス権が外れます',
      'オブジェクトが 1,234 件残っているため削除できません。先にバケットを空にしてください',
    ])
    expect(bucketHasObjects({ objects: 1234 })).toBe(true)
    expect(bucketHasObjects({ objects: 0 })).toBe(false)
  })

  it('統計が不明でもエイリアスと空チェックの行は出す', () => {
    expect(bucketHasObjects({ objects: null })).toBe(false)
    const out = bucketDeleteConsequences({ globalAliases: [], localAliases: [], objects: null, keyCount: null })
    expect(out).toEqual([
      'このバケットのエイリアスもすべて削除されます',
      'オブジェクトが残っていると削除できません',
    ])
  })
})

describe('keyDeleteConsequences', () => {
  it('関連するバケット数を、ローカルエイリアスだけのものも含む数として添える', () => {
    expect(keyDeleteConsequences(3)[1]).toBe(
      '関連するバケット 3 個 (権限またはローカルエイリアス) から、このキーの権限とローカルエイリアスがすべて外れます',
    )
  })
  it('バケット数が不明なら数を出さない', () => {
    expect(keyDeleteConsequences(null)[1]).toBe('このキーが持つすべてのバケットへの権限とローカルエイリアスが外れます')
  })
  it('0 個なら「ない」と言う', () => {
    expect(keyDeleteConsequences(0)[1]).toBe('関連するバケット (権限またはローカルエイリアス) はありません')
  })
  it('唯一の名前のローカルエイリアスでも削除は拒否されない (Garage v2.4.1 delete_key)', () => {
    expect(keyDeleteConsequences(1)[2]).toContain('削除は拒否されません')
  })
})

describe('adminTokenDeleteConsequences', () => {
  it('コンソール自身のトークンには特別な警告を出す', () => {
    const out = adminTokenDeleteConsequences(true)
    expect(out[0]).toContain('このコンソール自身')
    expect(out.join('\n')).toContain('Garage を操作できなくなります')
    expect(out.join('\n')).toContain('GARAGE_ADMIN_TOKEN')
  })
  it('他のトークンはクライアントへの影響だけ', () => {
    expect(adminTokenDeleteConsequences(false)).toEqual([
      'このトークンを使っているクライアントは直ちに Admin API を呼べなくなります',
    ])
  })
})

describe('aliasRemoveConsequences', () => {
  it('最後のグローバルエイリアスなら名前が無くなることを添える', () => {
    const out = aliasRemoveConsequences({ kind: 'global', lastGlobal: true })
    expect(out).toContain('バケットのグローバルな名前が無くなり、ローカルエイリアスを持つキーからしか名前で参照できなくなります')
    expect(out.at(-1)).toBe('バケット本体とオブジェクト、キーの権限はそのまま残ります')
  })
  it('ローカルエイリアスはそのキーからの名前だけが消える', () => {
    expect(aliasRemoveConsequences({ kind: 'local', lastGlobal: false })[0]).toBe(
      'このキーからはこの名前でバケットにアクセスできなくなります',
    )
  })
})

describe('permissionRevokeConsequences', () => {
  it('外れるフラグを列挙し、owner とローカルエイリアスに触れる', () => {
    expect(permissionRevokeConsequences({ read: true, write: false, owner: true }, 1)).toEqual([
      'read / owner が外れ、このキーからこのバケットにアクセスできなくなります',
      'owner が外れるため、このキーからバケット設定の変更やバケットの削除もできなくなります',
      'このキーのローカルエイリアス 1 件は残りますが、権限が無いためその名前でもアクセスできません',
      'バケット本体とオブジェクトは削除されません',
    ])
  })
})

describe('object deletes', () => {
  it('単体削除は復元できないことを言う', () => {
    expect(objectDeleteConsequences()[0]).toContain('復元できません')
  })
  it('一括削除は件数を添える', () => {
    expect(bulkObjectDeleteConsequences(1200)[0]).toContain('1,200 件')
  })
  it('プレフィックス削除は件数と容量、上限の注意を出す', () => {
    expect(prefixDeleteConsequences({ prefix: 'logs/', count: 1000, bytes: 2048, truncated: true })).toEqual([
      '「logs/」で始まる 1,000 件以上のオブジェクト (2.00 KiB 以上) が削除されます',
      'サブフォルダ内のオブジェクトも含まれます',
      '1 回の操作で削除できるのは上限件数までです。残りは再度実行してください',
    ])
  })
  it('0 件なら何も出さない', () => {
    expect(prefixDeleteConsequences({ prefix: 'x/', count: 0, bytes: 0, truncated: false })).toEqual([])
  })
})

describe('blockPurgeConsequences', () => {
  it('オブジェクトごと消え、参照も消えることを言う', () => {
    const out = blockPurgeConsequences(2)
    expect(out[0]).toContain('2 件のブロックを含むオブジェクト')
    expect(out[0]).toContain('完全に削除されます')
    expect(out[1]).toContain('オブジェクトからもこれらのブロックへの参照が消え')
  })
})

describe('repairConsequences', () => {
  it('リシンクキューのクリアと Scrub キャンセルだけに箇条書きを付ける', () => {
    expect(repairConsequences('clearResyncQueue')).toEqual(clearResyncQueueConsequences())
    expect(repairConsequences({ scrub: 'cancel' })).toEqual(scrubCancelConsequences())
    expect(repairConsequences({ scrub: 'start' })).toBeUndefined()
    expect(repairConsequences('blocks')).toBeUndefined()
  })
  it('Scrub キャンセルはチェックポイントが破棄されることを言う', () => {
    expect(scrubCancelConsequences()[0]).toContain('チェックポイント')
  })
})

describe('layout', () => {
  it('適用はバージョンと再配置、戻せないことを言う', () => {
    const out = layoutApplyConsequences(7)
    expect(out[0]).toContain('v7')
    expect(out.join('\n')).toContain('元へ戻す操作はありません')
  })
  it('revert は適用済みレイアウトに影響しない', () => {
    expect(layoutRevertConsequences()).toContain('適用済みのレイアウトには影響しません')
  })
})

describe('websiteDisableConsequences', () => {
  it('ルーティングルールも消えることを件数付きで言う', () => {
    expect(websiteDisableConsequences(3)).toContain('ルーティングルール 3 件も破棄されます')
    expect(websiteDisableConsequences(0)).toContain('ルーティングルールの設定も破棄されます')
  })
})

describe('metadataSnapshotConsequences', () => {
  it('対象と世代管理を言う', () => {
    expect(metadataSnapshotConsequences(true)[0]).toContain('全ノード')
    expect(metadataSnapshotConsequences(false)[0]).toContain('このノード')
    expect(metadataSnapshotConsequences(false)[1]).toContain('最新 2 世代')
  })
})

describe('workerVariableAllNodesConsequences', () => {
  it('変数名と値、全ノードでの上書きを言う', () => {
    expect(workerVariableAllNodesConsequences('resync-tranquility', '0')[0]).toBe(
      'クラスタの全ノードで resync-tranquility が 0 に変更され、ノードごとの現在値は上書きされます',
    )
  })
})
