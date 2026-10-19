import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { CopyButton } from '@/components/copy-button'
import type { KeyDetail } from '@/api'

interface KeySecretDialogProps {
  created: KeyDetail | null
  onClose: () => void
}

/**
 * Shown once right after a key is created. Garage only returns the secret in
 * the CreateKey response (and on explicit GetKeyInfo?showSecretKey=true), so
 * the operator must copy it here or reveal it later from the key detail page.
 */
export function KeySecretDialog({ created, onClose }: KeySecretDialogProps) {
  return (
    <Dialog open={created !== null} onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>キーを作成しました</DialogTitle>
          <DialogDescription>
            シークレットアクセスキーを控えてください。キー詳細ページの「シークレットを表示」からも後で確認できます。
          </DialogDescription>
        </DialogHeader>
        {created && (
          <div className="space-y-3 text-sm">
            <div>
              <p className="text-muted-foreground">名前</p>
              <p className="font-medium">{created.name}</p>
            </div>
            <div>
              <p className="text-muted-foreground">アクセスキー ID</p>
              <div className="flex items-center gap-1">
                <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs break-all">
                  {created.accessKeyId}
                </code>
                <CopyButton value={created.accessKeyId} label="アクセスキー ID をコピー" />
              </div>
            </div>
            <div>
              <p className="text-muted-foreground">シークレットアクセスキー</p>
              <div className="flex items-center gap-1">
                <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs break-all">
                  {created.secretAccessKey ?? '(取得できませんでした)'}
                </code>
                {created.secretAccessKey && (
                  <CopyButton value={created.secretAccessKey} label="シークレットアクセスキーをコピー" />
                )}
              </div>
            </div>
          </div>
        )}
        <DialogFooter>
          <Button onClick={onClose}>閉じる</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
