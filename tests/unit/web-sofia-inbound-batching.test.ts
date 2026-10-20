import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  SOFIA_WEB_IDEMPOTENCY_PREFIX,
  formatSofiaWebExternalId,
  admitSofiaWebInboundMessage,
} from '@/lib/sofia/inbound-batch-producer'
import { obterSofiaPresence } from '@/app/actions/chat'

const mockSupabase = {
  auth: {
    getUser: vi.fn(),
  },
  rpc: vi.fn(),
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => mockSupabase,
}))

const ADMISSION_MIGRATION = join(
  process.cwd(),
  'supabase/migrations/20260914010000_sofia_web_atomic_admission.sql'
)
const PRESENCE_MIGRATION = join(
  process.cwd(),
  'supabase/migrations/20260912020000_sofia_web_presence.sql'
)

beforeEach(() => {
  vi.clearAllMocks()
})

describe('Web Sofia Inbound Batching & Presence Projection', () => {
  describe('Canonical Web Idempotency Namespace & SQL Parity', () => {
    it('exports canonical SOFIA_WEB_IDEMPOTENCY_PREFIX equal to sofia-web:', () => {
      expect(SOFIA_WEB_IDEMPOTENCY_PREFIX).toBe('sofia-web:')
    })

    it('formats external_id with canonical web prefix and trims whitespace', () => {
      expect(formatSofiaWebExternalId('client-key-1')).toBe('sofia-web:client-key-1')
      expect(formatSofiaWebExternalId('  spaced-key-2  ')).toBe('sofia-web:spaced-key-2')
    })

    it('maintains strict parity with SQL migration namespace definitions', () => {
      const admissionSql = readFileSync(ADMISSION_MIGRATION, 'utf8')
      expect(admissionSql).toContain(
        `when p_canal = 'web' then '${SOFIA_WEB_IDEMPOTENCY_PREFIX}' || btrim(p_delivery_key)`
      )

      const presenceSql = readFileSync(PRESENCE_MIGRATION, 'utf8')
      expect(presenceSql).toContain('create function public.get_sofia_conversation_presence')
      expect(presenceSql).toContain("p.status = 'composing'")
      expect(presenceSql).toContain('p.expires_at > pg_catalog.clock_timestamp()')
    })
  })

  describe('obterSofiaPresence projection', () => {
    it('rejects an unauthenticated caller with ACESSO_NEGADO_NAO_AUTENTICADO', async () => {
      mockSupabase.auth.getUser.mockResolvedValue({
        data: { user: null },
        error: new Error('unauthenticated'),
      })

      const result = await obterSofiaPresence('conversa-1')
      expect(result).toEqual({
        success: false,
        error: 'ACESSO_NEGADO_NAO_AUTENTICADO',
      })
      expect(mockSupabase.rpc).not.toHaveBeenCalled()
    })

    it('rejects an empty or whitespace conversationId gracefully without calling RPC', async () => {
      mockSupabase.auth.getUser.mockResolvedValue({
        data: { user: { id: 'u1' } },
        error: null,
      })

      const result = await obterSofiaPresence('   ')
      expect(result).toEqual({
        success: false,
        error: 'SOFIA_PRESENCE_CONVERSA_INVALIDA',
      })
      expect(mockSupabase.rpc).not.toHaveBeenCalled()
    })

    it('returns composing presence when RPC returns an active composing projection', async () => {
      mockSupabase.auth.getUser.mockResolvedValue({
        data: { user: { id: 'u1' } },
        error: null,
      })
      mockSupabase.rpc.mockReturnValue({
        maybeSingle: vi.fn().mockResolvedValue({
          data: { status: 'composing', expires_at: '2026-10-19T22:00:00.000Z' },
          error: null,
        }),
      })

      const result = await obterSofiaPresence('conversa-uuid-1')
      expect(mockSupabase.rpc).toHaveBeenCalledWith('get_sofia_conversation_presence', {
        p_conversa_id: 'conversa-uuid-1',
      })
      expect(result).toEqual({
        success: true,
        presence: {
          status: 'composing',
          expiresAt: '2026-10-19T22:00:00.000Z',
        },
      })
    })

    it('returns null presence when status is idle or no active row is returned', async () => {
      mockSupabase.auth.getUser.mockResolvedValue({
        data: { user: { id: 'u1' } },
        error: null,
      })
      mockSupabase.rpc.mockReturnValue({
        maybeSingle: vi.fn().mockResolvedValue({
          data: null,
          error: null,
        }),
      })

      const result = await obterSofiaPresence('conversa-uuid-1')
      expect(result).toEqual({
        success: true,
        presence: null,
      })
    })

    it('handles RPC errors gracefully with SOFIA_PRESENCE_INDISPONIVEL', async () => {
      mockSupabase.auth.getUser.mockResolvedValue({
        data: { user: { id: 'u1' } },
        error: null,
      })
      mockSupabase.rpc.mockReturnValue({
        maybeSingle: vi.fn().mockResolvedValue({
          data: null,
          error: { message: 'DB down' },
        }),
      })

      const result = await obterSofiaPresence('conversa-uuid-1')
      expect(result).toEqual({
        success: false,
        error: 'SOFIA_PRESENCE_INDISPONIVEL',
      })
    })
  })

  describe('Zero Token Streaming Architectural Invariant', () => {
    it('verifies chat actions return discrete atomic transactional payloads without streaming generators', async () => {
      const chatModule = await import('@/app/actions/chat')
      // All exported chat server action functions must return standard Promises resolving to plain objects,
      // never AsyncGenerators, ReadableStreams, or SSE emitters.
      const actionNames = ['admitirMensagemSofiaWeb', 'obterSofiaPresence', 'processarIaChat'] as const
      for (const name of actionNames) {
        const fn = chatModule[name]
        expect(typeof fn).toBe('function')
        expect(fn.constructor.name).not.toBe('AsyncGeneratorFunction')
      }
    })
  })
})
