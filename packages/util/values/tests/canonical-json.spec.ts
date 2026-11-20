/** Canonical key order over lossless JSON values. */

import { describe, expect, it } from 'vitest'
import { canonicalJsonValue } from '../src/index.ts'

describe('canonicalJsonValue', () => {
  it('sorts object keys at every level and keeps array element order', () => {
    const value = {
      z: 1,
      a: { y: [{ second: 2, first: 1 }], b: true },
      enum: ['z', 'a'],
    }

    const canonical = canonicalJsonValue(value)

    expect(JSON.stringify(canonical))
      .toBe('{"a":{"b":true,"y":[{"first":1,"second":2}]},"enum":["z","a"],"z":1}')
    expect(Object.keys(canonical!.a)).toEqual(['b', 'y'])
  })

  it('gives equivalent values identical bytes regardless of insertion order', () => {
    const forward = { type: 'object', properties: { z: { type: 'string' }, a: { type: 'number' } } }
    const reverse = { properties: { a: { type: 'number' }, z: { type: 'string' } }, type: 'object' }

    expect(JSON.stringify(canonicalJsonValue(forward))).toBe(JSON.stringify(canonicalJsonValue(reverse)))
  })

  it('detaches the result from the source graph', () => {
    const source = { nested: { a: 1 } }
    const canonical = canonicalJsonValue(source)!
    source.nested.a = 2

    expect(canonical.nested.a).toBe(1)
    expect(canonical).not.toBe(source)
  })

  it('keeps a __proto__ key as ordinary data', () => {
    const source = Object.defineProperty({ a: 1 }, '__proto__', {
      value: { polluted: true },
      enumerable: true,
      configurable: true,
      writable: true,
    })

    const canonical = canonicalJsonValue(source)

    expect(Object.getPrototypeOf(canonical)).toBe(Object.prototype)
    expect(Object.hasOwn(canonical as object, '__proto__')).toBe(true)
    expect((canonical as { polluted?: unknown }).polluted).toBeUndefined()
  })

  it('rejects values that do not survive a JSON round trip', () => {
    expect(canonicalJsonValue(Symbol('root'))).toBeUndefined()
    expect(canonicalJsonValue({ value: Number.NaN })).toBeUndefined()
    expect(canonicalJsonValue({ value: -0 })).toBeUndefined()
    expect(canonicalJsonValue({ value: () => 1 })).toBeUndefined()
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(canonicalJsonValue(cyclic)).toBeUndefined()
  })
})
