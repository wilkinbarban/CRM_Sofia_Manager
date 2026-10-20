import { describe, expect, it, vi } from 'vitest'
import {
  createEvolutionPresence,
  EVOLUTION_PRESENCE_INTERVAL_MS,
} from '@/lib/whatsapp/evolution-presence'
import { supportsPresence } from '@/lib/whatsapp/provider'

describe('Evolution composing presence', () => {
  it('uses one owned timeout and waits the remaining provider delay after an instant success', async () => {
    vi.useFakeTimers()
    try {
      let now = 0
      const send = vi.fn().mockResolvedValue(true)
      const handle = createEvolutionPresence({ send, setTimeout, clearTimeout: (timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>), now: () => now })
      await vi.advanceTimersByTimeAsync(0)
      expect(send).toHaveBeenCalledTimes(1)
      expect(vi.getTimerCount()).toBe(1)
      now = 3999
      await vi.advanceTimersByTimeAsync(3999)
      expect(send).toHaveBeenCalledTimes(1)
      now = 4000
      await vi.advanceTimersByTimeAsync(1)
      expect(send).toHaveBeenCalledTimes(2)
      handle.stop()
      expect(vi.getTimerCount()).toBe(0)
    } finally { vi.useRealTimers() }
  })

  it('backs off sync and rejected failures and stop cancels the owned retry', async () => {
    vi.useFakeTimers()
    try {
      const send = vi.fn().mockRejectedValueOnce(Error('secret')).mockResolvedValue(true)
      const handle = createEvolutionPresence({ send, setTimeout, clearTimeout: (timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>) })
      await vi.advanceTimersByTimeAsync(0)
      expect(send).toHaveBeenCalledTimes(1)
      expect(vi.getTimerCount()).toBe(1)
      handle.stop()
      expect(vi.getTimerCount()).toBe(0)
      await vi.advanceTimersByTimeAsync(4000)
      expect(send).toHaveBeenCalledTimes(1)
    } finally { vi.useRealTimers() }
  })

  it('keeps provider failures best effort and exposes sanitized observations', async () => {
    const observe = vi.fn()
    const handle = createEvolutionPresence({
      send: vi.fn().mockRejectedValue(new Error('secret URL token')),
      setTimeout, clearTimeout: (timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>), observe,
    })
    await vi.waitFor(() => expect(observe).toHaveBeenLastCalledWith({ tag: 'evolution_presence', event: 'unavailable', reason: 'provider_unavailable' }))
    handle.stop()
  })

  it('exports canonical EVOLUTION_PRESENCE_INTERVAL_MS equal to 4000ms', () => {
    expect(EVOLUTION_PRESENCE_INTERVAL_MS).toBe(4_000)
  })

  it('supports capability detection via supportsPresence regardless of minified constructor name', () => {
    class RenamedProvider {
      iniciarPresenca = vi.fn()
      enviarMensagem = vi.fn()
    }
    class ProviderWithoutCapability {
      enviarMensagem = vi.fn()
    }

    expect(supportsPresence(new RenamedProvider())).toBe(true)
    expect(supportsPresence(new ProviderWithoutCapability())).toBe(false)
    expect(supportsPresence(null)).toBe(false)
    expect(supportsPresence(undefined)).toBe(false)
    expect(supportsPresence({})).toBe(false)
  })

  it('aborts in-flight send request when stop is called and suppresses late events', async () => {
    let capturedSignal: AbortSignal | undefined
    let resolveSend!: (value: boolean) => void
    const observe = vi.fn()
    const send = vi.fn((signal?: AbortSignal) => {
      capturedSignal = signal
      return new Promise<boolean>(resolve => {
        resolveSend = resolve
      })
    })

    const handle = createEvolutionPresence({
      send,
      setTimeout,
      clearTimeout: (timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>),
      observe,
    })

    expect(send).toHaveBeenCalledTimes(1)
    expect(capturedSignal).toBeDefined()
    expect(capturedSignal?.aborted).toBe(false)

    // Stop presence while send is still pending in-flight
    handle.stop()
    expect(capturedSignal?.aborted).toBe(true)

    // Resolve late - observe should not receive 'accepted' after stop
    resolveSend(true)
    await Promise.resolve()
    expect(observe).toHaveBeenCalledWith({ tag: 'evolution_presence', event: 'attempt' })
    expect(observe).not.toHaveBeenCalledWith({ tag: 'evolution_presence', event: 'accepted' })
  })

  it('handles network abort or timeout gracefully without leaking unhandled rejections', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => { unhandled.push(reason) }
    process.on('unhandledRejection', onUnhandled)
    try {
      const observe = vi.fn()
      const send = vi.fn().mockRejectedValue(new DOMException('The user aborted a request.', 'AbortError'))
      const handle = createEvolutionPresence({
        send,
        setTimeout,
        clearTimeout: (timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>),
        observe,
      })

      await vi.waitFor(() => expect(observe).toHaveBeenLastCalledWith({
        tag: 'evolution_presence',
        event: 'unavailable',
        reason: 'provider_unavailable',
      }))
      handle.stop()
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })
})
