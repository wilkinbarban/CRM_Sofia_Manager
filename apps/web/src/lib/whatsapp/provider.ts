import { createAdminClient } from '@/lib/supabase/admin'
import type { EvolutionPresenceEvent } from './evolution-presence'
import { cache } from 'react'

export type TipoCategoriaMensagem = 'REACTIVE' | 'ORDER' | 'SERVICE' | 'MARKETING' | 'CARDAPIO'

export interface EnviarMensagemPayload {
  texto?: string;
  anexoPath?: string;
  templateName?: string;
  templateParams?: any[];
  remetente?: 'operador' | 'ia';
  categoria?: TipoCategoriaMensagem;
  /** Overrides Evolution's provider-side composing delay when a durable worker already paced delivery. */
  typingDelayMs?: number;
  /** Defaults true; durable outbox callers disable duplicate message persistence. */
  salvarNoBanco?: boolean;
}

export function shouldPersistOutbound(payload: EnviarMensagemPayload): boolean {
  return payload.salvarNoBanco !== false
}

export interface ResultadoEnvio {
  sucesso: boolean;
  whatsappMensagemId: string | null;
  mensagem?: any;
  error?: string;
  safetyBlocked?: boolean;
  motivo?: string;
}

export interface ProvedorWhatsApp {
  enviarMensagem(conversaId: string, payload: EnviarMensagemPayload): Promise<ResultadoEnvio>;
  /** Capability-based presence avoids class-name checks, which production minification renames. */
  iniciarPresenca?(conversaId: string, observe?: (event: EvolutionPresenceEvent) => void | Promise<void>): Promise<{ stop: () => void }>;
}

/**
 * Capability detector that avoids class-name or instanceof checks, which production
 * minification renames (e.g. `EvolutionProvider` minifies to `q`).
 */
export function supportsPresence(
  provider: unknown
): provider is { iniciarPresenca: NonNullable<ProvedorWhatsApp['iniciarPresenca']> } {
  return (
    !!provider &&
    typeof provider === 'object' &&
    typeof (provider as ProvedorWhatsApp).iniciarPresenca === 'function'
  )
}

export class WhatsAppWindowClosedError extends Error {
  constructor() {
    super('Janela de 24 horas excedida. É obrigatório o envio de um template homologado.')
    this.name = 'WhatsAppWindowClosedError'
  }
}

/**
 * Infere o tipo de mídia a partir da extensão do arquivo
 */
export function inferirTipoMidia(caminho: string): 'image' | 'audio' | 'document' {
  const ext = caminho.split('.').pop()?.toLowerCase() || ''
  if (['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(ext)) {
    return 'image'
  }
  if (['mp3', 'ogg', 'wav', 'aac', 'm4a'].includes(ext)) {
    return 'audio'
  }
  return 'document'
}

/**
 * Valida a janela de 24 horas e retorna o telefone do cliente e cliente Supabase Admin
 */
export async function validarJanelaEnvio(conversaId: string, payload: EnviarMensagemPayload) {
  const supabase = createAdminClient()

  // 1. Obter a conversa e o telefone do cliente
  const { data: conversa, error: conversaError } = await supabase
    .from('conversas')
    .select('id, cliente_id, clientes (telefone, ultima_interacao_recebida_em)')
    .eq('id', conversaId)
    .single()

  if (conversaError || !conversa) {
    throw new Error(`Conversa não encontrada: ${conversaError?.message || 'Sem dados'}`)
  }

  const telefone = (conversa as any).clientes?.telefone
  if (!telefone) {
    throw new Error('Telefone do cliente não encontrado para esta conversa.')
  }

  // 2. Obter a última mensagem enviada pelo cliente nesta conversa
  const { data: ultimaMensagemCliente, error: msgError } = await supabase
    .from('mensagens')
    .select('data_criacao')
    .eq('conversa_id', conversaId)
    .eq('remetente', 'cliente')
    .order('data_criacao', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (msgError) {
    throw new Error(`Erro ao buscar última mensagem do cliente: ${msgError.message}`)
  }

  // 3. Verificar a janela de 24 horas usando a evidência autoritativa do
  // cliente e a projeção legada desta conversa, sem inferir outro vínculo.
  const agora = new Date()
  const timestamps = [
    (conversa as any).clientes?.ultima_interacao_recebida_em,
    ultimaMensagemCliente?.data_criacao,
  ]
    .map((timestamp) => new Date(timestamp))
    .filter((timestamp) => !Number.isNaN(timestamp.getTime()) && timestamp <= agora)

  const dataUltima = timestamps.reduce<Date | null>(
    (latest, timestamp) => !latest || timestamp > latest ? timestamp : latest,
    null,
  )
  const janelaExcedida = !dataUltima || agora.getTime() - dataUltima.getTime() > 24 * 60 * 60 * 1000

  // 4. Aplicar restrição da janela de 24 horas
  if (janelaExcedida && !payload.templateName) {
    throw new WhatsAppWindowClosedError()
  }

  return { telefone, supabase }
}

export const obterProvedorAtivo = cache(async (): Promise<ProvedorWhatsApp> => {
  // The CRM runs on Evolution API only: the retired Meta Cloud API provider is
  // never selected, no matter what a legacy configuration key still contains.
  const { EvolutionProvider } = await import('./evolution')
  return new EvolutionProvider()
})
