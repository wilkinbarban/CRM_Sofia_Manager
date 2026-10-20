import { describe, expect, it, vi, beforeEach } from 'vitest'
import {
  runSofiaBatchMaintenance,
  SOFIA_BATCH_CANCELLATION_REASONS,
  evaluateBatchCancellation,
  type BatchWorkerDeps,
} from '@/lib/sofia/inbound-batch-worker'

type Channel = 'telegram' | 'whatsapp' | 'web'

function mockWorkerDeps(overrides: Partial<BatchWorkerDeps> = {}): BatchWorkerDeps {
  return {
    claimBatch: vi.fn().mockResolvedValue(null),
    cancel: vi.fn().mockResolvedValue(true),
    fail: vi.fn().mockResolvedValue(true),
    businessHours: vi.fn().mockResolvedValue(true),
    globalEnabled: vi.fn().mockResolvedValue(true),
    whatsappEligible: vi.fn().mockResolvedValue(true),
    generate: vi.fn().mockResolvedValue('resposta gerada pela IA'),
    complete: vi.fn().mockResolvedValue(true),
    completePaced: vi.fn().mockResolvedValue({ remaining_ms: 0 }),
    claimDelivery: vi.fn().mockResolvedValue(null),
    beginDelivery: vi.fn().mockResolvedValue(true),
    recordDeliveryFailure: vi.fn().mockResolvedValue(true),
    beginActivity: vi.fn().mockResolvedValue({ attempt_id: 'att-1', expires_at: '' }),
    renewActivity: vi.fn().mockResolvedValue(true),
    clearActivity: vi.fn().mockResolvedValue(true),
    adoptActivity: vi.fn().mockResolvedValue({ attempt_id: 'att-2', expires_at: '' }),
    setInterval: vi.fn(() => 'timer-1'),
    clearInterval: vi.fn(),
    now: vi.fn(() => 1000),
    sleep: vi.fn().mockResolvedValue(undefined),
    sendTelegramTyping: vi.fn().mockResolvedValue({ outcome: 'accepted' }),
    sendTelegram: vi.fn().mockResolvedValue({ success: true }),
    sendWhatsApp: vi.fn().mockResolvedValue({ sucesso: true }),
    startWhatsAppPresence: vi.fn().mockReturnValue({ stop: vi.fn() }),
    observeTelegramTyping: vi.fn(),
    observeWhatsAppPresence: vi.fn(),
    extractFacts: vi.fn().mockResolvedValue(0),
    ...overrides,
  }
}

function createClaim(channel: Channel, eligibilityOverrides: Record<string, unknown> = {}) {
  return {
    batch_id: 'batch-test-1',
    conversa_id: 'conv-test-1',
    cliente_id: 'client-test-1',
    channel,
    lease_token: 'lease-test-1',
    eligibility: {
      db_eligible: true,
      ia_ativa: true,
      conversation_status: 'ia_atendendo',
      automation_allowed: true,
      global_enabled: true,
      whatsapp_status: 'active',
      whatsapp_sleeping: false,
      ...eligibilityOverrides,
    },
    members: [
      {
        content: 'Olá gostaria de fazer um pedido',
        has_attachment: false,
        has_payment_proof: false,
      },
    ],
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.unstubAllEnvs()
  vi.stubEnv('SOFIA_INBOUND_BATCH_RUNTIME_ENABLED', 'true')
})

describe('Sofia Multichannel Safety Invariants & Cross-Channel Regression', () => {
  describe('Canonical Safety Reasons Contract', () => {
    it('exports complete canonical cancellation reasons', () => {
      expect(SOFIA_BATCH_CANCELLATION_REASONS).toEqual([
        'ia_inactive',
        'opt_out',
        'global_disabled',
        'handoff_or_pause',
        'sleep_or_cooldown',
        'outside_business_hours',
      ])
    })

    it.each([
      ['ia_inactive', { ia_ativa: false }, { isBusinessHours: true, isChannelGloballyEnabled: true, isWhatsAppEligible: true }],
      ['opt_out', { automation_allowed: false }, { isBusinessHours: true, isChannelGloballyEnabled: true, isWhatsAppEligible: true }],
      ['opt_out', { whatsapp_status: 'opted_out' }, { isBusinessHours: true, isChannelGloballyEnabled: true, isWhatsAppEligible: true }],
      ['global_disabled', { global_enabled: false }, { isBusinessHours: true, isChannelGloballyEnabled: true, isWhatsAppEligible: true }],
      ['global_disabled', {}, { isBusinessHours: true, isChannelGloballyEnabled: false, isWhatsAppEligible: true }],
      ['handoff_or_pause', { conversation_status: 'humano_atendendo' }, { isBusinessHours: true, isChannelGloballyEnabled: true, isWhatsAppEligible: true }],
      ['handoff_or_pause', { conversation_status: 'pausada' }, { isBusinessHours: true, isChannelGloballyEnabled: true, isWhatsAppEligible: true }],
      ['handoff_or_pause', { db_eligible: false }, { isBusinessHours: true, isChannelGloballyEnabled: true, isWhatsAppEligible: true }],
      ['sleep_or_cooldown', { whatsapp_sleeping: true }, { isBusinessHours: true, isChannelGloballyEnabled: true, isWhatsAppEligible: true }],
      ['sleep_or_cooldown', {}, { isBusinessHours: true, isChannelGloballyEnabled: true, isWhatsAppEligible: false }],
      ['outside_business_hours', {}, { isBusinessHours: false, isChannelGloballyEnabled: true, isWhatsAppEligible: true }],
    ] as const)(
      'evaluates reason %s deterministically from eligibility input',
      (expectedReason, eligibilityOverrides, context) => {
        const claim = createClaim('whatsapp', eligibilityOverrides)
        const reason = evaluateBatchCancellation(claim, context)
        expect(reason).toBe(expectedReason)
      }
    )

    it('returns null when all safety criteria are satisfied across channels', () => {
      for (const channel of ['telegram', 'whatsapp', 'web'] as const) {
        const claim = createClaim(channel)
        const reason = evaluateBatchCancellation(claim, {
          isBusinessHours: true,
          isChannelGloballyEnabled: true,
          isWhatsAppEligible: true,
        })
        expect(reason).toBeNull()
      }
    })
  })

  describe.each(['telegram', 'whatsapp', 'web'] as const)(
    'Multichannel Worker Safety: Channel %s',
    (channel) => {
      it('cancels batch immediately on human handoff without invoking LLM generation', async () => {
        const claim = createClaim(channel, { conversation_status: 'humano_atendendo' })
        const d = mockWorkerDeps({
          claimBatch: vi.fn().mockResolvedValueOnce(claim).mockResolvedValue(null),
        })

        const result = await runSofiaBatchMaintenance(d, 1)

        expect(result.cancelled).toBe(1)
        expect(result.completed).toBe(0)
        expect(d.cancel).toHaveBeenCalledWith(claim.batch_id, claim.lease_token, 'handoff_or_pause')
        expect(d.generate).not.toHaveBeenCalled()
        expect(d.completePaced).not.toHaveBeenCalled()
      })

      it('cancels batch immediately on customer opt-out without invoking LLM generation', async () => {
        const claim = createClaim(channel, { automation_allowed: false })
        const d = mockWorkerDeps({
          claimBatch: vi.fn().mockResolvedValueOnce(claim).mockResolvedValue(null),
        })

        const result = await runSofiaBatchMaintenance(d, 1)

        expect(result.cancelled).toBe(1)
        expect(d.cancel).toHaveBeenCalledWith(claim.batch_id, claim.lease_token, 'opt_out')
        expect(d.generate).not.toHaveBeenCalled()
      })

      it('cancels batch immediately outside of business hours', async () => {
        const claim = createClaim(channel)
        const d = mockWorkerDeps({
          claimBatch: vi.fn().mockResolvedValueOnce(claim).mockResolvedValue(null),
          businessHours: vi.fn().mockResolvedValue(false),
        })

        const result = await runSofiaBatchMaintenance(d, 1)

        expect(result.cancelled).toBe(1)
        expect(d.cancel).toHaveBeenCalledWith(claim.batch_id, claim.lease_token, 'outside_business_hours')
        expect(d.generate).not.toHaveBeenCalled()
      })
    }
  )

  describe('At-Most-Once Response Guarantee & Delivery Isolation', () => {
    it('aborts dispatch and releases handles when beginDelivery denies the lease token', async () => {
      const delivery = {
        batch_id: 'batch-denied',
        conversa_id: 'conv-denied',
        canal: 'telegram' as const,
        response_text: 'resposta importante',
        lease_token: 'lease-lost',
        remaining_ms: 0,
      }
      const d = mockWorkerDeps({
        claimBatch: vi.fn().mockResolvedValue(null),
        claimDelivery: vi.fn().mockResolvedValueOnce(delivery).mockResolvedValue(null),
        adoptActivity: vi.fn().mockResolvedValue({ attempt_id: 'att-d', expires_at: '' }),
        beginDelivery: vi.fn().mockResolvedValue(false), // Lease lost to another worker replica
      })

      const result = await runSofiaBatchMaintenance(d, 1)

      expect(result.delivery_attempted).toBe(0)
      expect(d.sendTelegram).not.toHaveBeenCalled()
      expect(d.sendWhatsApp).not.toHaveBeenCalled()
      expect(d.clearActivity).toHaveBeenCalledWith('batch-denied', 'att-d')
    })

    it('records delivery failure and cleans up all activity handles when provider rejects message', async () => {
      const delivery = {
        batch_id: 'batch-rejected',
        conversa_id: 'conv-rejected',
        canal: 'telegram' as const,
        response_text: 'resposta para cliente',
        lease_token: 'lease-ok',
        remaining_ms: 0,
      }
      const d = mockWorkerDeps({
        claimBatch: vi.fn().mockResolvedValue(null),
        claimDelivery: vi.fn().mockResolvedValueOnce(delivery).mockResolvedValue(null),
        adoptActivity: vi.fn().mockResolvedValue({ attempt_id: 'att-r', expires_at: '' }),
        beginDelivery: vi.fn().mockResolvedValue(true),
        sendTelegram: vi.fn().mockResolvedValue({ success: false }),
      })

      const result = await runSofiaBatchMaintenance(d, 1)

      expect(result.delivery_attempted).toBe(1)
      expect(d.recordDeliveryFailure).toHaveBeenCalledWith('batch-rejected', 'provider_rejected')
      expect(d.clearActivity).toHaveBeenCalledWith('batch-rejected', 'att-r')
    })

    it('clears generation activity handle and releases typing when LLM generation throws', async () => {
      const claim = createClaim('telegram')
      const stopTyping = vi.fn()
      const d = mockWorkerDeps({
        claimBatch: vi.fn().mockResolvedValueOnce(claim).mockResolvedValue(null),
        beginActivity: vi.fn().mockResolvedValue({ attempt_id: 'att-gen', expires_at: '' }),
        generate: vi.fn().mockRejectedValue(new Error('LLM provider timeout')),
        sendTelegramTyping: vi.fn().mockReturnValue(new Promise(() => undefined)), // in-flight typing
        clearInterval: stopTyping,
      })

      const result = await runSofiaBatchMaintenance(d, 1)

      expect(result.failed).toBe(1)
      expect(d.fail).toHaveBeenCalledWith(claim.batch_id, claim.lease_token, 'generation_failed')
      expect(d.clearActivity).toHaveBeenCalledWith(claim.batch_id, 'att-gen')
    })
  })
})
