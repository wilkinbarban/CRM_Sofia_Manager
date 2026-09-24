import React from 'react'
import { render, screen, cleanup } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { buildDefaultSofiaSystemPrompt, DEFAULT_SOFIA_SYSTEM_PROMPT } from '@/lib/sofia/default-prompt'
import { DEFAULT_BUSINESS_PROFILE, type BusinessProfile } from '@/lib/config/business-profile'
import { processarRagPipeline } from '@/lib/ai/openrouter'
import * as deepseekModule from '@/lib/ai/deepseek'
import * as adminSupabaseModule from '@/lib/supabase/admin'
import * as sistemaConfig from '@/lib/config/sistema'
import AdminDashboard from '@/components/operator/AdminDashboard'

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) =>
    React.createElement('a', { href }, children),
}))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}))
vi.mock('@/lib/supabase/client', () => ({
  createClient: vi.fn(() => ({
    auth: { signOut: vi.fn() },
    storage: { from: () => ({ createSignedUrl: vi.fn().mockResolvedValue({ data: { signedUrl: 'https://example.com/receipt.pdf' } }) }) },
  })),
}))

describe('Dynamic Sofia Default System Prompt Builder (apps/web/src/lib/sofia/default-prompt.ts)', () => {
  it('constructs dynamic prompt containing business profile name, location, role, and description', () => {
    const customProfile: BusinessProfile = {
      name: 'Padaria Estrela',
      shortName: 'Estrela',
      location: 'Batel, Curitiba - PR',
      pickupAddress: 'Rua das Flores, 123',
      description: 'Panificadora e confeitaria artesanal com pães de fermentação natural.',
      personaRole: 'atendente virtual especialista em confeitaria',
    }
    const prompt = buildDefaultSofiaSystemPrompt(customProfile)
    expect(prompt).toContain('Padaria Estrela')
    expect(prompt).toContain('Batel, Curitiba - PR')
    expect(prompt).toContain('atendente virtual especialista em confeitaria')
    expect(prompt).toContain('Panificadora e confeitaria artesanal com pães de fermentação natural.')
  })

  it('falls back cleanly to DEFAULT_BUSINESS_PROFILE when fields are omitted or empty', () => {
    const prompt = buildDefaultSofiaSystemPrompt({})
    expect(prompt).toContain(DEFAULT_BUSINESS_PROFILE.name)
    expect(prompt).toContain(DEFAULT_BUSINESS_PROFILE.location)
    expect(prompt).toContain(DEFAULT_BUSINESS_PROFILE.personaRole)
    expect(prompt).toContain(DEFAULT_BUSINESS_PROFILE.description)
  })

  it('trims whitespace and partially merges fields with DEFAULT_BUSINESS_PROFILE', () => {
    const prompt = buildDefaultSofiaSystemPrompt({
      name: '   Loja Estilo   ',
      location: '   ',
      personaRole: '   especialista de vendas   ',
    })
    expect(prompt).toContain('Loja Estilo')
    expect(prompt).not.toContain('   Loja Estilo   ')
    expect(prompt).toContain('especialista de vendas')
    expect(prompt).toContain(DEFAULT_BUSINESS_PROFILE.location)
    expect(prompt).toContain(DEFAULT_BUSINESS_PROFILE.description)
  })

  it('exports DEFAULT_SOFIA_SYSTEM_PROMPT built from DEFAULT_BUSINESS_PROFILE', () => {
    expect(DEFAULT_SOFIA_SYSTEM_PROMPT).toBe(buildDefaultSofiaSystemPrompt(DEFAULT_BUSINESS_PROFILE))
  })

  it('reconciles PR #198 guardrails without hardcoded demo or no-real-business claims', () => {
    const prompt = buildDefaultSofiaSystemPrompt({
      name: 'Clínica Saúde',
      location: 'Centro, Curitiba - PR',
      personaRole: 'recepcionista virtual',
      description: 'Clínica médica multidisciplinar.',
    })
    const forbidden = [
      'ambiente de demonstração', 'ambiente de demonstracao', 'dados de teste',
      'não existe um negócio real configurado', 'nao existe um negocio real configurado',
      'fictício', 'ficticio', 'não afirme ser de um negócio específico', 'ambiente de testes',
    ]
    for (const phrase of forbidden) {
      expect(prompt.toLowerCase()).not.toContain(phrase)
      expect(DEFAULT_SOFIA_SYSTEM_PROMPT.toLowerCase()).not.toContain(phrase)
    }
  })

  it('contains no invented catalog or price assumptions', () => {
    const prompt = buildDefaultSofiaSystemPrompt()
    const forbidden = [
      'costela', 'picanha', 'alcatra', 'frango recheado', 'combo 1', 'combo 2',
      'r$', '69,90', '119,90', 'chef executivo', 'mestre assador',
    ]
    for (const term of forbidden) {
      expect(prompt.toLowerCase()).not.toContain(term)
    }
  })

  it('incorporates structured support guardrails and operational limits', () => {
    const prompt = buildDefaultSofiaSystemPrompt()
    expect(prompt).toContain('## 1. QUEM É VOCÊ')
    expect(prompt).toContain('## 2. REGRA DE OURO E DIRETRIZES')
    expect(prompt).toContain('## 3. SUA TAREFA')
    expect(prompt).toContain('## 4. LIMITES E OPERAÇÃO')
    expect(prompt).toContain('## 5. MODIFICAÇÃO OU CANCELAMENTO DE PEDIDOS')
    expect(prompt).toContain('CONTEXTO DE SUPORTE')
    expect(prompt.toLowerCase()).toContain('não invente')
    expect(prompt).toContain('Português do Brasil (pt-BR)')
    expect(prompt).toContain('no máximo 1 ou 2 por mensagem')
    expect(prompt.toLowerCase()).toContain('atendente humano')
    expect(prompt.toLowerCase()).toContain('nunca tente cancelar ou alterar pedidos no banco de dados')
  })
})

describe('Sofia System Prompt Pipeline Integration (apps/web/src/lib/ai/openrouter.ts)', () => {
  const originalEnv = process.env
  let chamarDeepSeekSpy: any

  beforeEach(() => {
    process.env = { ...originalEnv, DEEPSEEK_API_KEY: 'sk-test-valid-deepseek-key-12345', SOFIA_AI_GENERATION_ENABLED: 'true' }
    const mockSupabase: any = {
      from: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      insert: vi.fn().mockReturnThis(),
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({
        data: {
          id: 'conversa-t1', cliente_id: 'cliente-t1', ia_ativa: true, canal_origem: 'whatsapp',
          clientes: { telefone: '5541999990000', nome: 'Cliente Teste', telegram_chat_id: null },
        },
        error: null,
      }),
      maybeSingle: vi.fn(),
      rpc: vi.fn().mockResolvedValue({ data: [], error: null }),
    }
    vi.spyOn(adminSupabaseModule, 'createAdminClient').mockReturnValue(mockSupabase)
    vi.spyOn(deepseekModule, 'resolverChaveDeepSeek').mockResolvedValue('sk-test-valid-deepseek-key-12345')
    vi.spyOn(deepseekModule, 'resolverModeloDeepSeek').mockResolvedValue('deepseek-chat')
    chamarDeepSeekSpy = vi.spyOn(deepseekModule, 'chamarDeepSeekChat').mockResolvedValue({
      success: true, content: 'Resposta simulada da Sofia.',
    })
  })

  afterEach(() => {
    process.env = originalEnv
    vi.restoreAllMocks()
  })

  it('preserves custom nonempty SOFIA_SYSTEM_PROMPT as authoritative', async () => {
    vi.spyOn(sistemaConfig, 'obterConfiguracaoSistema').mockImplementation(async (key: string) => {
      return key === 'SOFIA_SYSTEM_PROMPT' ? 'Instruções personalizadas do operador: você é a Sofia VIP.' : null
    })

    await processarRagPipeline('conversa-t1', 'Olá', undefined, true)

    expect(chamarDeepSeekSpy).toHaveBeenCalledTimes(1)
    const systemMsg = chamarDeepSeekSpy.mock.calls[0][0].messages.find((m: any) => m.role === 'system')
    expect(systemMsg?.content).toContain('Instruções personalizadas do operador: você é a Sofia VIP.')
    expect(systemMsg?.content).toContain('🚨 REGRA CRÍTICA — LEIA ANTES DE TUDO 🚨')
    expect(systemMsg?.content).toContain('⚠️ LEMBRETE FINAL: Sua resposta DEVE estar em PORTUGUÊS DO BRASIL.')
  })

  it('falls back to dynamic buildDefaultSofiaSystemPrompt when SOFIA_SYSTEM_PROMPT is empty or null', async () => {
    vi.spyOn(sistemaConfig, 'obterConfiguracaoSistema').mockImplementation(async (key: string) => {
      if (key === 'SOFIA_SYSTEM_PROMPT') return '   '
      if (key === 'BUSINESS_NAME') return 'Cafeteria do Parque'
      if (key === 'BUSINESS_LOCATION') return 'Parque Barigui, Curitiba - PR'
      if (key === 'SOFIA_PERSONA_ROLE') return 'barista virtual e atendente'
      if (key === 'BUSINESS_DESCRIPTION') return 'Cafés especiais e grãos selecionados.'
      return null
    })

    await processarRagPipeline('conversa-t1', 'Olá', undefined, true)

    expect(chamarDeepSeekSpy).toHaveBeenCalledTimes(1)
    const systemMsg = chamarDeepSeekSpy.mock.calls[0][0].messages.find((m: any) => m.role === 'system')
    expect(systemMsg?.content).toContain('Cafeteria do Parque')
    expect(systemMsg?.content).toContain('Parque Barigui, Curitiba - PR')
    expect(systemMsg?.content).toContain('barista virtual e atendente')
    expect(systemMsg?.content).toContain('Cafés especiais e grãos selecionados.')
    expect(systemMsg?.content.startsWith('🚨 REGRA CRÍTICA — LEIA ANTES DE TUDO 🚨')).toBe(true)
    expect(systemMsg?.content).toContain('\n\n---\n\n')
    expect(systemMsg?.content.endsWith('⚠️ LEMBRETE FINAL: Sua resposta DEVE estar em PORTUGUÊS DO BRASIL. Revise sua resposta antes de enviá-la. Se não estiver em português, REESCREVA-A em português. NÃO responda em espanhol.')).toBe(true)
  })
})

describe('Operator UI Prompt Tab Integration (apps/web/src/components/operator/AdminDashboard.tsx)', () => {
  const baseDashboardProps = {
    usuarioLogado: { id: 'admin-1', nome: 'Admin', email: 'admin@crmsofia.com', funcao: 'admin' as const, ativo: true, telefone: '5541999990001' },
    usuariosIniciais: [],
    estatisticasIniciais: {
      totalMensagens: 0, conversasAtivas: 0, tempoMedioResposta: '0s', taxaConversao: '0%',
      mensagensHoje: 0, pedidosHoje: 0, totalIa: 0, totalOperador: 0, totalCliente: 0, taxaAutomacao: 0,
    },
    logsIniciais: [],
    artigosIniciais: [],
  }

  afterEach(() => { cleanup() })

  it('uses custom SOFIA_SYSTEM_PROMPT when present in systemConfigs', () => {
    render(React.createElement(AdminDashboard, {
      ...baseDashboardProps, initialTab: 'prompt',
      systemConfigs: { SOFIA_SYSTEM_PROMPT: 'Prompt customizado pelo operador no banco de dados.' },
    }))
    expect(screen.getByDisplayValue('Prompt customizado pelo operador no banco de dados.')).toBeDefined()
  })

  it('falls back to dynamic prompt built with resolved business profile when SOFIA_SYSTEM_PROMPT is empty string', () => {
    render(React.createElement(AdminDashboard, {
      ...baseDashboardProps, initialTab: 'prompt',
      systemConfigs: {
        SOFIA_SYSTEM_PROMPT: '   ',
        BUSINESS_NAME: 'Sorveteria Gelato',
        BUSINESS_LOCATION: 'Mercês, Curitiba - PR',
        BUSINESS_DESCRIPTION: 'Gelatos italianos artesanais.',
        SOFIA_PERSONA_ROLE: 'atendente virtual de gelateria',
      },
    }))
    const expectedPrompt = buildDefaultSofiaSystemPrompt({
      name: 'Sorveteria Gelato', location: 'Mercês, Curitiba - PR',
      description: 'Gelatos italianos artesanais.', personaRole: 'atendente virtual de gelateria',
    })
    expect(document.querySelector('textarea')?.value).toBe(expectedPrompt)
  })

  it('falls back to dynamic prompt built with resolved business profile when SOFIA_SYSTEM_PROMPT is absent', () => {
    render(React.createElement(AdminDashboard, {
      ...baseDashboardProps, initialTab: 'prompt',
      systemConfigs: {
        BUSINESS_NAME: 'Boutique da Moda',
        BUSINESS_LOCATION: 'Curitiba - PR',
        BUSINESS_DESCRIPTION: 'Moda feminina e acessórios elegantes.',
        SOFIA_PERSONA_ROLE: 'consultora de estilo virtual',
      },
    }))
    const expectedPrompt = buildDefaultSofiaSystemPrompt({
      name: 'Boutique da Moda', location: 'Curitiba - PR',
      description: 'Moda feminina e acessórios elegantes.', personaRole: 'consultora de estilo virtual',
    })
    expect(document.querySelector('textarea')?.value).toBe(expectedPrompt)
  })
})
