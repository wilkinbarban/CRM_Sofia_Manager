import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ConversationsQueue, { Conversa } from '@/components/operator/ConversationsQueue'
import { notificationSound } from '@/lib/audio/notification-sound'

describe('Atendimento Notifications & Queue Indicators', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    localStorage.clear()
  })

  const criarConversaMock = (
    id: string,
    nome: string,
    status: 'ia_atendendo' | 'aberta' | 'fechada',
    iaAtiva: boolean,
    mensagens: any[] = []
  ): Conversa => ({
    id,
    cliente_id: `cli-${id}`,
    status,
    ia_ativa: iaAtiva,
    data_criacao: new Date(Date.now() - 3600000).toISOString(),
    data_atualizacao: new Date(Date.now() - 60000).toISOString(),
    clientes: {
      id: `cli-${id}`,
      nome,
      telefone: '5541999998888',
      endereco: 'Rua Umbará, 123',
    },
    mensagens,
  })

  it('calcula e exibe os contadores numéricos nas abas Fila IA, Humana e Fechadas', () => {
    const conversas: Conversa[] = [
      criarConversaMock('c1', 'João Silva', 'ia_atendendo', true),
      criarConversaMock('c2', 'Maria Souza', 'ia_atendendo', true),
      criarConversaMock('c3', 'Carlos Pereira', 'aberta', false, [
        { id: 'm1', conversa_id: 'c3', remetente: 'cliente', conteudo: 'Olá, preciso de ajuda humana', data_criacao: new Date().toISOString(), url_anexo: null },
      ]),
      criarConversaMock('c4', 'Ana Lima', 'fechada', false),
    ]

    render(
      <ConversationsQueue
        conversas={conversas}
        selectedConversaId={null}
        onSelectConversa={vi.fn()}
      />
    )

    // Contadores das abas
    expect(screen.getByText('Fila IA')).toBeDefined()
    expect(screen.getByText('Humana')).toBeDefined()
    expect(screen.getByText('Fechadas')).toBeDefined()

    // Valida que o total da IA é 2, Humana é 1 e Fechadas é 1
    expect(screen.getByText('2')).toBeDefined()
    expect(screen.getAllByText('1').length).toBe(2)
  })

  it('exibe o badge de "Em espera há X min" para clientes na fila humana aguardando há mais de 5 minutos', () => {
    const oitoMinutosAtras = new Date(Date.now() - 8 * 60 * 1000).toISOString()
    const conversas: Conversa[] = [
      criarConversaMock('c1', 'Rodrigo Santos', 'aberta', false, [
        { id: 'm1', conversa_id: 'c1', remetente: 'operador', conteudo: 'Olá!', data_criacao: new Date(Date.now() - 10 * 60 * 1000).toISOString(), url_anexo: null },
        { id: 'm2', conversa_id: 'c1', remetente: 'cliente', conteudo: 'Vocês ainda têm costela?', data_criacao: oitoMinutosAtras, url_anexo: null },
      ]),
    ]

    render(
      <ConversationsQueue
        conversas={conversas}
        selectedConversaId={null}
        onSelectConversa={vi.fn()}
      />
    )

    // Clica na aba Humana
    fireEvent.click(screen.getByText('Humana'))

    expect(screen.getByText(/Em espera há \d+ min/i)).toBeDefined()
  })

  it('alterna o estado do alerta sonoro ao clicar no botão de som', () => {
    const playSpy = vi.spyOn(notificationSound, 'playChime').mockImplementation(() => {})

    render(
      <ConversationsQueue
        conversas={[]}
        selectedConversaId={null}
        onSelectConversa={vi.fn()}
      />
    )

    const somBtn = screen.getByTitle(/Notificações sonoras/i)
    expect(screen.getByText('Som ativo')).toBeDefined()

    // Clica para silenciar
    fireEvent.click(somBtn)
    expect(screen.getByText('Mudo')).toBeDefined()
    expect(localStorage.getItem('crm_notificacoes_som')).toBe('false')

    // Clica para reativar e emite som de teste
    fireEvent.click(somBtn)
    expect(screen.getByText('Som ativo')).toBeDefined()
    expect(localStorage.getItem('crm_notificacoes_som')).toBe('true')
    expect(playSpy).toHaveBeenCalled()
  })
})
