import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import BusinessHoursManager from '@/components/operator/BusinessHoursManager'
import {
  listarHorarios,
  salvarHorarioDia,
  salvarMensagemForaHorario,
  obterMensagemForaHorario,
} from '@/app/actions/horarios'

vi.mock('@/app/actions/horarios', () => ({
  listarHorarios: vi.fn(),
  salvarHorarioDia: vi.fn(),
  salvarMensagemForaHorario: vi.fn(),
  obterMensagemForaHorario: vi.fn(),
}))

const DAY = {
  dia_semana: 1,
  dia_nome: 'Segunda',
  hora_abertura: '08:00',
  hora_fechamento: '18:00',
  ativo: true,
}

describe('BusinessHoursManager — edição fluida de horários', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(listarHorarios).mockResolvedValue({ success: true, data: [DAY] } as never)
    vi.mocked(obterMensagemForaHorario).mockResolvedValue({ success: true, data: 'Olá!' } as never)
    vi.mocked(salvarHorarioDia).mockResolvedValue({ success: true } as never)
    vi.mocked(salvarMensagemForaHorario).mockResolvedValue({ success: true } as never)
  })

  afterEach(() => cleanup())

  const renderManager = async () => {
    render(<BusinessHoursManager />)
    return {
      abertura: (await screen.findByLabelText('Abertura')) as HTMLInputElement,
      fechamento: (await screen.findByLabelText('Fechamento')) as HTMLInputElement,
    }
  }

  it('keeps both time inputs editable and never saves while a value is only being typed', async () => {
    const { abertura, fechamento } = await renderManager()

    fireEvent.change(abertura, { target: { value: '09:30' } })

    expect(salvarHorarioDia).not.toHaveBeenCalled()
    expect(abertura).toBeEnabled()
    expect(fechamento).toBeEnabled()
    expect(abertura.value).toBe('09:30')
  })

  it('saves the day once when the edited time is committed on blur', async () => {
    const { abertura } = await renderManager()

    fireEvent.change(abertura, { target: { value: '09:30' } })
    fireEvent.blur(abertura)

    await waitFor(() => expect(salvarHorarioDia).toHaveBeenCalledTimes(1))
    expect(vi.mocked(salvarHorarioDia).mock.calls[0]).toEqual([1, '09:30', '18:00', true])
    expect(abertura).toBeEnabled()
  })

  it('also commits the edited time with Enter', async () => {
    const { fechamento } = await renderManager()

    fireEvent.change(fechamento, { target: { value: '19:45' } })
    fireEvent.keyDown(fechamento, { key: 'Enter' })

    await waitFor(() => expect(salvarHorarioDia).toHaveBeenCalledTimes(1))
    expect(vi.mocked(salvarHorarioDia).mock.calls[0]).toEqual([1, '08:00', '19:45', true])
  })

  it('never persists an incomplete value and restores the stored time on blur', async () => {
    const { abertura } = await renderManager()

    fireEvent.change(abertura, { target: { value: '09:' } })
    fireEvent.blur(abertura)

    expect(salvarHorarioDia).not.toHaveBeenCalled()
    expect(abertura.value).toBe('08:00')
  })

  it('never resends the same draft while the save is still unconfirmed', async () => {
    vi.mocked(salvarHorarioDia).mockResolvedValue({ success: false, error: 'indisponível' } as never)
    const { abertura } = await renderManager()

    fireEvent.change(abertura, { target: { value: '10:00' } })
    fireEvent.blur(abertura)
    await waitFor(() => expect(salvarHorarioDia).toHaveBeenCalledTimes(1))

    fireEvent.blur(abertura)
    fireEvent.blur(abertura)

    expect(salvarHorarioDia).toHaveBeenCalledTimes(1)
    expect(abertura.value).toBe('10:00')
  })

  it('still commits a further correction after an unconfirmed value', async () => {
    vi.mocked(salvarHorarioDia).mockResolvedValue({ success: false, error: 'indisponível' } as never)
    const { abertura } = await renderManager()

    fireEvent.change(abertura, { target: { value: '10:00' } })
    fireEvent.blur(abertura)
    await waitFor(() => expect(salvarHorarioDia).toHaveBeenCalledTimes(1))

    fireEvent.change(abertura, { target: { value: '11:30' } })
    fireEvent.blur(abertura)

    await waitFor(() => expect(salvarHorarioDia).toHaveBeenCalledTimes(2))
    expect(vi.mocked(salvarHorarioDia).mock.calls[1]).toEqual([1, '11:30', '18:00', true])
  })

  it('does not disable the inputs while a committed save is still pending', async () => {
    let release: (value: { success: boolean }) => void = () => {}
    vi.mocked(salvarHorarioDia).mockImplementation(
      () => new Promise((resolve) => { release = resolve }) as never
    )

    const { abertura, fechamento } = await renderManager()

    fireEvent.change(abertura, { target: { value: '10:15' } })
    fireEvent.blur(abertura)

    await waitFor(() => expect(salvarHorarioDia).toHaveBeenCalledTimes(1))
    expect(abertura).toBeEnabled()
    expect(fechamento).toBeEnabled()

    release({ success: true })
    await waitFor(() => expect(abertura.value).toBe('10:15'))
  })
})
