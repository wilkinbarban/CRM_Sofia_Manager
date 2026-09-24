import React from 'react'
import { render, screen, fireEvent, waitFor, cleanup, act, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import LlmApiCard from '@/components/operator/integrations/LlmApiCard'
import {
  salvarConfiguracaoAdmin,
  listAuthorizedDeepSeekModels,
  testAuthorizedDeepSeekModel,
} from '@/app/actions/admin'

vi.mock('@/app/actions/admin', () => ({
  salvarConfiguracaoAdmin: vi.fn(),
  listAuthorizedDeepSeekModels: vi.fn(),
  testAuthorizedDeepSeekModel: vi.fn(),
}))

const AUTHORIZED_MODELS = [
  { id: 'deepseek-chat', label: 'DeepSeek Chat (v3)' },
  { id: 'deepseek-reasoner', label: 'DeepSeek Reasoner (R1)' },
]

const RAW_SECRET = 'sk-raw-secret-must-never-render'

function createDeferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

type ListAuthorizedModelsResult = Awaited<ReturnType<typeof listAuthorizedDeepSeekModels>>

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
    expect(within(select).queryByText('modelo-antigo-fora-do-catalogo')).not.toBeInTheDocument()
    expect(within(select).queryByRole('option', { name: /modelo-antigo-fora-do-catalogo/ })).not.toBeInTheDocument()
    // O modelo efetivo é exibido no badge separado.
    expect(screen.getByText('modelo-antigo-fora-do-catalogo')).toBeInTheDocument()
    expect(screen.getByText(/Modelo efetivo:/i)).toBeInTheDocument()
  })

  it('exibe o modelo efetivo em badge separado e preserva o catálogo com opções autorizadas', async () => {
    renderCard({ DEEPSEEK_CONFIGURED: 'true', DEEPSEEK_MODEL: 'deepseek-chat' })
    await waitForModels()

    const badge = screen.getByTestId('deepseek-effective-model-badge')
    expect(badge).toHaveTextContent('Modelo efetivo:')
    expect(badge).toHaveTextContent('deepseek-chat')
    expect(screen.queryByText(/Fora do catálogo/i)).not.toBeInTheDocument()

    const select = screen.getByLabelText(/DEEPSEEK_MODEL/i) as HTMLSelectElement
    const options = within(select).getAllByRole('option')
    expect(options).toHaveLength(AUTHORIZED_MODELS.length)
    expect(select.value).toBe('deepseek-chat')
  })

  it('exibe indicador no badge quando o modelo efetivo está ausente do catálogo sem mutar as opções do select', async () => {
    renderCard({ DEEPSEEK_CONFIGURED: 'true', DEEPSEEK_MODEL: 'deepseek-flash' })
    await waitForModels()

    // O badge renderiza o modelo efetivo e sinaliza que está fora do catálogo.
    const badge = screen.getByTestId('deepseek-effective-model-badge')
    expect(badge).toHaveTextContent('Modelo efetivo:')
    expect(badge).toHaveTextContent('deepseek-flash')
    expect(within(badge).getByText(/Fora do catálogo/i)).toBeInTheDocument()

    // O select mantém estritamente as opções do catálogo autorizado; deepseek-flash não vira opção.
    const select = screen.getByLabelText(/DEEPSEEK_MODEL/i) as HTMLSelectElement
    const options = within(select).getAllByRole('option')
    expect(options).toHaveLength(AUTHORIZED_MODELS.length)
    expect(within(select).queryByText('deepseek-flash')).not.toBeInTheDocument()
    expect(within(select).queryByRole('option', { name: /deepseek-flash/ })).not.toBeInTheDocument()
  })

  it('atualiza o badge de modelo efetivo ao salvar novo modelo com sucesso', async () => {
    renderCard({ DEEPSEEK_CONFIGURED: 'true', DEEPSEEK_MODEL: 'deepseek-flash' })
    await waitForModels()

    const select = screen.getByLabelText(/DEEPSEEK_MODEL/i) as HTMLSelectElement
    fireEvent.change(select, { target: { value: 'deepseek-reasoner' } })

    fireEvent.click(screen.getByRole('button', { name: /Salvar configurações da DeepSeek/i }))

    await waitFor(() => {
      expect(vi.mocked(salvarConfiguracaoAdmin)).toHaveBeenCalledWith(
        'DEEPSEEK_MODEL',
        'deepseek-reasoner'
      )
    })

    const badge = screen.getByTestId('deepseek-effective-model-badge')
    expect(badge).toHaveTextContent('deepseek-reasoner')
    expect(screen.queryByText(/Fora do catálogo/i)).not.toBeInTheDocument()
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

  it('desabilita o teste e não envia modelo ao salvar quando a listagem de modelos falha mesmo com modelo inicial configurado', async () => {
    vi.mocked(listAuthorizedDeepSeekModels).mockResolvedValue({
      success: false,
      error: 'DEEPSEEK_NOT_CONFIGURED',
    })

    renderCard({ DEEPSEEK_CONFIGURED: 'true', DEEPSEEK_MODEL: 'deepseek-chat' })

    expect(await screen.findByText(/Nenhuma chave DeepSeek válida/i)).toBeInTheDocument()

    const select = screen.getByLabelText(/DEEPSEEK_MODEL/i) as HTMLSelectElement
    expect(select.value).toBe('')

    const testButton = screen.getByRole('button', { name: /Testar modelo/i })
    expect(testButton).toBeDisabled()

    const keyInput = screen.getByLabelText(/DEEPSEEK_API_KEY/i) as HTMLInputElement
    fireEvent.change(keyInput, { target: { value: 'sk-new-key' } })

    fireEvent.click(screen.getByRole('button', { name: /Salvar configurações da DeepSeek/i }))

    await waitFor(() => {
      expect(vi.mocked(salvarConfiguracaoAdmin)).toHaveBeenCalledWith(
        'DEEPSEEK_API_KEY',
        'sk-new-key'
      )
    })
    expect(vi.mocked(salvarConfiguracaoAdmin)).not.toHaveBeenCalledWith(
      'DEEPSEEK_MODEL',
      expect.anything()
    )
  })

  it('desabilita o botão de testar e não envia modelo quando o catálogo retorna vazio com modelo inicial configurado', async () => {
    vi.mocked(listAuthorizedDeepSeekModels).mockResolvedValue({ success: true, models: [] })

    renderCard({ DEEPSEEK_CONFIGURED: 'true', DEEPSEEK_MODEL: 'deepseek-chat' })

    expect(await screen.findByText(/Nenhum modelo autorizado/i)).toBeInTheDocument()

    const select = screen.getByLabelText(/DEEPSEEK_MODEL/i) as HTMLSelectElement
    expect(select.value).toBe('')

    const testButton = screen.getByRole('button', { name: /Testar modelo/i })
    expect(testButton).toBeDisabled()

    const keyInput = screen.getByLabelText(/DEEPSEEK_API_KEY/i) as HTMLInputElement
    fireEvent.change(keyInput, { target: { value: 'sk-new-key-2' } })

    fireEvent.click(screen.getByRole('button', { name: /Salvar configurações da DeepSeek/i }))

    await waitFor(() => {
      expect(vi.mocked(salvarConfiguracaoAdmin)).toHaveBeenCalledWith(
        'DEEPSEEK_API_KEY',
        'sk-new-key-2'
      )
    })
    expect(vi.mocked(salvarConfiguracaoAdmin)).not.toHaveBeenCalledWith(
      'DEEPSEEK_MODEL',
      expect.anything()
    )
  })

  it('alinha a seleção do catálogo, o teste e o salvamento quando o modelo efetivo está fora do catálogo', async () => {
    renderCard({ DEEPSEEK_CONFIGURED: 'true', DEEPSEEK_MODEL: 'deepseek-flash' })
    await waitForModels()

    const badge = screen.getByTestId('deepseek-effective-model-badge')
    expect(badge).toHaveTextContent('Modelo efetivo:')
    expect(badge).toHaveTextContent('deepseek-flash')
    expect(within(badge).getByText(/Fora do catálogo/i)).toBeInTheDocument()

    const select = screen.getByLabelText(/DEEPSEEK_MODEL/i) as HTMLSelectElement
    expect(select.value).toBe('deepseek-chat')

    fireEvent.click(screen.getByRole('button', { name: /Testar modelo/i }))
    await waitFor(() => {
      expect(vi.mocked(testAuthorizedDeepSeekModel)).toHaveBeenCalledTimes(1)
    })
    expect(vi.mocked(testAuthorizedDeepSeekModel).mock.calls[0]).toEqual(['deepseek-chat'])

    fireEvent.click(screen.getByRole('button', { name: /Salvar configurações da DeepSeek/i }))
    await waitFor(() => {
      expect(vi.mocked(salvarConfiguracaoAdmin)).toHaveBeenCalledWith(
        'DEEPSEEK_MODEL',
        'deepseek-chat'
      )
    })

    expect(badge).toHaveTextContent('deepseek-chat')
    expect(screen.queryByText(/Fora do catálogo/i)).not.toBeInTheDocument()
  })

  it('preserva a seleção do modelo ao recarregar a lista e usa o modelo selecionado no teste e no salvamento', async () => {
    renderCard({ DEEPSEEK_CONFIGURED: 'true', DEEPSEEK_MODEL: 'deepseek-chat' })
    await waitForModels()

    const select = screen.getByLabelText(/DEEPSEEK_MODEL/i) as HTMLSelectElement
    expect(select.value).toBe('deepseek-chat')

    // Usuário seleciona reasoner
    fireEvent.change(select, { target: { value: 'deepseek-reasoner' } })
    expect(select.value).toBe('deepseek-reasoner')

    // Recarregar modelos retorna novo array (como na resposta real de rede)
    vi.mocked(listAuthorizedDeepSeekModels).mockResolvedValueOnce({
      success: true,
      models: [...AUTHORIZED_MODELS],
    })
    fireEvent.click(screen.getByRole('button', { name: /Recarregar modelos/i }))

    await waitFor(() => {
      expect(vi.mocked(listAuthorizedDeepSeekModels)).toHaveBeenCalledTimes(2)
    })
    await waitFor(() => {
      expect(screen.queryByText(/Carregando modelos autorizados/i)).not.toBeInTheDocument()
    })

    // A seleção deve permanecer reasoner mesmo após o reload dos modelos
    expect(select.value).toBe('deepseek-reasoner')

    // Testar modelo deve usar reasoner
    fireEvent.click(screen.getByRole('button', { name: /Testar modelo/i }))
    await waitFor(() => {
      expect(vi.mocked(testAuthorizedDeepSeekModel)).toHaveBeenCalledTimes(1)
    })
    expect(vi.mocked(testAuthorizedDeepSeekModel)).toHaveBeenCalledWith('deepseek-reasoner')

    // O badge de modelo efetivo permanece intacto até o salvamento
    const badge = screen.getByTestId('deepseek-effective-model-badge')
    expect(badge).toHaveTextContent('deepseek-chat')

    // Salvar configurações deve usar reasoner
    fireEvent.click(screen.getByRole('button', { name: /Salvar configurações da DeepSeek/i }))
    await waitFor(() => {
      expect(vi.mocked(salvarConfiguracaoAdmin)).toHaveBeenCalledWith(
        'DEEPSEEK_MODEL',
        'deepseek-reasoner'
      )
    })

    // Após salvar, o badge de modelo efetivo atualiza para reasoner
    expect(badge).toHaveTextContent('deepseek-reasoner')
    expect(screen.queryByText(/Fora do catálogo/i)).not.toBeInTheDocument()
  })

  it('reverte para o modelo configurado inicial quando o modelo selecionado deixa de existir após recarga', async () => {
    renderCard({ DEEPSEEK_CONFIGURED: 'true', DEEPSEEK_MODEL: 'deepseek-chat' })
    await waitForModels()

    const select = screen.getByLabelText(/DEEPSEEK_MODEL/i) as HTMLSelectElement
    fireEvent.change(select, { target: { value: 'deepseek-reasoner' } })
    expect(select.value).toBe('deepseek-reasoner')

    // Recarrega apenas com deepseek-chat no catálogo (reasoner foi descontinuado pelo provedor)
    vi.mocked(listAuthorizedDeepSeekModels).mockResolvedValueOnce({
      success: true,
      models: [{ id: 'deepseek-chat', label: 'DeepSeek Chat (v3)' }],
    })
    fireEvent.click(screen.getByRole('button', { name: /Recarregar modelos/i }))

    await waitFor(() => {
      expect(vi.mocked(listAuthorizedDeepSeekModels)).toHaveBeenCalledTimes(2)
    })
    await waitFor(() => {
      expect(screen.queryByText(/Carregando modelos autorizados/i)).not.toBeInTheDocument()
    })

    // Como reasoner não está mais no catálogo, recua com segurança para o modelo configurado inicial
    expect(select.value).toBe('deepseek-chat')
  })

  describe('regressões de concorrência com deferred-promises (latest-request-wins)', () => {
    it('garante que a resposta mais recente vença quando carregamentos de catálogo resolvem fora de ordem', async () => {
      const initialDeferred = createDeferred<ListAuthorizedModelsResult>()
      const reloadDeferred = createDeferred<ListAuthorizedModelsResult>()

      vi.mocked(listAuthorizedDeepSeekModels)
        .mockImplementationOnce(() => initialDeferred.promise)
        .mockImplementationOnce(() => reloadDeferred.promise)

      renderCard({ DEEPSEEK_CONFIGURED: 'true', DEEPSEEK_MODEL: 'deepseek-chat' })
      expect(vi.mocked(listAuthorizedDeepSeekModels)).toHaveBeenCalledTimes(1)

      // Enquanto a carga inicial está pendente, o operador salva uma chave, disparando novo loadModels()
      const keyInput = screen.getByLabelText(/DEEPSEEK_API_KEY/i) as HTMLInputElement
      fireEvent.change(keyInput, { target: { value: 'sk-new-key' } })
      fireEvent.click(screen.getByRole('button', { name: /Salvar configurações da DeepSeek/i }))

      await waitFor(() => {
        expect(vi.mocked(listAuthorizedDeepSeekModels)).toHaveBeenCalledTimes(2)
      })

      const NEWER_MODELS = [{ id: 'deepseek-reasoner', label: 'DeepSeek Reasoner (R1)' }]
      const OLDER_MODELS = [{ id: 'deepseek-chat', label: 'DeepSeek Chat (v3)' }]

      // Resposta mais recente (requisição 2) resolve primeiro com sucesso
      await act(async () => {
        reloadDeferred.resolve({ success: true, models: NEWER_MODELS })
      })

      const select = screen.getByLabelText(/DEEPSEEK_MODEL/i) as HTMLSelectElement
      await waitFor(() => {
        expect(select.value).toBe('deepseek-reasoner')
      })
      expect(within(select).getByRole('option', { name: 'DeepSeek Reasoner (R1)' })).toBeInTheDocument()
      expect(within(select).queryByRole('option', { name: 'DeepSeek Chat (v3)' })).not.toBeInTheDocument()

      // Resposta mais antiga (requisição 1) resolve depois (fora de ordem)
      await act(async () => {
        initialDeferred.resolve({ success: true, models: OLDER_MODELS })
      })

      // A resposta mais recente deve continuar vencendo; a mais antiga não pode sobrescrever o catálogo
      expect(select.value).toBe('deepseek-reasoner')
      expect(within(select).getByRole('option', { name: 'DeepSeek Reasoner (R1)' })).toBeInTheDocument()
      expect(within(select).queryByRole('option', { name: 'DeepSeek Chat (v3)' })).not.toBeInTheDocument()
    })

    it('ignora rejeição de carregamento mais antigo quando a resposta mais recente já foi aplicada', async () => {
      const initialDeferred = createDeferred<ListAuthorizedModelsResult>()
      const reloadDeferred = createDeferred<ListAuthorizedModelsResult>()

      vi.mocked(listAuthorizedDeepSeekModels)
        .mockImplementationOnce(() => initialDeferred.promise)
        .mockImplementationOnce(() => reloadDeferred.promise)

      renderCard({ DEEPSEEK_CONFIGURED: 'true', DEEPSEEK_MODEL: 'deepseek-chat' })
      expect(vi.mocked(listAuthorizedDeepSeekModels)).toHaveBeenCalledTimes(1)

      const keyInput = screen.getByLabelText(/DEEPSEEK_API_KEY/i) as HTMLInputElement
      fireEvent.change(keyInput, { target: { value: 'sk-new-key' } })
      fireEvent.click(screen.getByRole('button', { name: /Salvar configurações da DeepSeek/i }))

      await waitFor(() => {
        expect(vi.mocked(listAuthorizedDeepSeekModels)).toHaveBeenCalledTimes(2)
      })

      const NEWER_MODELS = [{ id: 'deepseek-reasoner', label: 'DeepSeek Reasoner (R1)' }]

      // Resposta mais recente resolve com sucesso
      await act(async () => {
        reloadDeferred.resolve({ success: true, models: NEWER_MODELS })
      })

      const select = screen.getByLabelText(/DEEPSEEK_MODEL/i) as HTMLSelectElement
      await waitFor(() => {
        expect(select.value).toBe('deepseek-reasoner')
      })

      // Requisição mais antiga é rejeitada com erro de rede posteriormente
      await act(async () => {
        initialDeferred.reject(new Error('Network timeout'))
      })

      // O catálogo bem-sucedido mais recente deve permanecer intacto, sem erro na UI
      expect(select.value).toBe('deepseek-reasoner')
      expect(within(select).getByRole('option', { name: 'DeepSeek Reasoner (R1)' })).toBeInTheDocument()
      expect(screen.queryByText(/Não foi possível concluir a operação com a DeepSeek/i)).not.toBeInTheDocument()
    })

    it('ignora falha segura de carregamento mais antigo quando a resposta mais recente já foi aplicada', async () => {
      const initialDeferred = createDeferred<ListAuthorizedModelsResult>()
      const reloadDeferred = createDeferred<ListAuthorizedModelsResult>()

      vi.mocked(listAuthorizedDeepSeekModels)
        .mockImplementationOnce(() => initialDeferred.promise)
        .mockImplementationOnce(() => reloadDeferred.promise)

      renderCard({ DEEPSEEK_CONFIGURED: 'true', DEEPSEEK_MODEL: 'deepseek-chat' })
      expect(vi.mocked(listAuthorizedDeepSeekModels)).toHaveBeenCalledTimes(1)

      const keyInput = screen.getByLabelText(/DEEPSEEK_API_KEY/i) as HTMLInputElement
      fireEvent.change(keyInput, { target: { value: 'sk-new-key' } })
      fireEvent.click(screen.getByRole('button', { name: /Salvar configurações da DeepSeek/i }))

      await waitFor(() => {
        expect(vi.mocked(listAuthorizedDeepSeekModels)).toHaveBeenCalledTimes(2)
      })

      const NEWER_MODELS = [{ id: 'deepseek-reasoner', label: 'DeepSeek Reasoner (R1)' }]

      // Resposta mais recente resolve com sucesso
      await act(async () => {
        reloadDeferred.resolve({ success: true, models: NEWER_MODELS })
      })

      const select = screen.getByLabelText(/DEEPSEEK_MODEL/i) as HTMLSelectElement
      await waitFor(() => {
        expect(select.value).toBe('deepseek-reasoner')
      })

      // Requisição mais antiga resolve com erro seguro da DeepSeek posteriormente
      await act(async () => {
        initialDeferred.resolve({ success: false, error: 'DEEPSEEK_HTTP_ERROR' })
      })

      // O catálogo bem-sucedido mais recente deve permanecer intacto, sem mensagem de erro na UI
      expect(select.value).toBe('deepseek-reasoner')
      expect(within(select).getByRole('option', { name: 'DeepSeek Reasoner (R1)' })).toBeInTheDocument()
      expect(screen.queryByText(/recusou a consulta de modelos/i)).not.toBeInTheDocument()
    })

    it('preserva a seleção do modelo ativo quando recargas sobrepostas resolvem fora de ordem', async () => {
      // Carga inicial completa normalmente
      renderCard({ DEEPSEEK_CONFIGURED: 'true', DEEPSEEK_MODEL: 'deepseek-chat' })
      await waitForModels()

      const select = screen.getByLabelText(/DEEPSEEK_MODEL/i) as HTMLSelectElement
      fireEvent.change(select, { target: { value: 'deepseek-reasoner' } })
      expect(select.value).toBe('deepseek-reasoner')

      const reload1Deferred = createDeferred<ListAuthorizedModelsResult>()
      const reload2Deferred = createDeferred<ListAuthorizedModelsResult>()

      vi.mocked(listAuthorizedDeepSeekModels)
        .mockImplementationOnce(() => reload1Deferred.promise)
        .mockImplementationOnce(() => reload2Deferred.promise)

      // Dispara primeira recarga clicando em Recarregar
      fireEvent.click(screen.getByRole('button', { name: /Recarregar modelos/i }))
      expect(vi.mocked(listAuthorizedDeepSeekModels)).toHaveBeenCalledTimes(2)

      // Enquanto a recarga 1 está pendente, salva chave para disparar recarga 2
      const keyInput = screen.getByLabelText(/DEEPSEEK_API_KEY/i) as HTMLInputElement
      fireEvent.change(keyInput, { target: { value: 'sk-another-key' } })
      fireEvent.click(screen.getByRole('button', { name: /Salvar configurações da DeepSeek/i }))

      await waitFor(() => {
        expect(vi.mocked(listAuthorizedDeepSeekModels)).toHaveBeenCalledTimes(3)
      })

      // Recarga 2 (mais recente) resolve primeiro, mantendo deepseek-reasoner no catálogo
      await act(async () => {
        reload2Deferred.resolve({ success: true, models: AUTHORIZED_MODELS })
      })

      expect(select.value).toBe('deepseek-reasoner')

      // Recarga 1 (mais antiga) resolve depois apenas com deepseek-chat
      await act(async () => {
        reload1Deferred.resolve({
          success: true,
          models: [{ id: 'deepseek-chat', label: 'DeepSeek Chat (v3)' }],
        })
      })

      // A seleção deve permanecer 'deepseek-reasoner' porque a recarga 1 foi superada
      expect(select.value).toBe('deepseek-reasoner')
      expect(within(select).getByRole('option', { name: 'DeepSeek Reasoner (R1)' })).toBeInTheDocument()
    })
  })
})
