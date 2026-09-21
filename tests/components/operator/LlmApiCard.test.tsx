import React from 'react'
import { render, screen, fireEvent, waitFor, cleanup, act, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import LlmApiCard from '@/components/operator/integrations/LlmApiCard'
import {
  salvarConfiguracaoAdmin,
  listAuthorizedDeepSeekModels,
  testAuthorizedDeepSeekModel,
  testarConexaoLLM,
} from '@/app/actions/admin'

vi.mock('@/app/actions/admin', () => ({
  salvarConfiguracaoAdmin: vi.fn(),
  listAuthorizedDeepSeekModels: vi.fn(),
  testAuthorizedDeepSeekModel: vi.fn(),
  testarConexaoLLM: vi.fn(),
}))

const AUTHORIZED_MODELS = [
  { id: 'deepseek-chat', label: 'DeepSeek Chat (v3)' },
  { id: 'deepseek-reasoner', label: 'DeepSeek Reasoner (R1)' },
]

const RAW_SECRET = 'sk-raw-secret-must-never-render'

describe('LlmApiCard — integração DeepSeek', () => {
  const showToast = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(salvarConfiguracaoAdmin).mockResolvedValue({ success: true })
    vi.mocked(listAuthorizedDeepSeekModels).mockResolvedValue({
      success: true,
      models: AUTHORIZED_MODELS,
    })
    vi.mocked(testAuthorizedDeepSeekModel).mockResolvedValue({
      success: true,
      model: 'deepseek-chat',
    })
  })

  afterEach(() => {
    cleanup()
  })

  const renderCard = (initialConfigs: Record<string, string> = {}) =>
    render(<LlmApiCard initialConfigs={initialConfigs} showToast={showToast} />)

  const waitForModels = async () => {
    await waitFor(() => {
      expect(vi.mocked(listAuthorizedDeepSeekModels)).toHaveBeenCalled()
    })
    await waitFor(() => {
      expect(screen.getByLabelText(/DEEPSEEK_MODEL/i)).toBeInTheDocument()
    })
  }

  it('renderiza o card DeepSeek sem nenhum controle legado de provedor', async () => {
    renderCard({ DEEPSEEK_CONFIGURED: 'true' })
    await waitForModels()

    expect(screen.getByRole('heading', { name: /DeepSeek/i })).toBeInTheDocument()

    // Provedores, roteamento e contingência legados: ausentes do card.
    expect(screen.queryByText(/OmniRoute/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/OpenRouter/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/fallback/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/business-economy/)).not.toBeInTheDocument()
    expect(screen.queryByText(/business-smart/)).not.toBeInTheDocument()
    expect(screen.queryByText(/business-frontier/)).not.toBeInTheDocument()
    expect(screen.queryByText(/OMNIROUTE_BASE_URL/)).not.toBeInTheDocument()
    expect(screen.queryByText(/OMNIROUTE_API_KEY/)).not.toBeInTheDocument()
    expect(screen.queryByText(/3-Tiers|Tier 1|Tier 2|Tier 3/)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Testar Economy/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Testar Smart/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Testar Frontier/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Conting[êe]ncia/i })).not.toBeInTheDocument()

    // Nenhuma action legada pode ser acionada por este card. `testarConexaoOmniRoute`
    // foi removida das actions, então apenas `testarConexaoLLM` ainda exige guarda.
    expect(vi.mocked(testarConexaoLLM)).not.toHaveBeenCalled()
  })

  it('indica o status de configuração a partir de DEEPSEEK_CONFIGURED', () => {
    const { unmount } = renderCard({ DEEPSEEK_CONFIGURED: 'true' })
    // Exact badge text: helper copy also mentions "DeepSeek configurada".
    expect(screen.getByText('DeepSeek configurada')).toBeInTheDocument()
    expect(screen.queryByText('DeepSeek não configurada')).not.toBeInTheDocument()
    unmount()

    renderCard({ DEEPSEEK_CONFIGURED: 'false' })
    expect(screen.queryByText('DeepSeek configurada')).not.toBeInTheDocument()
    expect(screen.getByText('DeepSeek não configurada')).toBeInTheDocument()
  })

  it('mantém a chave write-only e nunca exibe segredos vindos de initialConfigs', async () => {
    renderCard({
      DEEPSEEK_API_KEY: RAW_SECRET,
      DEEPSEEK_CONFIGURED: 'true',
      DEEPSEEK_MODEL: 'deepseek-chat',
    })
    await waitForModels()

    const keyInput = screen.getByLabelText(/DEEPSEEK_API_KEY/i) as HTMLInputElement
    expect(keyInput).toHaveAttribute('type', 'password')
    expect(keyInput.value).toBe('')
    expect(document.body.innerHTML).not.toContain(RAW_SECRET)
  })

  it('carrega os modelos autorizados pela action e permite selecionar um deles', async () => {
    renderCard({ DEEPSEEK_CONFIGURED: 'true' })
    await waitForModels()

    const select = screen.getByLabelText(/DEEPSEEK_MODEL/i) as HTMLSelectElement

    await waitFor(() => {
      expect(within(select).getAllByRole('option')).toHaveLength(AUTHORIZED_MODELS.length)
    })

    expect(within(select).getByRole('option', { name: 'DeepSeek Chat (v3)' })).toHaveValue(
      'deepseek-chat'
    )
    expect(within(select).getByRole('option', { name: 'DeepSeek Reasoner (R1)' })).toHaveValue(
      'deepseek-reasoner'
    )

    fireEvent.change(select, { target: { value: 'deepseek-reasoner' } })
    expect(select.value).toBe('deepseek-reasoner')
    expect(vi.mocked(listAuthorizedDeepSeekModels)).toHaveBeenCalledTimes(1)
  })

  it('exibe estado de carregamento enquanto a lista de modelos é buscada', async () => {
    let resolveModels: (value: { success: true; models: typeof AUTHORIZED_MODELS }) => void = () => {}
    vi.mocked(listAuthorizedDeepSeekModels).mockImplementation(
      () => new Promise((resolve) => { resolveModels = resolve })
    )

    renderCard({ DEEPSEEK_CONFIGURED: 'true' })

    expect(screen.getByText(/Carregando modelos autorizados/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Recarregar modelos/i })).toBeDisabled()

    await act(async () => {
      resolveModels({ success: true, models: AUTHORIZED_MODELS })
    })

    await waitFor(() => {
      expect(screen.queryByText(/Carregando modelos autorizados/i)).not.toBeInTheDocument()
    })
  })

  it('exibe erro seguro e permite recarregar os modelos', async () => {
    vi.mocked(listAuthorizedDeepSeekModels).mockResolvedValue({
      success: false,
      error: 'DEEPSEEK_HTTP_ERROR',
    })

    renderCard({ DEEPSEEK_CONFIGURED: 'true' })

    const errorText = await screen.findByText(/recusou a consulta de modelos/i)
    expect(errorText).toBeInTheDocument()

    vi.mocked(listAuthorizedDeepSeekModels).mockResolvedValue({
      success: true,
      models: AUTHORIZED_MODELS,
    })

    fireEvent.click(screen.getByRole('button', { name: /Recarregar modelos/i }))

    await waitFor(() => {
      expect(vi.mocked(listAuthorizedDeepSeekModels)).toHaveBeenCalledTimes(2)
    })
    await waitFor(() => {
      expect(screen.queryByText(/recusou a consulta de modelos/i)).not.toBeInTheDocument()
    })
  })

  it('exibe estado vazio quando nenhum modelo é devolvido e permite recarregar', async () => {
    vi.mocked(listAuthorizedDeepSeekModels).mockResolvedValue({ success: true, models: [] })

    renderCard({ DEEPSEEK_CONFIGURED: 'true' })

    expect(await screen.findByText(/Nenhum modelo autorizado/i)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Recarregar modelos/i }))

    await waitFor(() => {
      expect(vi.mocked(listAuthorizedDeepSeekModels)).toHaveBeenCalledTimes(2)
    })
  })

  it('não renderiza nenhum modelo hardcoded quando a listagem falha', async () => {
    vi.mocked(listAuthorizedDeepSeekModels).mockResolvedValue({
      success: false,
      error: 'DEEPSEEK_NOT_CONFIGURED',
    })

    renderCard({})

    expect(await screen.findByText(/Nenhuma chave DeepSeek válida/i)).toBeInTheDocument()

    const select = screen.getByLabelText(/DEEPSEEK_MODEL/i) as HTMLSelectElement
    const options = within(select).getAllByRole('option')
    expect(options).toHaveLength(1)
    expect(options[0]).toHaveValue('')
    expect(document.body.innerHTML).not.toContain('deepseek-chat')
    expect(document.body.innerHTML).not.toContain('deepseek-reasoner')
  })

  it('não inventa opções de modelo a partir do modelo salvo quando a listagem falha', async () => {
    vi.mocked(listAuthorizedDeepSeekModels).mockResolvedValue({
      success: false,
      error: 'DEEPSEEK_NOT_CONFIGURED',
    })

    renderCard({ DEEPSEEK_CONFIGURED: 'true', DEEPSEEK_MODEL: 'modelo-antigo-fora-do-catalogo' })

    expect(await screen.findByText(/Nenhuma chave DeepSeek válida/i)).toBeInTheDocument()

    // A lista é a única fonte de opções: nada de modelo salvo virando catálogo local.
    const select = screen.getByLabelText(/DEEPSEEK_MODEL/i) as HTMLSelectElement
    const options = within(select).getAllByRole('option')
    expect(options).toHaveLength(1)
    expect(options[0]).toHaveTextContent('Nenhum modelo disponível')
    expect(document.body.innerHTML).not.toContain('modelo-antigo-fora-do-catalogo')
  })

  it('salva apenas o modelo selecionado quando a chave está em branco', async () => {
    renderCard({ DEEPSEEK_CONFIGURED: 'true' })
    await waitForModels()

    const select = screen.getByLabelText(/DEEPSEEK_MODEL/i) as HTMLSelectElement
    await waitFor(() => {
      expect(within(select).getAllByRole('option')).toHaveLength(AUTHORIZED_MODELS.length)
    })
    fireEvent.change(select, { target: { value: 'deepseek-reasoner' } })

    fireEvent.click(screen.getByRole('button', { name: /Salvar configurações da DeepSeek/i }))

    await waitFor(() => {
      expect(vi.mocked(salvarConfiguracaoAdmin)).toHaveBeenCalledTimes(1)
    })
    expect(vi.mocked(salvarConfiguracaoAdmin).mock.calls).toEqual([
      ['DEEPSEEK_MODEL', 'deepseek-reasoner'],
    ])
    expect(vi.mocked(salvarConfiguracaoAdmin)).not.toHaveBeenCalledWith(
      'DEEPSEEK_API_KEY',
      expect.anything()
    )
    expect(vi.mocked(salvarConfiguracaoAdmin)).not.toHaveBeenCalledWith(
      'OMNIROUTE_API_KEY',
      expect.anything()
    )
    expect(vi.mocked(salvarConfiguracaoAdmin)).not.toHaveBeenCalledWith(
      'OPENROUTER_API_KEY',
      expect.anything()
    )
  })

  it('salva a chave informada e limpa o campo write-only', async () => {
    renderCard({ DEEPSEEK_CONFIGURED: 'true' })
    await waitForModels()

    const select = screen.getByLabelText(/DEEPSEEK_MODEL/i) as HTMLSelectElement
    await waitFor(() => {
      expect(within(select).getAllByRole('option')).toHaveLength(AUTHORIZED_MODELS.length)
    })

    const keyInput = screen.getByLabelText(/DEEPSEEK_API_KEY/i) as HTMLInputElement
    fireEvent.change(keyInput, { target: { value: 'sk-typed-operator-key' } })

    fireEvent.click(screen.getByRole('button', { name: /Salvar configurações da DeepSeek/i }))

    await waitFor(() => {
      expect(vi.mocked(salvarConfiguracaoAdmin)).toHaveBeenCalledWith(
        'DEEPSEEK_API_KEY',
        'sk-typed-operator-key'
      )
    })
    expect(vi.mocked(salvarConfiguracaoAdmin)).toHaveBeenCalledWith('DEEPSEEK_MODEL', 'deepseek-chat')
    await waitFor(() => {
      expect(keyInput.value).toBe('')
    })
    expect(document.body.innerHTML).not.toContain('sk-typed-operator-key')
  })

  it('mantém a chave digitada e avisa o operador quando o salvamento falha', async () => {
    vi.mocked(salvarConfiguracaoAdmin).mockResolvedValue({
      success: false,
      error: 'ERRO_SALVAR_CONFIG',
    })

    renderCard({ DEEPSEEK_CONFIGURED: 'true' })
    await waitForModels()

    const keyInput = screen.getByLabelText(/DEEPSEEK_API_KEY/i) as HTMLInputElement
    fireEvent.change(keyInput, { target: { value: 'sk-failing-save-key' } })

    fireEvent.click(screen.getByRole('button', { name: /Salvar configurações da DeepSeek/i }))

    await waitFor(() => {
      expect(showToast).toHaveBeenCalledWith('error', expect.stringContaining('Falha ao salvar'))
    })
    expect(showToast).not.toHaveBeenCalledWith('success', expect.any(String))
    // A falha não pode apagar a credencial que o operador acabou de digitar.
    expect(keyInput.value).toBe('sk-failing-save-key')
  })

  it('recarrega a lista de modelos depois de salvar uma nova chave', async () => {
    renderCard({ DEEPSEEK_CONFIGURED: 'true' })
    await waitForModels()

    const keyInput = screen.getByLabelText(/DEEPSEEK_API_KEY/i) as HTMLInputElement
    fireEvent.change(keyInput, { target: { value: 'sk-new-operator-key' } })

    fireEvent.click(screen.getByRole('button', { name: /Salvar configurações da DeepSeek/i }))

    await waitFor(() => {
      expect(vi.mocked(listAuthorizedDeepSeekModels)).toHaveBeenCalledTimes(2)
    })
  })

  it('não chama a action de salvar quando não há chave nem modelo', async () => {
    vi.mocked(listAuthorizedDeepSeekModels).mockResolvedValue({ success: true, models: [] })

    renderCard({})

    expect(await screen.findByText(/Nenhum modelo autorizado/i)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Salvar configurações da DeepSeek/i }))

    await waitFor(() => {
      expect(showToast).toHaveBeenCalledWith('error', expect.any(String))
    })
    expect(vi.mocked(salvarConfiguracaoAdmin)).not.toHaveBeenCalled()
  })

  it('testa o modelo configurado passando apenas o id do modelo', async () => {
    renderCard({ DEEPSEEK_CONFIGURED: 'true' })
    await waitForModels()

    const select = screen.getByLabelText(/DEEPSEEK_MODEL/i) as HTMLSelectElement
    await waitFor(() => {
      expect(within(select).getAllByRole('option')).toHaveLength(AUTHORIZED_MODELS.length)
    })
    fireEvent.change(select, { target: { value: 'deepseek-reasoner' } })

    fireEvent.click(screen.getByRole('button', { name: /Testar modelo/i }))

    await waitFor(() => {
      expect(vi.mocked(testAuthorizedDeepSeekModel)).toHaveBeenCalledTimes(1)
    })
    expect(vi.mocked(testAuthorizedDeepSeekModel).mock.calls[0]).toEqual(['deepseek-reasoner'])
    expect(await screen.findByText(/respondeu com sucesso/i)).toBeInTheDocument()
  })

  it('exibe falha segura ao testar o modelo', async () => {
    vi.mocked(testAuthorizedDeepSeekModel).mockResolvedValue({
      success: false,
      error: 'DEEPSEEK_NOT_CONFIGURED',
    })

    renderCard({ DEEPSEEK_CONFIGURED: 'true' })
    await waitForModels()

    fireEvent.click(screen.getByRole('button', { name: /Testar modelo/i }))

    expect(await screen.findByText(/Nenhuma chave DeepSeek válida/i)).toBeInTheDocument()
    expect(vi.mocked(testAuthorizedDeepSeekModel).mock.calls[0]).toEqual(['deepseek-chat'])
  })
})
