import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  createAdminClient: vi.fn(),
  revalidatePath: vi.fn(),
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: mocks.createClient,
}))

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: mocks.createAdminClient,
}))

vi.mock('next/cache', () => ({
  revalidatePath: mocks.revalidatePath,
}))

vi.mock('googleapis', () => ({
  google: {
    auth: {
      JWT: vi.fn().mockImplementation(() => ({
        authorize: vi.fn(),
      })),
    },
    calendar: vi.fn().mockReturnValue({
      events: {
        insert: vi.fn(),
      },
    }),
  },
}))

function makeOperatorClient(role = 'admin') {
  return {
    auth: {
      getUser: vi.fn().mockResolvedValue({
        data: { user: { id: 'operator-123' } },
        error: null,
      }),
    },
    from: vi.fn((table: string) => {
      if (table === 'perfis') {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          single: vi.fn().mockResolvedValue({
            data: { funcao: role, ativo: true },
            error: null,
          }),
        }
      }
      return {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        gte: vi.fn().mockReturnThis(),
        lte: vi.fn().mockReturnThis(),
        order: vi.fn().mockResolvedValue({
          data: [
            {
              id: 'comp-1',
              cliente_id: 'client-123',
              url_arquivo: 'receipts/comp-1.pdf',
              nome_arquivo: 'receipt-1.pdf',
              tamanho_bytes: 1024,
              data_criacao: '2026-07-11T12:00:00Z',
              clientes: { nome: 'Ana Silva' }
            }
          ],
          error: null,
        }),
      }
    }),
  }
}

describe('obterComprovantes Server Action (Task 2.7)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('rejects unauthorized access if not operator', async () => {
    mocks.createClient.mockResolvedValue(makeOperatorClient('cliente'))
    const { obterComprovantes } = await import('@/app/actions/admin')

    const result = await obterComprovantes({})
    expect(result.success).toBe(false)
    expect(result.error).toContain('ACESSO_NEGADO')
  })

  it('fetches all comprovantes for authorized operators', async () => {
    const client = makeOperatorClient('admin')
    mocks.createClient.mockResolvedValue(client)
    const { obterComprovantes } = await import('@/app/actions/admin')

    const result = await obterComprovantes({})
    expect(result.data).toBeDefined()
    expect(result.data?.[0]?.clientes?.nome).toBe('Ana Silva')
  })

  it('applies client filter and date range filters correctly', async () => {
    const client = makeOperatorClient('supervisor')
    mocks.createClient.mockResolvedValue(client)
    const { obterComprovantes } = await import('@/app/actions/admin')

    const fromSpy = vi.spyOn(client, 'from')

    const filters = {
      clienteId: 'client-123',
      dataInicio: '2026-07-10T00:00:00Z',
      dataFim: '2026-07-12T00:00:00Z',
    }

    const result = await obterComprovantes(filters)
    expect(result.success).toBe(true)
    expect(fromSpy).toHaveBeenCalledWith('comprovantes')
  })
})

describe('salvarConfiguracaoAdmin secret preservation', () => {
  function makeConfigAdminClient() {
    const upsert = vi.fn().mockResolvedValue({ error: null })
    const insert = vi.fn().mockResolvedValue({ error: null })
    return {
      client: {
        from: vi.fn((table: string) =>
          table === 'configuracoes_sistema' ? { upsert } : { insert }
        ),
      },
      upsert,
      insert,
    }
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.createClient.mockResolvedValue(makeOperatorClient('admin'))
  })

  /**
   * The admin dashboard renders credential inputs write-only: the page strips
   * every `_KEY`/`_TOKEN`/`_SECRET` value at the server-to-client boundary, so
   * an untouched input submits an empty string. Saving the surrounding form
   * must never overwrite the stored secret with that blank value.
   */
  it('preserves the stored secret when the submitted secret value is blank', async () => {
    const admin = makeConfigAdminClient()
    mocks.createAdminClient.mockReturnValue(admin.client)
    const { salvarConfiguracaoAdmin } = await import('@/app/actions/admin')

    const result = await salvarConfiguracaoAdmin('WHATSAPP_ACCESS_TOKEN', '   ')

    expect(result).toEqual({ success: true })
    expect(admin.upsert).not.toHaveBeenCalled()
    expect(admin.insert).not.toHaveBeenCalled()
  })

  it.each([
    ['WHATSAPP_APP_SECRET', ''],
    ['WHATSAPP_APP_SECRET', '   '],
    ['MERCADO_PAGO_WEBHOOK_SECRET', ''],
    ['MERCADO_PAGO_WEBHOOK_SECRET', '\n\t'],
  ])('preserves the stored `%s` secret when %j is submitted', async (chave, valor) => {
    const admin = makeConfigAdminClient()
    mocks.createAdminClient.mockReturnValue(admin.client)
    const { salvarConfiguracaoAdmin } = await import('@/app/actions/admin')

    const result = await salvarConfiguracaoAdmin(chave, valor)

    expect(result).toEqual({ success: true })
    expect(admin.upsert).not.toHaveBeenCalled()
    expect(admin.insert).not.toHaveBeenCalled()
  })

  it.each([
    ['WHATSAPP_APP_SECRET', 'rotated-app-secret'],
    ['MERCADO_PAGO_WEBHOOK_SECRET', 'rotated-webhook-secret'],
  ])('still persists a `_SECRET` value in %s when the operator submits a real value', async (chave, valor) => {
    const admin = makeConfigAdminClient()
    mocks.createAdminClient.mockReturnValue(admin.client)
    const { salvarConfiguracaoAdmin } = await import('@/app/actions/admin')

    const result = await salvarConfiguracaoAdmin(chave, valor)

    expect(result).toEqual({ success: true })
    expect(admin.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ chave, valor, eh_segredo: true }),
      { onConflict: 'chave' }
    )
  })

  it('still persists a secret when the operator submits a real value', async () => {
    const admin = makeConfigAdminClient()
    mocks.createAdminClient.mockReturnValue(admin.client)
    const { salvarConfiguracaoAdmin } = await import('@/app/actions/admin')

    const result = await salvarConfiguracaoAdmin('WHATSAPP_ACCESS_TOKEN', 'rotated-token')

    expect(result).toEqual({ success: true })
    expect(admin.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ chave: 'WHATSAPP_ACCESS_TOKEN', valor: 'rotated-token', eh_segredo: true }),
      { onConflict: 'chave' }
    )
  })

  it('preserves a `_TOKEN` secret for any case and non-space whitespace', async () => {
    const admin = makeConfigAdminClient()
    mocks.createAdminClient.mockReturnValue(admin.client)
    const { salvarConfiguracaoAdmin } = await import('@/app/actions/admin')

    const result = await salvarConfiguracaoAdmin('telegram_bot_token', '\n\t')

    expect(result).toEqual({ success: true })
    expect(admin.upsert).not.toHaveBeenCalled()
  })

  it('keeps writing a blank non-secret configuration value', async () => {
    const admin = makeConfigAdminClient()
    mocks.createAdminClient.mockReturnValue(admin.client)
    const { salvarConfiguracaoAdmin } = await import('@/app/actions/admin')

    const result = await salvarConfiguracaoAdmin('EVOLUTION_API_URL', '')

    expect(result).toEqual({ success: true })
    expect(admin.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ chave: 'EVOLUTION_API_URL', valor: '', eh_segredo: false }),
      { onConflict: 'chave' }
    )
  })
})

describe('deletarUsuarioAdmin idempotent Auth completion', () => {
  it('completes a pending anonymisation when Auth already reports the user absent', async () => {
    const operator = makeOperatorClient('admin') as any
    operator.rpc = vi.fn()
      .mockResolvedValueOnce({ error: null })
      .mockResolvedValueOnce({ error: null })
    mocks.createClient.mockResolvedValue(operator)
    mocks.createAdminClient.mockReturnValue({ auth: { admin: { deleteUser: vi.fn().mockResolvedValue({ error: { status: 404, message: 'User not found' } }) } } })
    const { deletarUsuarioAdmin } = await import('@/app/actions/admin')
    await expect(deletarUsuarioAdmin('target-1')).resolves.toEqual({ success: true })
    expect(operator.rpc).toHaveBeenNthCalledWith(1, 'anonymizar_usuario_admin', { p_usuario_alvo_id: 'target-1' })
    expect(operator.rpc).toHaveBeenNthCalledWith(2, 'concluir_anonymizacao_usuario_admin', { p_usuario_alvo_id: 'target-1' })
  })

  it('keeps pending when Auth deletion fails and only completes after retry', async () => {
    const operator = makeOperatorClient('admin') as any
    operator.rpc = vi.fn().mockResolvedValue({ error: null })
    mocks.createClient.mockResolvedValue(operator)
    const deleteUser = vi.fn().mockResolvedValueOnce({ error: { status: 500, message: 'temporary failure' } }).mockResolvedValueOnce({ error: null })
    mocks.createAdminClient.mockReturnValue({ auth: { admin: { deleteUser } } })
    const { deletarUsuarioAdmin } = await import('@/app/actions/admin')
    expect((await deletarUsuarioAdmin('target-1')).error).toContain('ERRO_AUTH_DELETE_PENDENTE')
    expect(operator.rpc).toHaveBeenCalledTimes(1)
    await expect(deletarUsuarioAdmin('target-1')).resolves.toEqual({ success: true })
    expect(operator.rpc).toHaveBeenCalledTimes(3)
  })
})
