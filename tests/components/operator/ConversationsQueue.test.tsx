import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ConversationsQueue, { type Conversa } from '@/components/operator/ConversationsQueue'

describe('ConversationsQueue polish contract', () => {
  afterEach(cleanup)

  it('labels the queue with a level-two heading and keeps touch-sized filter controls', () => {
    render(
      <ConversationsQueue
        conversas={[baseConversation]}
        selectedConversaId={null}
        onSelectConversa={vi.fn()}
        onToggleSofiaSleep={vi.fn()}
      />
    )

    expect(screen.getByRole('heading', { level: 2, name: /Fila de Atendimento/i })).toBeInTheDocument()

    for (const name of [/Fila IA/i, /Humana/i, /Fechada/i]) {
      expect(screen.getByRole('button', { name }).className).toContain('min-h-11')
    }
  })
})

const baseConversation: Conversa = {
  id: 'conversation-1',
  cliente_id: 'customer-1',
  status: 'ia_atendendo',
  ia_ativa: true,
  data_criacao: '2026-07-09T12:00:00.000Z',
  data_atualizacao: '2026-07-09T12:05:00.000Z',
  clientes: {
    id: 'customer-1',
    nome: 'Ana Cliente',
    telefone: '5541999999999',
  },
  mensagens: [
    {
      id: 'message-1',
      conversa_id: 'conversation-1',
      remetente: 'cliente',
      conteudo: 'Olá',
      url_anexo: null,
      data_criacao: '2026-07-09T12:04:00.000Z',
    },
  ],
  whatsapp_sofia_state: {
    id: 'state-1',
    cliente_id: 'customer-1',
    canal: 'whatsapp',
    sofia_dormindo: false,
    motivo: 'manual',
    origem: 'operator',
    alterado_por: 'operator-1',
    data_criacao: '2026-07-09T12:00:00.000Z',
    data_atualizacao: '2026-07-09T12:05:00.000Z',
  },
}

describe('ConversationsQueue', () => {
  it('shows Sofia awake state and invokes sleep callback', () => {
    const onToggleSofiaSleep = vi.fn().mockResolvedValue(undefined)

    render(
      <ConversationsQueue
        conversas={[baseConversation]}
        selectedConversaId={null}
        onSelectConversa={vi.fn()}
        onToggleSofiaSleep={onToggleSofiaSleep}
      />
    )

    expect(screen.getByText('Sofía awake')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Sleep' }))

    expect(onToggleSofiaSleep).toHaveBeenCalledWith(baseConversation, true)
  })

  it('shows human handling state and invokes wake callback', () => {
    const onToggleSofiaSleep = vi.fn().mockResolvedValue(undefined)
    const sleepingConversation: Conversa = {
      ...baseConversation,
      whatsapp_sofia_state: {
        ...baseConversation.whatsapp_sofia_state!,
        sofia_dormindo: true,
      },
    }

    render(
      <ConversationsQueue
        conversas={[sleepingConversation]}
        selectedConversaId={null}
        onSelectConversa={vi.fn()}
        onToggleSofiaSleep={onToggleSofiaSleep}
      />
    )

    expect(screen.getByText('Human handling')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Wake' }))

    expect(onToggleSofiaSleep).toHaveBeenCalledWith(sleepingConversation, false)
  })
})
