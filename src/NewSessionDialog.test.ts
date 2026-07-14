import { describe, it, expect } from 'vitest'
import { resolveInput, splitPath } from './NewSessionDialog'

describe('resolveInput', () => {
  it('passes through absolute and ~ paths', () => {
    expect(resolveInput('~/local/x', '~')).toBe('~/local/x')
    expect(resolveInput('/tmp/x', '~')).toBe('/tmp/x')
  })
  it('resolves bare names against the parent setting', () => {
    expect(resolveInput('newthing', '~/local')).toBe('~/local/newthing')
    expect(resolveInput('a/b', '~/local/')).toBe('~/local/a/b')
  })
  it('empty input resolves empty', () => {
    expect(resolveInput('  ', '~')).toBe('')
  })
})

describe('splitPath', () => {
  it('splits dirname (trailing slash) from the partial segment', () => {
    expect(splitPath('~/local/new')).toEqual({ dir: '~/local/', partial: 'new' })
    expect(splitPath('~/local/')).toEqual({ dir: '~/local/', partial: '' })
  })
})
