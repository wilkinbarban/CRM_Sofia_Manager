import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import OperatorInboxContainer from '@/components/operator/OperatorInboxContainer'

vi.mock('@/app/actions/atendimento', () => ({
  alternarSofiaGlobal: vi.fn(),
  alternarSofiaWhatsApp: vi.fn(),
  obterStatusSofiaAtendimento: vi.fn().mockResolvedValue({ success: false, error: 'unavailable' }),
}))

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    channel: () => ({ on() { return this }, subscribe: () => ({}) }),
    removeChannel: vi.fn(),
  }),
}))

vi.mock('@/components/operator/ConversationsQueue', () => ({
  default: () => <div data-testid="queue" />,
}))

vi.mock('@/components/operator/OperatorChatConsole', () => ({
  default: () => <div data-testid="chat" />,
}))

vi.mock('@/components/operator/ClientCrmPanel', () => ({
  default: () => <div data-testid="commercial-panel" />,
}))

vi.mock('@/components/operator/SofiaGlobalStatusBar', () => ({
  default: () => null,
}))

describe('OperatorInboxContainer responsive workspace', () => {
  afterEach(cleanup)

  it('uses a stacked mobile workspace and restores three columns on wide screens', () => {
    render(<OperatorInboxContainer conversasIniciais={[]} initialSofiaStatus={null} />)

    expect(screen.getByTestId('operator-workspace')).toHaveClass('flex-col', 'xl:flex-row')
    expect(screen.getByTestId('queue-region')).toHaveClass('h-[42vh]', 'min-h-56', 'xl:h-full')
    expect(screen.getByTestId('chat-region')).toHaveClass('min-h-[60vh]', 'xl:min-h-0')
    expect(screen.getByTestId('commercial-region')).toHaveClass('h-[60vh]', 'xl:h-full', 'xl:w-[28rem]', '2xl:w-[32rem]')
  })

  it('keeps every stacked mobile pane usable inside the viewport', () => {
    render(<OperatorInboxContainer conversasIniciais={[]} initialSofiaStatus={null} />)

    const queue = screen.getByTestId('queue-region')
    const chat = screen.getByTestId('chat-region')
    const commercial = screen.getByTestId('commercial-region')

    // Mobile panes rely on viewport-relative heights instead of fixed pixels so a
    // phone shows a real slice of each region without a thousand-pixel scroll.
    const tokens = (element: HTMLElement) => element.className.split(/\s+/)
    expect(tokens(queue)).not.toContain('h-64')
    expect(tokens(queue)).toContain('h-[42vh]')
    expect(tokens(chat)).not.toContain('min-h-[24rem]')
    expect(tokens(chat)).toContain('min-h-[60vh]')
    expect(tokens(commercial)).not.toContain('h-[36rem]')
    expect(tokens(commercial)).toContain('h-[60vh]')
    expect(commercial).toHaveClass('max-h-[36rem]')
  })
})
