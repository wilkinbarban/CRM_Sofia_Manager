import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getEvolutionConnectionState,
  getEvolutionQrCode,
} from '@/lib/whatsapp/evolution-admin-client'

afterEach(() => vi.restoreAllMocks())

const config = {
  apiUrl: 'http://evolution-api:8080/',
  apiKey: 'secret-key',
  instanceName: 'asados',
}

describe('Evolution admin client', () => {
  it('sends the configured public origin when checking connection state', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ instance: { state: 'open' } }), { status: 200 }))

    const result = await getEvolutionConnectionState(config, 'https://crmsofiamanager.duckdns.org')

    expect(fetchMock).toHaveBeenCalledWith(
      'http://evolution-api:8080/instance/connectionState/asados',
      expect.objectContaining({ headers: expect.objectContaining({ Origin: 'https://crmsofiamanager.duckdns.org', apikey: 'secret-key' }) }),
    )
    expect(result).toMatchObject({ connected: true, state: 'open' })
  })

  it('reports a configured but disconnected instance as reachable', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ instance: { state: 'close' } }), { status: 200 }))

    await expect(getEvolutionConnectionState(config, 'https://crmsofiamanager.duckdns.org')).resolves.toMatchObject({ connected: false, state: 'close' })
  })

  it('creates a missing instance and returns its QR code', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 404 }), { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ qrcode: { base64: 'data:image/png;base64,abc' } }), { status: 201 }))

    const result = await getEvolutionQrCode(config, 'https://crmsofiamanager.duckdns.org')

    expect(fetchMock).toHaveBeenNthCalledWith(2,
      'http://evolution-api:8080/instance/create',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ instanceName: 'asados', qrcode: true, integration: 'WHATSAPP-BAILEYS' }) }),
    )
    expect(result.qrcode).toBe('data:image/png;base64,abc')
  })

  it('connects an existing instance without recreating it', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ base64: 'qr-existing' }), { status: 200 }))

    await expect(getEvolutionQrCode(config, 'https://crmsofiamanager.duckdns.org')).resolves.toEqual({ qrcode: 'qr-existing' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith('http://evolution-api:8080/instance/connect/asados', expect.any(Object))
  })
})
