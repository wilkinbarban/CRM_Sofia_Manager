/**
 * Slice 9 (tasks 36-39) of `sofia-customer-memory`: the operator facts surface.
 *
 * Falsifiability rules applied here:
 * - the review assertions inspect the mocked action's recorded call arguments, because a rendered
 *   label would also be present if the action were never called;
 * - the fourth tab is proven by moving real focus onto its node (arrow keys, Home, End) and by the
 *   action being called with the selected customer, not by counting buttons;
 * - every negative case asserts an absence (no row, no leaked token), so a mis-wired panel fails.
 */
import React from 'react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ClientCrmPanel from '@/components/operator/ClientCrmPanel'
import OperatorClientFactsPanel from '@/components/operator/OperatorClientFactsPanel'
import type { FatoClienteListado } from '@/app/actions/fatos-cliente'

const mocks = vi.hoisted(() => ({
  listarFatosCliente: vi.fn(),
  revisarFatoCliente: vi.fn(),
  atualizarClienteCrm: vi.fn(),
}))

vi.mock('@/app/actions/fatos-cliente', () => ({
  listarFatosCliente: mocks.listarFatosCliente,
  revisarFatoCliente: mocks.revisarFatoCliente,
}))

vi.mock('@/app/actions/clientes', () => ({ atualizarClienteCrm: mocks.atualizarClienteCrm }))

vi.mock('@/components/operator/OperatorCartPanel', () => ({
  default: () => <div data-testid="cart-panel">Cart content</div>,
}))

vi.mock('@/components/operator/OperatorClientOrdersList', () => ({
  default: () => <div data-testid="orders-panel">Orders content</div>,
}))

const CLIENTE = {
  id: 'id-cliente-1',
  nome: 'Maria Silva',
  telefone: '5541999999999',
  endereco: null,
  tags: [],
  notas: null,
  score: 0,
}

const fato = (over: Partial<FatoClienteListado> & { fato_id: string }): FatoClienteListado => ({
  tipo: 'preferencia',
  chave: 'chave_base',
  valor: 'valor base',
  origem: 'ia',
  origem_conversa_id: null,
  confianca: null,
  estado: 'pendente',
  revisado_por: null,
  revisado_em: null,
  substitui_id: null,
  criado_em: '2026-09-18T12:00:00.000Z',
  atualizado_em: '2026-09-18T12:00:00.000Z',
  ...over,
})

const FATO_PENDENTE_IA = fato({
  fato_id: 'id-pendente',
  tipo: 'preferencia',
  chave: 'bebida_preferida',
  valor: 'Coca-Cola sem gelo',
  origem: 'ia',
  confianca: 0.87,
  origem_conversa_id: 'conv-9f2c4d1e',
  estado: 'pendente',
})

const FATOS = [
  FATO_PENDENTE_IA,
  fato({ fato_id: 'id-aprovado', tipo: 'endereco', chave: 'endereco_entrega', valor: 'Rua das Palmeiras, 120', origem: 'cliente', estado: 'aprovado' }),
  fato({ fato_id: 'id-rejeitado', tipo: 'formato_pedido', chave: 'formato_pedido', valor: 'Porção separada', origem: 'importado', estado: 'rejeitado' }),
  fato({ fato_id: 'id-substituido', tipo: 'restricao_alimentar', chave: 'sem_lactose', valor: 'Sem lactose', origem: 'operador', estado: 'substituido' }),
  fato({ fato_id: 'id-observacao', tipo: 'observacao', chave: 'observacao_atendimento', valor: 'Prefere contato por áudio', origem: 'operador', estado: 'aprovado' }),
]

const painel = () => <OperatorClientFactsPanel clienteId={CLIENTE.id} clienteNome={CLIENTE.nome} />
const linha = (fatoId: string) => screen.getByTestId(`fato-${fatoId}`)
const lista = () => screen.queryByTestId('fatos-lista')
const campo = (fatoId: string, nome: string) => within(linha(fatoId)).getByTestId(nome)

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  cleanup()
})

describe('OperatorClientFactsPanel: leitura dos fatos', () => {
  it('carrega os fatos do cliente apenas pela action de listagem', async () => {
    mocks.listarFatosCliente.mockResolvedValue({ success: true, data: FATOS })

    render(painel())

    await waitFor(() => expect(linha('id-pendente')).toBeInTheDocument())
    expect(mocks.listarFatosCliente).toHaveBeenCalledTimes(1)
    expect(mocks.listarFatosCliente).toHaveBeenCalledWith(CLIENTE.id)
    expect(within(lista()!).getAllByRole('listitem')).toHaveLength(FATOS.length)
  })

  it('mostra todos os estados com tipo, chave, valor e origem', async () => {
    mocks.listarFatosCliente.mockResolvedValue({ success: true, data: FATOS })

    render(painel())
    await waitFor(() => expect(linha('id-pendente')).toBeInTheDocument())

    const esperado: Array<[string, string, string, string, string, string, string, string]> = [
      ['id-pendente', 'pendente', 'Pendente', 'preferencia', 'bebida_preferida', 'Coca-Cola sem gelo', 'ia', 'IA (inferido)'],
      ['id-aprovado', 'aprovado', 'Aprovado', 'endereco', 'endereco_entrega', 'Rua das Palmeiras, 120', 'cliente', 'Cliente'],
      ['id-rejeitado', 'rejeitado', 'Rejeitado', 'formato_pedido', 'formato_pedido', 'Porção separada', 'importado', 'Importado'],
      ['id-substituido', 'substituido', 'Substituído', 'restricao_alimentar', 'sem_lactose', 'Sem lactose', 'operador', 'Operador'],
    ]

    for (const [fatoId, estado, rotuloEstado, tipo, chave, valor, origem, rotuloOrigem] of esperado) {
      const row = linha(fatoId)
      expect(row).toHaveAttribute('data-estado', estado)
      expect(campo(fatoId, 'fato-tipo')).toHaveTextContent(tipo)
      expect(campo(fatoId, 'fato-chave')).toHaveTextContent(chave)
      expect(campo(fatoId, 'fato-valor')).toHaveTextContent(valor)
      expect(row).toHaveAttribute('data-origem', origem)
      expect(campo(fatoId, 'fato-origem')).toHaveTextContent(rotuloOrigem)
      // Rótulo exato por estado: um mapeamento trocado (ex.: `rejeitado` -> "Aprovado") falha aqui.
      expect(campo(fatoId, 'fato-estado').textContent).toBe(rotuloEstado)
    }
  })

  it('conta no cabeçalho todas as linhas devolvidas, incluindo observacao', async () => {
    mocks.listarFatosCliente.mockResolvedValue({ success: true, data: FATOS })

    render(painel())
    await waitFor(() => expect(linha('id-pendente')).toBeInTheDocument())

    // `FATOS` tem cinco entradas, uma delas `observacao`: o cabeçalho conta as notas internas também.
    expect(FATOS.length).toBe(5)
    expect(screen.getByText('Fatos do cliente (5)')).toBeInTheDocument()
    expect(within(lista()!).getAllByRole('listitem')).toHaveLength(5)
    expect(linha('id-observacao')).toBeInTheDocument()
  })

  it('mostra origem "ia" com a confiança e omite confiança em fatos humanos', async () => {
    mocks.listarFatosCliente.mockResolvedValue({ success: true, data: FATOS })

    render(painel())
    await waitFor(() => expect(linha('id-pendente')).toBeInTheDocument())

    expect(linha('id-pendente')).toHaveAttribute('data-origem', 'ia')
    expect(linha('id-pendente')).toHaveAttribute('data-estado', 'pendente')
    expect(campo('id-pendente', 'fato-confianca')).toHaveTextContent('87%')

    // `confianca` existe apenas para `origem = 'ia'`: a linha sem confiança não deve ter o campo.
    expect(within(linha('id-aprovado')).queryByTestId('fato-confianca')).not.toBeInTheDocument()
    expect(within(linha('id-substituido')).queryByTestId('fato-confianca')).not.toBeInTheDocument()
  })

  it('mostra a conversa de origem de cada fato', async () => {
    mocks.listarFatosCliente.mockResolvedValue({ success: true, data: FATOS })

    render(painel())
    await waitFor(() => expect(linha('id-pendente')).toBeInTheDocument())

    expect(campo('id-pendente', 'fato-conversa')).toHaveTextContent('conv-9f2c4d1e')
    expect(campo('id-aprovado', 'fato-conversa')).toHaveTextContent('sem conversa de origem')
  })

  it('renderiza o estado de carregamento antes de a action resolver', async () => {
    let resolver: (value: unknown) => void = () => {}
    mocks.listarFatosCliente.mockImplementation(() => new Promise((r) => { resolver = r }))

    render(painel())

    expect(screen.getByTestId('fatos-carregando')).toHaveTextContent('Carregando fatos do cliente')
    expect(mocks.listarFatosCliente).toHaveBeenCalledWith(CLIENTE.id)
    expect(lista()).not.toBeInTheDocument()

    resolver({ success: true, data: [FATO_PENDENTE_IA] })

    await waitFor(() => expect(screen.queryByTestId('fatos-carregando')).not.toBeInTheDocument())
    expect(linha('id-pendente')).toBeInTheDocument()
  })

  it('renderiza o estado vazio quando o cliente não tem fatos', async () => {
    mocks.listarFatosCliente.mockResolvedValue({ success: true, data: [] })

    render(painel())

    expect(await screen.findByTestId('fatos-vazio')).toHaveTextContent('Nenhum fato registrado para este cliente')
    expect(lista()).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('não renderiza dados quando a action recusa o acesso, mesmo se vierem no payload', async () => {
    // Recusa real da action: sem `data`. O painel precisa mostrar a recusa, nunca linhas.
    mocks.listarFatosCliente.mockResolvedValue({ success: false, error: 'ACESSO_NEGADO_PERMISSAO_INSUFICIENTE' })

    render(painel())

    expect(await screen.findByTestId('fatos-erro')).toHaveTextContent('Não foi possível carregar os fatos deste cliente')
    expect(lista()).not.toBeInTheDocument()
    expect(screen.queryByTestId('fato-id-pendente')).not.toBeInTheDocument()
  })

  it('não renderiza linhas de um resultado falho que ainda carrega data', async () => {
    // Defesa em profundidade: um resultado `success: false` com `data` populada não pode virar linhas.
    mocks.listarFatosCliente.mockResolvedValue({ success: false, error: 'SOFIA_FATOS_CLIENTE_42501', data: FATOS })

    render(painel())

    const alerta = await screen.findByTestId('fatos-erro')
    expect(alerta).toBeInTheDocument()
    expect(lista()).not.toBeInTheDocument()
    expect(screen.queryByTestId('fato-id-pendente')).not.toBeInTheDocument()
    // O token interno da action/RPC nunca chega ao documento.
    expect(document.body.textContent).not.toContain('SOFIA_FATOS_CLIENTE_42501')
    expect(document.body.textContent).not.toContain('42501')
  })

  it('distingue visualmente `observacao` dos fatos do cliente', async () => {
    mocks.listarFatosCliente.mockResolvedValue({ success: true, data: FATOS })

    render(painel())
    await waitFor(() => expect(linha('id-pendente')).toBeInTheDocument())

    const observacao = linha('id-observacao')
    const fatoCliente = linha('id-aprovado')

    expect(observacao).toHaveAttribute('data-variante', 'observacao')
    expect(fatoCliente).toHaveAttribute('data-variante', 'cliente')
    expect(campo('id-observacao', 'fato-variante')).toHaveTextContent('Observação')
    expect(campo('id-observacao', 'fato-variante')).toHaveTextContent('não é um fato do cliente')
    expect(campo('id-aprovado', 'fato-variante')).toHaveTextContent('Fato do cliente')
    // A marca visual: borda tracejada exclusiva da observação.
    expect(observacao.className).toContain('border-dashed')
    expect(fatoCliente.className).not.toContain('border-dashed')
  })
})

describe('OperatorClientFactsPanel: revisão', () => {
  it('chama a action de revisão com os argumentos exatos em aprovar, rejeitar e corrigir', async () => {
    mocks.listarFatosCliente.mockResolvedValue({ success: true, data: [FATO_PENDENTE_IA] })
    mocks.revisarFatoCliente.mockResolvedValue({ success: true, data: [{ fato_id: 'id-pendente', estado: 'aprovado', valor: 'Coca-Cola sem gelo', origem: 'ia' }] })

    render(painel())
    await waitFor(() => expect(linha('id-pendente')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: 'Aprovar fato bebida_preferida' }))
    await waitFor(() => expect(mocks.revisarFatoCliente).toHaveBeenCalledWith('id-pendente', 'aprovar', null))
    expect(await screen.findByTestId('fatos-sucesso')).toHaveTextContent('Fato aprovado.')

    fireEvent.click(screen.getByRole('button', { name: 'Rejeitar fato bebida_preferida' }))
    await waitFor(() => expect(mocks.revisarFatoCliente).toHaveBeenCalledWith('id-pendente', 'rejeitar', null))

    fireEvent.click(screen.getByRole('button', { name: 'Corrigir fato bebida_preferida' }))
    const campoCorrecao = screen.getByLabelText('Novo valor para bebida_preferida')
    expect(campoCorrecao).toHaveValue('Coca-Cola sem gelo')
    fireEvent.change(campoCorrecao, { target: { value: 'Coca-Cola com gelo' } })
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar correção de bebida_preferida' }))

    await waitFor(() => expect(mocks.revisarFatoCliente).toHaveBeenCalledWith('id-pendente', 'corrigir', 'Coca-Cola com gelo'))
    expect(mocks.revisarFatoCliente).toHaveBeenCalledTimes(3)

    // Cada revisão recarrega a lista pela action (a tela não inventa o novo estado).
    await waitFor(() => expect(mocks.listarFatosCliente).toHaveBeenCalledTimes(4))
    expect(mocks.listarFatosCliente).toHaveBeenCalledWith(CLIENTE.id)
  })

  it('envia o valor corrigido sem os espaços das bordas', async () => {
    mocks.listarFatosCliente.mockResolvedValue({ success: true, data: [FATO_PENDENTE_IA] })
    mocks.revisarFatoCliente.mockResolvedValue({ success: true, data: [] })

    render(painel())
    await waitFor(() => expect(linha('id-pendente')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: 'Corrigir fato bebida_preferida' }))
    fireEvent.change(screen.getByLabelText('Novo valor para bebida_preferida'), {
      target: { value: '   Coca-Cola com gelo   ' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar correção de bebida_preferida' }))

    // O valor chega normalizado; sem o `.trim()` do caminho de correção esta asserção falha.
    await waitFor(() => expect(mocks.revisarFatoCliente).toHaveBeenCalledWith('id-pendente', 'corrigir', 'Coca-Cola com gelo'))
    expect(mocks.revisarFatoCliente).not.toHaveBeenCalledWith('id-pendente', 'corrigir', '   Coca-Cola com gelo   ')
  })

  it('bloqueia o envio da correção quando o campo só tem espaços', async () => {
    mocks.listarFatosCliente.mockResolvedValue({ success: true, data: [FATO_PENDENTE_IA] })

    render(painel())
    await waitFor(() => expect(linha('id-pendente')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: 'Corrigir fato bebida_preferida' }))
    const confirmar = screen.getByRole('button', { name: 'Confirmar correção de bebida_preferida' })
    // Com o valor atual preenchido o controle está habilitado: a asserção de bloqueio não é vácua.
    expect(confirmar).toBeEnabled()

    fireEvent.change(screen.getByLabelText('Novo valor para bebida_preferida'), { target: { value: '   ' } })
    expect(confirmar).toBeDisabled()

    fireEvent.click(confirmar)
    expect(mocks.revisarFatoCliente).not.toHaveBeenCalled()
  })

  it('não oferece ações de revisão para fatos já revisados', async () => {
    mocks.listarFatosCliente.mockResolvedValue({ success: true, data: FATOS })

    render(painel())
    await waitFor(() => expect(linha('id-pendente')).toBeInTheDocument())

    expect(screen.getByRole('button', { name: 'Aprovar fato bebida_preferida' })).toBeInTheDocument()
    for (const fatoId of ['id-aprovado', 'id-rejeitado', 'id-substituido']) {
      expect(within(linha(fatoId)).queryByRole('button')).not.toBeInTheDocument()
    }
  })

  it('mantém a lista e sinaliza o erro quando a action de revisão falha', async () => {
    mocks.listarFatosCliente.mockResolvedValue({ success: true, data: [FATO_PENDENTE_IA] })
    mocks.revisarFatoCliente.mockResolvedValue({ success: false, error: 'SOFIA_REVISAO_42501' })

    render(painel())
    await waitFor(() => expect(linha('id-pendente')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: 'Aprovar fato bebida_preferida' }))

    expect(await screen.findByTestId('fatos-erro-acao')).toHaveTextContent('Não foi possível revisar este fato')
    expect(linha('id-pendente')).toBeInTheDocument()
    // Sem recarga após falha: a lista exibida continua sendo a última leitura confirmada.
    expect(mocks.listarFatosCliente).toHaveBeenCalledTimes(1)
    expect(document.body.textContent).not.toContain('SOFIA_REVISAO_42501')
  })
})

describe('ClientCrmPanel: quarta aba `fatos`', () => {
  it('abre a aba `fatos` e mantém carrinho, pedidos e crm intactos', async () => {
    mocks.listarFatosCliente.mockResolvedValue({ success: true, data: FATOS })
    mocks.atualizarClienteCrm.mockResolvedValue({ success: true })

    render(<ClientCrmPanel cliente={CLIENTE} />)

    expect(screen.getByRole('tab', { name: /Carrinho/i })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByTestId('cart-panel')).toBeInTheDocument()
    // A aba `fatos` só monta quando aberta: nenhuma leitura de fatos nas abas existentes.
    expect(mocks.listarFatosCliente).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('tab', { name: /Pedidos/i }))
    expect(screen.getByTestId('orders-panel')).toBeInTheDocument()
    expect(mocks.listarFatosCliente).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('tab', { name: 'Dados do cliente (CRM)' }))
    expect(screen.getByText('Dados Gerais')).toBeInTheDocument()
    fireEvent.change(screen.getByPlaceholderText('Nenhum endereço cadastrado'), { target: { value: 'Rua Nova, 45' } })
    fireEvent.change(screen.getByPlaceholderText(/Observações importantes/), { target: { value: 'Sem cebola na pizza' } })
    fireEvent.change(screen.getByPlaceholderText('Nova tag...'), { target: { value: 'vip' } })
    fireEvent.submit(screen.getByPlaceholderText('Nova tag...').closest('form')!)
    fireEvent.click(screen.getByRole('button', { name: /Salvar Alterações/ }))

    await waitFor(() => expect(mocks.atualizarClienteCrm).toHaveBeenCalledWith(CLIENTE.id, {
      endereco: 'Rua Nova, 45',
      notas: 'Sem cebola na pizza',
      score: 0,
      tags: ['vip'],
    }))
    expect(mocks.listarFatosCliente).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('tab', { name: 'Fatos do cliente (memória)' }))

    await waitFor(() => expect(mocks.listarFatosCliente).toHaveBeenCalledWith(CLIENTE.id))
    expect(await screen.findByTestId('fato-id-pendente')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: /Carrinho/i }))
    expect(screen.getByTestId('cart-panel')).toBeInTheDocument()
  })

  it('navega com setas, Home e End pelas quatro abas', async () => {
    mocks.listarFatosCliente.mockResolvedValue({ success: true, data: [] })

    render(<ClientCrmPanel cliente={CLIENTE} />)

    const carrinho = screen.getByRole('tab', { name: /Carrinho/i })
    const pedidos = screen.getByRole('tab', { name: /Pedidos/i })
    const crm = screen.getByRole('tab', { name: 'Dados do cliente (CRM)' })
    const fatos = screen.getByRole('tab', { name: 'Fatos do cliente (memória)' })

    carrinho.focus()
    fireEvent.keyDown(carrinho, { key: 'ArrowRight' })
    expect(pedidos).toHaveFocus()
    fireEvent.keyDown(pedidos, { key: 'ArrowRight' })
    expect(crm).toHaveFocus()
    fireEvent.keyDown(crm, { key: 'ArrowRight' })
    expect(fatos).toHaveFocus()
    expect(fatos).toHaveAttribute('aria-selected', 'true')

    fireEvent.keyDown(fatos, { key: 'ArrowLeft' })
    expect(crm).toHaveFocus()
    fireEvent.keyDown(crm, { key: 'ArrowLeft' })
    expect(pedidos).toHaveFocus()

    fireEvent.keyDown(pedidos, { key: 'End' })
    expect(fatos).toHaveFocus()
    expect(fatos).toHaveAttribute('aria-selected', 'true')
    // A aba `fatos` foi realmente montada pelo teclado: a action é chamada com o cliente.
    await waitFor(() => expect(mocks.listarFatosCliente).toHaveBeenCalledWith(CLIENTE.id))

    fireEvent.keyDown(fatos, { key: 'Home' })
    expect(carrinho).toHaveFocus()
    expect(carrinho).toHaveAttribute('aria-selected', 'true')
    expect(carrinho).toHaveAttribute('tabindex', '0')
    expect(pedidos).toHaveAttribute('aria-selected', 'false')
    expect(crm).toHaveAttribute('aria-selected', 'false')
    expect(fatos).toHaveAttribute('aria-selected', 'false')
    expect(fatos).toHaveAttribute('tabindex', '-1')

    // Wrap para trás a partir da primeira aba: a última aba do tablist é `fatos`, não `crm`.
    // Esta asserção é incompatível, por construção, com `tests/components/operator/ClientCrmPanel.test.tsx:70`,
    // que espera `crm` no wrap de ArrowLeft a partir de `carrinho` — impossível num tablist de 4 abas.
    fireEvent.keyDown(carrinho, { key: 'ArrowLeft' })
    expect(fatos).toHaveFocus()
    expect(fatos).toHaveAttribute('aria-selected', 'true')
  })

  it('lê os fatos apenas pelas actions e não acessa a tabela direto', () => {
    const fonte = (caminho: string) => readFileSync(resolve(process.cwd(), caminho), 'utf8')
    const componente = fonte('apps/web/src/components/operator/OperatorClientFactsPanel.tsx')
    const painelCrm = fonte('apps/web/src/components/operator/ClientCrmPanel.tsx')

    expect(componente).toMatch(/from '@\/app\/actions\/fatos-cliente'/)
    expect(componente).not.toMatch(/@\/lib\/supabase/)
    expect(componente).not.toMatch(/createClient/)
    expect(componente).not.toMatch(/fatos_cliente/)
    expect(painelCrm).toMatch(/from '\.\/OperatorClientFactsPanel'/)
    expect(painelCrm).not.toMatch(/fatos_cliente/)
    // Guarda endurecida: nenhum dos dois componentes pode mencionar `supabase`, nem por caminho
    // relativo, nem por barrel, nem com outra capitalização.
    expect(componente).not.toMatch(/supabase/i)
    expect(painelCrm).not.toMatch(/supabase/i)
  })
})
