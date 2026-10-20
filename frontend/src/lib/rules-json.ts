export type JsonRules = Record<string, unknown>[]

/**
 * Parses a JSON array of objects (the raw-JSON rule editors: CORS, lifecycle,
 * website routing rules). Blank text means []. Returns an error message when
 * the text is not valid JSON, not an array, or has a non-object element.
 */
export function parseRulesJson(text: string): { rules: JsonRules } | { error: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(text.trim() === '' ? '[]' : text)
  } catch (e) {
    return { error: `JSON の構文エラー: ${e instanceof Error ? e.message : String(e)}` }
  }
  if (!Array.isArray(parsed)) return { error: 'ルールは JSON 配列 ([...]) で指定してください' }
  const bad = parsed.findIndex((r) => r === null || typeof r !== 'object' || Array.isArray(r))
  if (bad >= 0) return { error: `${bad + 1} 番目の要素がオブジェクトではありません` }
  return { rules: parsed as JsonRules }
}

export function rulesToText(rules: unknown[] | null | undefined): string {
  return JSON.stringify(rules ?? [], null, 2)
}
