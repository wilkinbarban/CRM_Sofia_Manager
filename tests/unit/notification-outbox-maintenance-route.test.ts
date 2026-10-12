import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  client: vi.fn(),
  config: vi.fn(),
  dispatch: vi.fn(),
  gates: {
    dispatch: { effective: true },
    web: { effective: true },
    whatsapp: { effective: true },
    telegram: { effective: true },
  },
}))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: mocks.client }))
vi.mock('@/lib/config/sistema', () => ({ obterConfiguracaoSistema: mocks.config }))
vi.mock('@/lib/notifications/outbox-dispatch', () => ({ dispatchNotificationOutbox: mocks.dispatch }))
vi.mock('@/lib/notifications/operational-gates', () => ({ notificationOperationalGates: mocks.gates }))
import { POST } from '@/app/api/internal/notifications/maintenance/route'

const request = () => new Request('http://local/internal', { method: 'POST', headers: { authorization: 'Bearer maintenance-secret' } })
const job = { id: 1, event_type: 'payment_received', channel: 'web', conversation_id: 'conversation', payload: { message_key: 'payment_received' }, delivery_key: 'key', attempt: 1, lease_token: '00000000-0000-4000-8000-000000000001' }

function db(claims: unknown[], complete = true, claimError: unknown = null) {
  const remaining = [...claims]
  const rpc = vi.fn(async (name: string) => {
    if (name === 'claim_notification_outbox_for_channels') {
      if (claimError) return { data: null, error: claimError }
      return { data: remaining.shift() ?? null, error: null }
    }
    if (name === 'complete_notification_outbox') return { data: complete, error: complete ? null : { message: 'private' } }
    return { data: null, error: null }
  })
  return { rpc, db: { rpc } }
}

describe('notification outbox maintenance route', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.config.mockResolvedValue('maintenance-secret')
    mocks.gates.dispatch.effective = true
    mocks.gates.web.effective = true
    mocks.gates.whatsapp.effective = true
    mocks.gates.telegram.effective = true
    mocks.dispatch.mockResolvedValue({ status: 'success' })
  })

  it('does not create a client when unauthorized or the master gate is closed', async () => {
    expect((await POST(new Request('http://local'))).status).toBe(401)
    mocks.gates.dispatch.effective = false
    const response = await POST(request())
    expect(await response.json()).toEqual({ completed: 0, failed: 0 })
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(mocks.client).not.toHaveBeenCalled()
  })

  it('does not create a client when no channels are active even if master is enabled', async () => {
    mocks.gates.web.effective = false
    mocks.gates.whatsapp.effective = false
    mocks.gates.telegram.effective = false
    const response = await POST(request())
    expect(await response.json()).toEqual({ completed: 0, failed: 0 })
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(mocks.client).not.toHaveBeenCalled()
  })

  it('claims only active channels with mixed operational gates', async () => {
    mocks.gates.whatsapp.effective = false
    const client = db([job])
    mocks.client.mockReturnValue(client.db)
    const response = await POST(request())
    expect(await response.json()).toEqual({ completed: 1, failed: 0 })
    expect(client.rpc).toHaveBeenCalledWith('claim_notification_outbox_for_channels', {
      p_channels: ['web', 'telegram'],
      p_lease_seconds: 60,
    })
  })

  it('claims only single active channel when only one channel is enabled', async () => {
    mocks.gates.whatsapp.effective = false
    mocks.gates.telegram.effective = false
    const client = db([job])
    mocks.client.mockReturnValue(client.db)
    const response = await POST(request())
    expect(await response.json()).toEqual({ completed: 1, failed: 0 })
    expect(client.rpc).toHaveBeenCalledWith('claim_notification_outbox_for_channels', {
      p_channels: ['web'],
      p_lease_seconds: 60,
    })

    // Now test whatsapp only
    vi.clearAllMocks()
    mocks.gates.web.effective = false
    mocks.gates.whatsapp.effective = true
    mocks.gates.telegram.effective = false
    const whatsappJob = { ...job, channel: 'whatsapp' }
    const whatsappClient = db([whatsappJob])
    mocks.client.mockReturnValue(whatsappClient.db)
    const whatsappResponse = await POST(request())
    expect(await whatsappResponse.json()).toEqual({ completed: 1, failed: 0 })
    expect(whatsappClient.rpc).toHaveBeenCalledWith('claim_notification_outbox_for_channels', {
      p_channels: ['whatsapp'],
      p_lease_seconds: 60,
    })

    // Now test telegram only
    vi.clearAllMocks()
    mocks.gates.web.effective = false
    mocks.gates.whatsapp.effective = false
    mocks.gates.telegram.effective = true
    const telegramJob = { ...job, channel: 'telegram' }
    const telegramClient = db([telegramJob])
    mocks.client.mockReturnValue(telegramClient.db)
    const telegramResponse = await POST(request())
    expect(await telegramResponse.json()).toEqual({ completed: 1, failed: 0 })
    expect(telegramClient.rpc).toHaveBeenCalledWith('claim_notification_outbox_for_channels', {
      p_channels: ['telegram'],
      p_lease_seconds: 60,
    })
  })

  it('handles empty claim backlog cleanly', async () => {
    const client = db([])
    mocks.client.mockReturnValue(client.db)
    const response = await POST(request())
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ completed: 0, failed: 0 })
    expect(mocks.dispatch).not.toHaveBeenCalled()
  })

  it('fails with 503 if complete RPC fails or returns false', async () => {
    const client = db([job], false)
    mocks.client.mockReturnValue(client.db)
    const response = await POST(request())
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: 'maintenance_unavailable' })
  })

  it('claims, dispatches, and fences up to the available rows without exposing data', async () => {
    const client = db([job])
    mocks.client.mockReturnValue(client.db)
    const response = await POST(request())
    expect(await response.json()).toEqual({ completed: 1, failed: 0 })
    expect(client.rpc).toHaveBeenCalledWith('claim_notification_outbox_for_channels', {
      p_channels: ['web', 'whatsapp', 'telegram'],
      p_lease_seconds: 60,
    })
    expect(mocks.dispatch).toHaveBeenCalledWith(expect.objectContaining({ channel: 'web', conversationId: 'conversation', message: 'A informação do seu pagamento foi registrada para processamento.' }))
    expect(client.rpc).toHaveBeenCalledWith('complete_notification_outbox', { p_id: '1', p_disposition: 'success', p_error: null, p_lease_token: job.lease_token, p_attempt: 1 })
  })

  it('accepts the single-row RPC table result before fenced completion', async () => {
    const client = db([[job]])
    mocks.client.mockReturnValue(client.db)
    expect(await (await POST(request())).json()).toEqual({ completed: 1, failed: 0 })
  })

  it('permanently fences invalid payloads with the core-approved fallback token', async () => {
    const client = db([{ ...job, payload: { message_key: 'unknown' } }])
    mocks.client.mockReturnValue(client.db)
    const response = await POST(request())
    expect(await response.json()).toEqual({ completed: 0, failed: 1 })
    expect(mocks.dispatch).not.toHaveBeenCalled()
    expect(client.rpc).toHaveBeenCalledWith('complete_notification_outbox', expect.objectContaining({ p_disposition: 'permanent', p_error: 'operation_failed' }))
  })

  it('rejects claimed rows whose channel is inactive or outside active gates', async () => {
    mocks.gates.whatsapp.effective = false
    const client = db([{ ...job, channel: 'whatsapp' }])
    mocks.client.mockReturnValue(client.db)
    const response = await POST(request())
    expect(await response.json()).toEqual({ error: 'maintenance_unavailable' })
    expect(mocks.dispatch).not.toHaveBeenCalled()
    expect(client.rpc).not.toHaveBeenCalledWith('complete_notification_outbox', expect.anything())
  })

  it('returns 503 when claim RPC returns an error', async () => {
    const client = db([], true, { message: 'db failure' })
    mocks.client.mockReturnValue(client.db)
    const response = await POST(request())
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: 'maintenance_unavailable' })
    expect(mocks.dispatch).not.toHaveBeenCalled()
  })

  it.each([
    { ...job, channel: 'unsafe' },
    { ...job, id: Number.MAX_SAFE_INTEGER + 1 },
    { ...job, id: '0' },
  ])('rejects malformed claimed rows before dispatch or mutation', async (invalidJob) => {
    const client = db([invalidJob])
    mocks.client.mockReturnValue(client.db)
    const response = await POST(request())
    expect(await response.json()).toEqual({ error: 'maintenance_unavailable' })
    expect(mocks.dispatch).not.toHaveBeenCalled()
    expect(client.rpc).not.toHaveBeenCalledWith('complete_notification_outbox', expect.anything())
  })
})
