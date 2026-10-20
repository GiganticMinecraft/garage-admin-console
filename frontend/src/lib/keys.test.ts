import { describe, expect, it } from 'vitest'
import { validateImportKey } from './keys'

const ID = 'GK0123456789abcdef01234567'
const SECRET = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'

const form = (over: Partial<{ name: string; accessKeyId: string; secretAccessKey: string }> = {}) => ({
  name: 'migrated',
  accessKeyId: ID,
  secretAccessKey: SECRET,
  ...over,
})

describe('validateImportKey', () => {
  it('accepts a Garage-generated pair without warnings', () => {
    const v = validateImportKey(form())
    expect(v.errors).toEqual({})
    expect(v.warnings).toEqual({})
    expect(v.body).toEqual({ accessKeyId: ID, secretAccessKey: SECRET, name: 'migrated' })
  })

  it('trims pasted whitespace and sends an empty name as null', () => {
    const v = validateImportKey(form({ name: '  ', accessKeyId: ` ${ID}\n`, secretAccessKey: `${SECRET}\n` }))
    expect(v.body).toEqual({ accessKeyId: ID, secretAccessKey: SECRET, name: null })
  })

  it('requires both the ID and the secret', () => {
    const v = validateImportKey(form({ accessKeyId: '', secretAccessKey: '' }))
    expect(v.errors.accessKeyId).toMatch(/入力してください/)
    expect(v.errors.secretAccessKey).toMatch(/入力してください/)
    expect(v.body).toBeNull()
  })

  it('rejects what Garage Key::import rejects', () => {
    expect(validateImportKey(form({ accessKeyId: 'GK12345' })).errors.accessKeyId).toMatch(/8 文字以上/)
    expect(validateImportKey(form({ accessKeyId: 'GK0123/456789' })).errors.accessKeyId).toMatch(/英数字/)
    expect(validateImportKey(form({ accessKeyId: 'GK0123 456789' })).errors.accessKeyId).toMatch(/英数字/)
    expect(validateImportKey(form({ secretAccessKey: '0123456789abcde' })).errors.secretAccessKey).toMatch(/16 文字以上/)
    expect(validateImportKey(form({ secretAccessKey: '0123456789abcdef 0123' })).errors.secretAccessKey).toMatch(/ASCII/)
    expect(validateImportKey(form({ secretAccessKey: '0123456789abcdefあいう' })).errors.secretAccessKey).toMatch(/ASCII/)
    expect(validateImportKey(form({ secretAccessKey: 'x' })).body).toBeNull()
  })

  it('accepts but warns about pairs Garage did not generate', () => {
    const v = validateImportKey(form({ accessKeyId: 'AKIA-key_1.x', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCY' }))
    expect(v.errors).toEqual({})
    expect(v.warnings.accessKeyId).toMatch(/GK/)
    expect(v.warnings.secretAccessKey).toMatch(/64/)
    expect(v.body).not.toBeNull()
    // Upper-case hex is not what Garage generates either.
    expect(validateImportKey(form({ accessKeyId: ID.toUpperCase() })).warnings.accessKeyId).toBeDefined()
  })
})
