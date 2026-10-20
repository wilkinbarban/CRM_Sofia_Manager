'use server'

import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { processarRagPipeline } from '@/lib/ai/openrouter'
import { verificarHorarioAtendimento } from '@/lib/horarios/verificar'
import { webInboundBatchEnqueueEnabled } from '@/lib/sofia/inbound-batch-gates'
import {
  admitSofiaWebInboundMessage,
  attachPersistedSofiaInboundMessage,
} from '@/lib/sofia/inbound-batch-producer'

/**
 * Server Action para acionar o pipeline de IA (RAG) de forma assíncrona.
 * Verifica se o chamador está autenticado e se a conversa pertence ao cliente ativo
 * antes de processar a resposta da IA.
 * 
 * @param conversaId ID da conversa ativa
 * @param conteudo Conteúdo da mensagem enviada pelo cliente
 */
type SofiaPresence = {
  status: 'composing'
  expiresAt: string
}

type AuthClient = Awaited<ReturnType<typeof createClient>>
type AdminClient = ReturnType<typeof createAdminClient>

type ConversaAutorizada = {
  ia_ativa: boolean
  cliente_id: string
}

/**
 * Mensagem canônica devolvida pela admissão atômica Web, para o navegador anexar à
 * conversa sem precisar gravar `mensagens` por conta própria quando o gate está ativo.
 */
type MensagemWebAdmitida = {
  id: string
  conversa_id: string
  remetente: string
  conteudo: string | null
  url_anexo: string | null
  data_criacao: string
}

/**
 * Carrega a conversa e confirma que o usuário autenticado pode agir sobre ela: operador
 * ativo do CRM, ou o cliente dono da conversa. Reutilizado pelo caminho direto e pela
 * admissão atômica Web para manter uma única regra de autorização.
 */
async function carregarConversaAutorizada(input: {
  conversaId: string
  userId: string
  supabase: AuthClient
  supabaseAdmin: AdminClient
}): Promise<{ ok: true; conversa: ConversaAutorizada } | { ok: false; error: string }> {
  const { data: conversa, error: conversaError } = await input.supabaseAdmin
    .from('conversas')
    .select('ia_ativa, cliente_id')
    .eq('id', input.conversaId)
    .single()

  if (conversaError || !conversa) {
    console.error(`[Server Action] Conversa ${input.conversaId} não encontrada ou erro ao buscar:`, conversaError)
    return { ok: false, error: 'CONVERSA_NAO_ENCONTRADA' }
  }

  const { data: perfil } = await input.supabase
    .from('perfis')
    .select('funcao, ativo')
    .eq('id', input.userId)
    .single()

  const ehOperador = perfil && perfil.ativo === true && ['admin', 'supervisor', 'vendedor'].includes(perfil.funcao)

  if (!ehOperador) {
    // Se não for operador, verificar se o cliente associado ao usuario_id é o dono da conversa
    const { data: cliente, error: clienteError } = await input.supabase
      .from('clientes')
      .select('id')
      .eq('usuario_id', input.userId)
      .single()

    if (clienteError || !cliente || conversa.cliente_id !== cliente.id) {
      return { ok: false, error: 'ACESSO_NEGADO_PERMISSAO_INSUFICIENTE' }
    }
  }

  return { ok: true, conversa: conversa as ConversaAutorizada }
}

/**
 * Admissão atômica Web: quando o gate Web está ativo, a mensagem e o vínculo com o lote
 * `web` são gravados em uma única transação pelo RPC canônico. O navegador não grava em
 * `mensagens` nesse caminho, e a chave de idempotência gerada pelo cliente faz uma nova
 * tentativa devolver a mensagem/lote originais sem alterar o prazo.
 *
 * Enquanto o gate está fechado — ou quando a conversa não é elegível — devolve
 * `mensagem: null` para o cliente preservar o caminho direto atual sem alterações.
 */
export async function admitirMensagemSofiaWeb(
  conversaId: string,
  conteudo: string,
  idempotencyKey: string,
): Promise<{ success: true; mensagem: MensagemWebAdmitida | null } | { success: false; error: string }> {
  try {
    if (!conversaId?.trim()) return { success: false, error: 'CONVERSA_NAO_ENCONTRADA' }
    if (!conteudo) return { success: true, mensagem: null }
    if (!webInboundBatchEnqueueEnabled()) return { success: true, mensagem: null }
    if (!idempotencyKey?.trim()) {
      return { success: false, error: 'SOFIA_BATCH_ADMISSION_KEY_INVALID' }
    }

    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) return { success: false, error: 'ACESSO_NEGADO_NAO_AUTENTICADO' }

    const horario = await verificarHorarioAtendimento()
    if (!horario.dentro) return { success: true, mensagem: null }

    const supabaseAdmin = createAdminClient()
    const autorizada = await carregarConversaAutorizada({
      conversaId,
      userId: user.id,
      supabase,
      supabaseAdmin,
    })
    if (!autorizada.ok) return { success: false, error: autorizada.error }
    if (!autorizada.conversa.ia_ativa) return { success: true, mensagem: null }

    const admissao = await admitSofiaWebInboundMessage({
      supabase: supabaseAdmin,
      conversationId: conversaId,
      customerId: autorizada.conversa.cliente_id,
      idempotencyKey: idempotencyKey.trim(),
      content: conteudo,
      attachmentUrl: null,
    })
    if (!admissao.admitted) return { success: false, error: 'SOFIA_BATCH_ADMISSION_FAILED' }

    const { data: mensagem, error: mensagemError } = await supabaseAdmin
      .from('mensagens')
      .select('*')
      .eq('id', admissao.messageId)
      .single()
    if (mensagemError || !mensagem) {
      return { success: false, error: 'SOFIA_BATCH_ADMISSION_MENSAGEM_INDISPONIVEL' }
    }

    return { success: true, mensagem: mensagem as MensagemWebAdmitida }
  } catch (error: any) {
    console.error('Erro na admissão atômica Web da Sofia:', error)
    return { success: false, error: 'SOFIA_BATCH_ADMISSION_FALHOU' }
  }
}

export async function obterSofiaPresence(conversaId: string): Promise<
  | { success: true; presence: SofiaPresence | null }
  | { success: false; error: string }
> {
  try {
    if (!conversaId?.trim()) {
      return { success: false, error: 'SOFIA_PRESENCE_CONVERSA_INVALIDA' }
    }

    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) return { success: false, error: 'ACESSO_NEGADO_NAO_AUTENTICADO' }

    const { data, error } = await supabase
      .rpc('get_sofia_conversation_presence', { p_conversa_id: conversaId })
      .maybeSingle()
    if (error) return { success: false, error: 'SOFIA_PRESENCE_INDISPONIVEL' }
    const presence = data as { status?: unknown; expires_at?: unknown } | null
    if (!presence || presence.status !== 'composing' || typeof presence.expires_at !== 'string') {
      return { success: true, presence: null }
    }

    return { success: true, presence: { status: 'composing', expiresAt: presence.expires_at } }
  } catch (error) {
    console.error('Erro ao consultar presença da Sofia:', error)
    return { success: false, error: 'SOFIA_PRESENCE_INDISPONIVEL' }
  }
}

export async function processarIaChat(conversaId: string, conteudo: string, messageId?: string) {
  try {
    if (!conteudo) {
      return { success: false, error: 'CONTEUDO_VAZIO' }
    }

    const supabase = await createClient()

    // 1. Validar autenticação do usuário
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return { success: false, error: 'ACESSO_NEGADO_NAO_AUTENTICADO' }
    }

    // 2. Verificar horário de atendimento
    const horario = await verificarHorarioAtendimento()
    if (!horario.dentro) {
      return { success: true, foraHorario: true, mensagem: horario.mensagem }
    }

    const supabaseAdmin = createAdminClient()

    // 3. Buscar a conversa ativa e validar a autorização do chamador
    const autorizada = await carregarConversaAutorizada({
      conversaId,
      userId: user.id,
      supabase,
      supabaseAdmin,
    })
    if (!autorizada.ok) return { success: false, error: autorizada.error }
    const conversa = autorizada.conversa

    // 4. Executar o pipeline RAG se a IA estiver ativa (com canal web explícito)
    if (conversa.ia_ativa) {
      if (webInboundBatchEnqueueEnabled()) {
        // Compatibilidade com chamadores que já persistiram a mensagem antes da action.
        // O caminho Web do navegador usa `admitirMensagemSofiaWeb`, que grava mensagem e
        // vínculo do lote `web` em uma única transação e nunca insere antes de anexar.
        if (!messageId) return { success: false, error: 'MENSAGEM_NAO_PERSISTIDA' }
        const attached = await attachPersistedSofiaInboundMessage({
          supabase: supabaseAdmin,
          messageId,
          conversationId: conversaId,
          customerId: conversa.cliente_id,
          channel: 'web',
        })
        if (!attached) return { success: false, error: 'SOFIA_BATCH_ATTACH_FAILED' }
        return { success: true }
      }
      console.log(`[Server Action] IA ativa para conversa ${conversaId}. Iniciando RAG para Web...`)
      await processarRagPipeline(conversaId, conteudo, 'web')
    }

    return { success: true }
  } catch (error: any) {
    console.error('Erro na server action processarIaChat:', error)
    return { success: false, error: error.message || 'ERRO_INTERNO' }
  }
}
