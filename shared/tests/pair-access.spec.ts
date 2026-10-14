/**
 * Canonical tests for the shared pairing trust fence (shared/host/pair-access.ts);
 * each consuming package keeps a small wrapper spec for its own wiring.
 */
import type { IncomingMessage } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { isPairedOrLoopbackAllowed } from '../host/pair-access.ts'

function request(options: {
  remoteAddress?: string
  host?: string
  cookie?: string
} = {}): IncomingMessage {
  return {
    headers: {
      host: options.host ?? '127.0.0.1:3000',
      ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
    },
    socket: { remoteAddress: options.remoteAddress ?? '127.0.0.1' },
  } as IncomingMessage
}

describe('isPairedOrLoopbackAllowed', () => {
  it('allows loopback without a pairing service', () => {
    expect(isPairedOrLoopbackAllowed({} as never, request())).toBe(true)
  })

  it('refuses a LAN client when no pairing service is present', () => {
    const ctx = { get: () => undefined }
    expect(isPairedOrLoopbackAllowed(ctx as never, request({
      remoteAddress: '192.168.1.20',
      host: 'dsh.example:443',
    }))).toBe(false)
  })

  it('allows a LAN client with a live paired-device cookie', () => {
    const isPairedDevice = vi.fn(() => true)
    const ctx = { get: (name: string) => name === 'remoteWebUiPairing' ? { isPairedDevice } : undefined }
    const req = request({
      remoteAddress: '192.168.1.20',
      host: 'dsh.example:443',
      cookie: 'dsh_pair=dev-1',
    })
    expect(isPairedOrLoopbackAllowed(ctx as never, req)).toBe(true)
    expect(isPairedDevice).toHaveBeenCalledWith(req)
  })

  it('refuses a LAN client when pairing returns false (revoked or unknown)', () => {
    const ctx = { get: () => ({ isPairedDevice: () => false }) }
    expect(isPairedOrLoopbackAllowed(ctx as never, request({
      remoteAddress: '192.168.1.20',
      host: 'dsh.example:443',
      cookie: 'dsh_pair=revoked',
    }))).toBe(false)
  })

  it('falls back to the direct remoteWebUiPairing property when ctx.get is absent', () => {
    const ctx = { remoteWebUiPairing: { isPairedDevice: () => true } }
    expect(isPairedOrLoopbackAllowed(ctx as never, request({
      remoteAddress: '192.168.1.20',
      host: 'dsh.example:443',
      cookie: 'dsh_pair=dev-1',
    }))).toBe(true)
  })

  it('refuses a non-loopback authority without reading an undeclared service property', () => {
    // A real cordis context throws on a property it never injected, so the fence
    // must ask ctx.get: that throw escapes the route handler and
    // dsh-host-webserver answers a bare 400 instead of the designed 403.
    const ctx = new Proxy({ get: () => undefined }, {
      get: (target, prop, receiver) => {
        if (prop in target) return Reflect.get(target, prop, receiver)
        throw new Error(`cannot get property "${String(prop)}" without inject`)
      },
    })
    const req = request({ remoteAddress: '192.168.1.20', host: 'dsh.example:443' })
    expect(() => isPairedOrLoopbackAllowed(ctx as never, req)).not.toThrow()
    expect(isPairedOrLoopbackAllowed(ctx as never, req)).toBe(false)
  })

  it('admits a trusted non-loopback authority the host gate accepts', () => {
    const ctx = { get: (name: string) => name === 'connection' ? { requestRejection: () => undefined } : undefined }
    expect(isPairedOrLoopbackAllowed(ctx as never, request({
      remoteAddress: '192.168.1.20',
      host: 'dsh.example:443',
    }))).toBe(true)
  })

  it('refuses an authority the host gate does not trust', () => {
    const ctx = { get: (name: string) => name === 'connection' ? { requestRejection: () => 403 } : undefined }
    expect(isPairedOrLoopbackAllowed(ctx as never, request({
      remoteAddress: '192.168.1.20',
      host: 'evil.example:443',
    }))).toBe(false)
  })

  it('refuses a logged-out browser on a trusted authority', () => {
    const ctx = { get: (name: string) => name === 'connection' ? { requestRejection: () => 401 } : undefined }
    expect(isPairedOrLoopbackAllowed(ctx as never, request({
      remoteAddress: '192.168.1.20',
      host: 'dsh.example:443',
    }))).toBe(false)
  })

  it('refuses when the host publishes no request gate', () => {
    const ctx = { get: (name: string) => name === 'connection' ? {} : undefined }
    expect(isPairedOrLoopbackAllowed(ctx as never, request({
      remoteAddress: '192.168.1.20',
      host: 'dsh.example:443',
    }))).toBe(false)
  })
})
