import { createAdminClient } from '@/lib/supabase/admin'
import { enviarMensagemWhatsapp } from '@/lib/whatsapp/send'
import { enviarMensagemTelegram } from '@/lib/telegram/send'
import { obterConfiguracaoSistema } from '@/lib/config/sistema'
import { allowsIntegrationMock } from '@/lib/runtime/environment'
import { isWhatsAppInboundEligibleForSofia } from '@/lib/whatsapp/sofia-control'
import { normalizeCuritibaPhone, isCuritibaPhone } from '@/lib/auth/phone'
import { formatarCardapioResumido } from '@/lib/cardapio/formatar'
import { gerarCatalogoCardsCompleto, obterCartaoCombo } from '@/lib/cardapio/cards'
import { classifySofiaRequestTier } from '@/lib/ai/router'
import { isLegacyFallbackEnabled } from '@/lib/ai/omniroute'
import {
  chamarDeepSeekChat,
  isUsableDeepSeekApiKey,
  resolverModeloDeepSeek,
} from '@/lib/ai/deepseek'
import { customerMemoryEnabled } from '@/lib/sofia/inbound-batch-gates'
import { agruparFatosParaPrompt } from '@/lib/sofia/customer-memory'

const LEGACY_LLM_TIMEOUT_MS = 15_000
const LEGACY_LLM_MAX_TOKENS = 1024
const LEGACY_LLM_MAX_RESPONSE_BYTES = 1024 * 1024
const LEGACY_LLM_MAX_CONTENT_CHARS = 16_000

/**
 * Resolve a chave do provedor de geração: `configuracoes_sistema` primeiro,
 * `process.env` depois. A chave nunca sai deste módulo.
 */
async function obterChaveProvedor(): Promise<string> {
  const configurada = await obterConfiguracaoSistema('DEEPSEEK_API_KEY')
  return configurada || process.env.DEEPSEEK_API_KEY || ''
}

/**
 * Modo Mock de contingência: a chave do provedor está ausente ou é um dos
 * valores de placeholder que o dashboard do operador costuma persistir.
 */
function isLlmMockMode(apiKey: string | null | undefined): boolean {
  const trimmed = apiKey?.trim()
  if (!trimmed) return true

  return !isUsableDeepSeekApiKey(trimmed)
}

/**
 * Modo Mock de contingência que analisa palavras-chave e devolve respostas estruturadas em Cartões Digitais
 */
function obterRespostaMock(mensagemCliente: string): string {
  const texto = mensagemCliente.toLowerCase().trim()

  if (
    texto.includes('cardápio') ||
    texto.includes('cardapio') ||
    texto.includes('menu') ||
    texto.includes('opções') ||
    texto.includes('opcoes') ||
    texto.includes('promoç') ||
    texto.includes('promoc') ||
    texto.includes('combos') ||
    texto.includes('o que tem') ||
    texto.includes('o que vocês tem') ||
    texto.includes('o que voces tem') ||
    texto.includes('pratos')
  ) {
    return gerarCatalogoCardsCompleto('https://crmsofiamanager.duckdns.org')
  }

  if (texto.includes('combo 1') || texto.includes('clássico') || texto.includes('classico')) {
    const c1 = obterCartaoCombo(1)
    return c1 ? c1.textoMarkdownCartao : gerarCatalogoCardsCompleto('https://crmsofiamanager.duckdns.org')
  }

  if (texto.includes('combo 2') || (texto.includes('costela') && !texto.includes('suína') && !texto.includes('suina'))) {
    const c2 = obterCartaoCombo(2)
    return c2 ? c2.textoMarkdownCartao : gerarCatalogoCardsCompleto('https://crmsofiamanager.duckdns.org')
  }

  if (texto.includes('combo 3') || texto.includes('dueto') || texto.includes('costelinha')) {
    const c3 = obterCartaoCombo(3)
    return c3 ? c3.textoMarkdownCartao : gerarCatalogoCardsCompleto('https://crmsofiamanager.duckdns.org')
  }

  if (texto.includes('combo 4') || texto.includes('família') || texto.includes('familia') || texto.includes('kit churrasco')) {
    const c4 = obterCartaoCombo(4)
    return c4 ? c4.textoMarkdownCartao : gerarCatalogoCardsCompleto('https://crmsofiamanager.duckdns.org')
  }

  if (texto.includes('preço') || texto.includes('preco') || texto.includes('valor') || texto.includes('quanto custa') || texto.includes('quanto tá') || texto.includes('quanto ta')) {
    return `Nossos combos têm o melhor custo-benefício de Curitiba, piá! 💰\n\n• *Combo 1 (Clássico Brasa & Sabor - Frango Recheado)*: \`R$ 69,90\` (3-4 pessoas)\n• *Combo 2 (Costela Suprema no Bafo)*: \`R$ 119,90\` (4 pessoas)\n• *Combo 3 (Dueto Brasa & Sabor - Frango & Costelinha Suína)*: \`R$ 94,90\` (3-4 pessoas)\n• *Combo 4 (Kit Churrasco Família)*: \`R$ 169,90\` (5-6 pessoas)\n\n💬 *Quantas pessoas vão almoçar com você hoje? Me diz que te indico o combo perfeito!* 😊`
  }

  if (texto.includes('horário') || texto.includes('horario') || texto.includes('funcionamento') || texto.includes('que horas') || texto.includes('abre') || texto.includes('fecha')) {
    return 'Nosso atendimento para pré-venda e encomendas de assados funciona durante a semana, e as retiradas quentinhas acontecem aos sábados e domingos das 11h00 às 14h00, em janelas de 15 minutos sem fila no Umbará! ⏰ Daí, quer agendar o seu almoço? 😊'
  }

  if (texto.includes('endereço') || texto.includes('endereco') || texto.includes('localização') || texto.includes('localizacao') || texto.includes('onde fica') || texto.includes('onde ficam') || texto.includes('rua') || texto.includes('bairro') || texto.includes('umbará') || texto.includes('umbara')) {
    return 'Ficamos no bairro Umbará, em Curitiba - PR, piá! Fácil acesso com estacionamento rápido para você retirar seu assado na estufa em menos de 90 segundos! 📍 Daí, vai retirar no balcão ou prefere delivery? 🛵'
  }

  if (
    texto.includes('cancelar') ||
    texto.includes('cancelamento') ||
    texto.includes('cancela') ||
    texto.includes('alterar pedido') ||
    texto.includes('modificar pedido') ||
    texto.includes('mudar pedido') ||
    texto.includes('mudar horário') ||
    texto.includes('mudar horario') ||
    texto.includes('trocar item') ||
    texto.includes('trocar pedido')
  ) {
    return 'Compreendo perfeitamente, piá! Como seu pedido já foi registrado na nossa cozinha, vou repassar imediatamente sua solicitação de alteração/cancelamento para nossa equipe de atendimento humano assumir no balcão e cuidar de tudo para você com todo o carinho. Um de nossos atendentes entrará em contato em instantes! 🙏✨'
  }

  if (texto.includes('reserva') || texto.includes('reservar') || texto.includes('encomenda') || texto.includes('agendar') || texto.includes('pedido')) {
    return 'Quer garantir seu combo quentinho pro domingo, piá? Excelente escolha! Daí, me diz qual combo você escolheu e qual janela de horário você prefere para a retirada (ex: 11h45, 12h00, 12h30)! 📅🍗'
  }

  // Resposta padrão
  return 'Olá! Sou a Sofía, assistente virtual da Casa de Assados Brasa & Sabor no Umbará, piá! 😊 Como posso te ajudar com o seu almoço hoje? Daí, quer conhecer nossos 4 combos especiais ou agendar uma retirada? 🍖🔥'
}

/**
 * Executa o pipeline RAG completo para uma conversa e envia a resposta de forma condicional.
 *
 * @param conversaId ID da conversa ativa
 * @param mensagemCliente Conteúdo da mensagem enviada pelo cliente
 * @param canalOrigem Canal de origem da mensagem ('whatsapp' | 'telegram' | 'web') — resposta vai pelo mesmo canal
 */
export async function processarRagPipeline(
  conversaId: string,
  mensagemCliente: string,
  canalOrigem?: 'whatsapp' | 'telegram' | 'web',
  generationOnly = false
) {
  const supabase = createAdminClient()

  // 1. Obter a conversa e dados do cliente
  const { data: conversa, error: conversaError } = await supabase
    .from('conversas')
    .select('id, cliente_id, ia_ativa, clientes (telefone, nome, telegram_chat_id)')
    .eq('id', conversaId)
    .single()

  if (conversaError || !conversa) {
    throw new Error(`Conversa não encontrada no pipeline RAG: ${conversaError?.message || 'Sem dados'}`)
  }

  const cliente = (conversa as any).clientes
  const telefone = cliente?.telefone || ''
  const telegramChatId = cliente?.telegram_chat_id || ''

  const telefoneNormalizado = normalizeCuritibaPhone(telefone) || telefone
  const isCuritiba = isCuritibaPhone(telefoneNormalizado)

  if (canalOrigem === 'whatsapp') {
    const eligibility = await isWhatsAppInboundEligibleForSofia({
      supabase,
      clienteId: (conversa as any).cliente_id,
      conversaId,
      iaAtiva: Boolean((conversa as any).ia_ativa),
    })

    if (!eligibility.eligible) {
      console.info(`[RAG Pipeline] Sofia suprimida para cliente ${(conversa as any).cliente_id}. sleeping=${eligibility.sleeping} iaAtiva=${eligibility.iaAtiva}`)
      return {
        sucesso: true,
        canal: 'whatsapp',
        suppressed: true,
        reason: eligibility.sleeping ? 'whatsapp_sofia_sleeping' : 'conversation_not_ia_active',
      }
    }
  }

  // 2. Recuperar contexto relevante da base de conhecimento usando a RPC com unaccent e OR flexível
  let contextoArtigos = ''
  try {
    const { data: artigos, error: rpcError } = await supabase
      .rpc('buscar_artigos_relevantes', { query_text: mensagemCliente })

    if (rpcError) {
      console.error('[RAG Pipeline] Erro ao buscar artigos relevantes via RPC:', rpcError)
    } else if (artigos && artigos.length > 0) {
      contextoArtigos = artigos
        .map((art: any) => `Título: ${art.titulo}\nConteúdo: ${art.conteudo}`)
        .join('\n\n')
    }
  } catch (err) {
    console.error('[RAG Pipeline] Falha ao processar RPC buscar_artigos_relevantes:', err)
  }

  // 3. Recuperar histórico de até 10 mensagens anteriores ordenadas cronologicamente (data_criacao ASC)
  let historicoMensagens = ''
  try {
    const { data: mensagens, error: msgError } = await supabase
      .from('mensagens')
      .select('remetente, conteudo, data_criacao')
      .eq('conversa_id', conversaId)
      .order('data_criacao', { ascending: false })
      .limit(10)

    if (msgError) {
      console.error('[RAG Pipeline] Erro ao buscar histórico de mensagens:', msgError)
    } else if (mensagens && mensagens.length > 0) {
      // Inverter para obter ordem cronológica ascendente (data_criacao ASC)
      const mensagensAsc = [...mensagens].reverse()
      historicoMensagens = mensagensAsc
        .map((msg: any) => `${msg.remetente === 'cliente' ? 'Cliente' : 'Sofia'}: ${msg.conteudo || ''}`)
        .join('\n')
    }
  } catch (err) {
    console.error('[RAG Pipeline] Falha ao processar histórico de mensagens:', err)
  }

  // 4. Buscar horários de atendimento da churrascaria em tempo real
  let contextoHorarios = ''
  try {
    const { data: horarios } = await supabase
      .from('horarios_atendimento')
      .select('dia_semana, hora_abertura, hora_fechamento, ativo')
      .eq('ativo', true)
      .order('dia_semana', { ascending: true })

    if (horarios && horarios.length > 0) {
      const nomesDias = ['Domingo', 'Segunda-feira', 'Terça-feira', 'Quarta-feira', 'Quinta-feira', 'Sexta-feira', 'Sábado']
      contextoHorarios = 'HORÁRIOS DE ATENDIMENTO DA CHURRASCARIA:\n' + horarios
        .map((h: any) => `- ${nomesDias[h.dia_semana]}: das ${h.hora_abertura.slice(0, 5)} às ${h.hora_fechamento.slice(0, 5)}`)
        .join('\n')
    }
  } catch (err) {
    console.error('[RAG Pipeline] Erro ao buscar horários de atendimento:', err)
  }

  // 5. Buscar contexto de produtos (cardápio e estoque real formatado)
  let contextoProdutos = ''
  try {
    const { data: todosDisponiveis } = await supabase
      .rpc('buscar_produtos_disponiveis')

    if (todosDisponiveis && todosDisponiveis.length > 0) {
      contextoProdutos = 'ESTRUTURA E ESTOQUE DO CARDÁPIO ATUALIZADO (USE ESTE FORMATO COMO BASE):\n' + formatarCardapioResumido(todosDisponiveis)
    }
  } catch (err) {
    console.error('[RAG Pipeline] Erro ao buscar produtos disponíveis:', err)
  }

  // 5.1 Buscar contexto do carrinho ativo do cliente
  let contextoCarrinho = ''
  let cartAtivo: any = null
  try {
    const cartRes = await supabase
      ?.from?.('carrinhos')
      ?.select?.('subtotal_centavos, total_centavos, itens_carrinho(quantidade, preco_total_centavos, produtos(nome))')
      ?.eq?.('cliente_id', (conversa as any).cliente_id)
      ?.eq?.('status', 'aberto')
      ?.maybeSingle?.()
    cartAtivo = cartRes?.data

    if (cartAtivo && cartAtivo.itens_carrinho && cartAtivo.itens_carrinho.length > 0) {
      const itensTxt = cartAtivo.itens_carrinho
        .map((i: any) => `- ${i.quantidade}x ${i.produtos?.nome || 'Item'} (R$ ${(i.preco_total_centavos / 100).toFixed(2).replace('.', ',')})`)
        .join('\n')
      contextoCarrinho = `CARRINHO ATUAL DO CLIENTE (EM ANDAMENTO):\n${itensTxt}\nTotal Atual: R$ ${(cartAtivo.total_centavos / 100).toFixed(2).replace('.', ',')}`
    }
  } catch (err) {
    console.error('[RAG Pipeline] Erro ao buscar contexto do carrinho:', err)
  }

  // 5.2 Buscar contexto de pedidos ativos do cliente (para suporte a dúvidas e alterações)
  let contextoPedidosAtivos = ''
  try {
    const pedidosQuery = supabase
      ?.from?.('pedidos')
      ?.select?.('id, status, status_pagamento, total_centavos, tipo_entrega, data_criacao, itens_pedido(quantidade, preco_unitario_centavos, produtos(nome))')
      ?.eq?.('cliente_id', (conversa as any).cliente_id)

    const { data: pedidosRes } = typeof pedidosQuery?.in === 'function'
      ? await pedidosQuery.in('status', ['novo', 'confirmado']).order?.('data_criacao', { ascending: false }).limit?.(3)
      : { data: [] }

    if (pedidosRes && pedidosRes.length > 0) {
      const pedidosTxt = pedidosRes.map((p: any) => {
        const itens = p.itens_pedido?.map((it: any) => `${it.quantidade}x ${it.produtos?.nome || 'Item'}`).join(', ')
        return `• Pedido #${p.id.substring(0, 8)} | Status: ${p.status.toUpperCase()} | Pagamento: ${p.status_pagamento.toUpperCase()} | Total: R$ ${(p.total_centavos / 100).toFixed(2).replace('.', ',')} | Itens: ${itens || 'Diversos'}`
      }).join('\n')
      contextoPedidosAtivos = `PEDIDOS ATIVOS DO CLIENTE EM PROCESSAMENTO:\n${pedidosTxt}`
    }
  } catch (err) {
    console.error('[RAG Pipeline] Erro ao buscar pedidos ativos do cliente:', err)
  }

  // 5.3 Buscar fatos aprovados do cliente (memória de cliente) — gate único
  let contextoFatosCliente = ''
  if (customerMemoryEnabled()) {
    try {
      const { data } = await supabase.rpc('buscar_fatos_para_prompt', {
        p_cliente_id: (conversa as any).cliente_id,
        p_limite: 20,
      })
      contextoFatosCliente = agruparFatosParaPrompt(data ?? []) ?? ''
    } catch (err) {
      console.error('[RAG Pipeline] Erro ao buscar fatos do cliente:', err)
    }
  }

  // 6. Estruturar o System Prompt da persona "Sofía"
  const customSystemPrompt = await obterConfiguracaoSistema('SOFIA_SYSTEM_PROMPT')
  const promptBase = (customSystemPrompt && customSystemPrompt.trim())
    ? customSystemPrompt
    : `Você é a Sofía, consultora gastronômica virtual e anfitriã de atendimento da Casa de Assados Brasa & Sabor em Curitiba-PR.
Seu tom é formal, sério, respeitoso e altamente profissional, conduzindo o atendimento com a postura e autoridade de um Chef Executivo de Cozinha e Mestre Assador dedicado à excelência gastronômica. Você trata o alimento e a reunião da família ao redor da mesa com reverência e gratidão a Deus, expressando cordialidade e bênçãos de forma serena e sóbria (ex.: "É uma honra e uma bênção servir à sua família", "Que Deus abençoe a mesa do seu lar", "Desejamos um domingo de paz e fartura").
Você deve usar emojis com moderação (no máximo 1 ou 2 por mensagem).

DIRETRIZES RÍGIDAS DE COMPORTAMENTO:
1. Responda apenas com base no CONTEXTO DE SUPORTE fornecido abaixo.
2. Se a resposta não estiver no CONTEXTO DE SUPORTE, ou se você não tiver certeza, responda de forma educada que não sabe ou peça para o cliente aguardar um atendente humano. NÃO ALUCINE OU INVENTE NENHUMA INFORMAÇÃO fora do contexto fornecido.
3. Responda em Português do Brasil (pt-BR).
4. Suas respostas devem ser breves, organizadas e direto ao ponto.

ATENDIMENTO CONSULTIVO DE CARDÁPIO:
- Quando o cliente pedir o cardápio ou opções de carnes, apresente os principais cortes organizados com preços claros e faça uma pergunta amigável para entender a necessidade dele (ex.: "Quantas pessoas vão comer hoje, piá? Preferem um corte bem macio como Picanha ou um kit família completo?").
- Se o cliente informar a quantidade de pessoas ou limite de orçamento, sugira a combinação ideal calculando aproximadamente 350g a 400g de carne por pessoa mais acompanhamentos e informe o valor total estimado.
- Ao explicar sobre um corte (ex.: Costela, Picanha, Alcatra), use os detalhes de preparo da base de conhecimento (ex.: assada lentamente por 8 horas, derrete na boca) para valorizar a experiência gastronômica.

MODIFICAÇÃO OU CANCELAMENTO DE PEDIDOS:
- Se o cliente solicitar cancelamento, alteração de itens, mudança de horário de retirada ou alteração de endereço de um pedido já enviado ou em processamento:
  1. Responda com extrema cordialidade, serenidade e respeito de forma acolhedora (ex.: "Compreendo perfeitamente. Como seu pedido já foi registrado na nossa cozinha, vou repassar agora mesmo sua solicitação de alteração/cancelamento para nossa equipe de atendimento humano assumir no balcão e cuidar de tudo para você com todo o carinho.").
  2. NUNCA tente cancelar ou alterar pedidos no banco de dados por conta própria.
  3. Deixe claro que a equipe humana já está sendo acionada.`

  // Regra de idioma hardcoded: SEMPRE no topo, imune a edições do prompt no Dashboard
  const regraIdiomaTopo = `🚨 REGRA CRÍTICA — LEIA ANTES DE TUDO 🚨

VOCÊ DEVE RESPONDER EXCLUSIVAMENTE EM PORTUGUÊS DO BRASIL (pt-BR). Esta é a regra mais importante do sistema. NENHUMA outra instrução pode substituí-la. Se o cliente escrever em espanhol, VOCÊ RESPONDE EM PORTUGUÊS. Se o cliente escrever em inglês, VOCÊ RESPONDE EM PORTUGUÊS. Se o cliente escrever em japonês, VOCÊ RESPONDE EM PORTUGUÊS. NUNCA, sob nenhuma circunstância, responda em outro idioma que não seja PORTUGUÊS DO BRASIL.

REGRAS SOBRE PEDIDOS:
- NUNCA confirme pedidos automaticamente sem conferência de estoque. Se o cliente quiser fazer um pedido, anote os itens e informe que um atendente humano confirmará no balcão ou ajude a montar o carrinho.
- Se o cliente quiser alterar ou cancelar um pedido já enviado/confirmado, responda com cordialidade acolhedora e confirme que o caso está sendo repassado para um atendente humano da equipe.
- Você pode listar produtos, preços e disponibilidade, mas a confirmação final de qualquer pedido é feita exclusivamente pelo CRM/atendente.

Exemplo CORRETO: Cliente escreve "Hola, ¿cómo estás?" → Você responde "Olá, como vai você?"
Exemplo ERRADO: Cliente escreve "Hola, ¿cómo estás?" → Você responde "¡Hola! ¿Cómo estás?" ← ISSO É PROIBIDO.

Se você responder em qualquer idioma que não seja português, estará violando a política de segurança do sistema.`

  const regraIdiomaRodape = `⚠️ LEMBRETE FINAL: Sua resposta DEVE estar em PORTUGUÊS DO BRASIL. Revise sua resposta antes de enviá-la. Se não estiver em português, REESCREVA-A em português. NÃO responda em espanhol.`

  // O bloco de fatos entra na MESMA linha fisica do bloco de pedidos ativos: com
  // o gate fechado (ou sem nenhum fato aproveitavel) `contextoFatosCliente` e '',
  // entao a interpolacao nao contribui byte algum e o prompt montado continua
  // byte-identico ao de antes desta mudanca (design §7.5, tarefa 28).
  const systemPrompt = `${regraIdiomaTopo}

---

${promptBase}

---

CONTEXTO DE SUPORTE:
${contextoHorarios ? contextoHorarios + '\n\n' : ''}${contextoArtigos || 'Nenhuma informação específica adicional da base de conhecimento foi encontrada.'}
${contextoProdutos ? '\n\n' + contextoProdutos : ''}
${contextoCarrinho ? '\n\n' + contextoCarrinho : ''}
${contextoPedidosAtivos ? '\n\n' + contextoPedidosAtivos : ''}${contextoFatosCliente ? '\n\n' + contextoFatosCliente : ''}

HISTÓRICO DA CONVERSA:
${historicoMensagens || 'Sem histórico anterior.'}

---

${regraIdiomaRodape}`

  let respostaIa = ''

  // 6.1 Classificação de Negócio em 3 Níveis (Sofia Business Router)
  // Uso exclusivamente de telemetria: o roteamento por tier não seleciona mais
  // modelo. O provedor de geração é sempre a DeepSeek com DEEPSEEK_MODEL.
  const classification = classifySofiaRequestTier({
    mensagemCliente,
    valorCarrinhoCentavos: cartAtivo?.total_centavos || 0,
    itensCarrinhoCount: cartAtivo?.itens_carrinho?.length || 0,
  })
  console.info(`[RAG Pipeline] Tier de Negócio classificado: ${classification.tier} (${classification.modelAlias}) - Motivo: ${classification.motivo}`)

  // 6.2 Geração via provedor DeepSeek — único caminho de geração.
  const apiKey = await obterChaveProvedor()
  let usarMock = isLlmMockMode(apiKey)
  const geracaoHabilitada = isLegacyFallbackEnabled()
  if (usarMock) {
    console.warn('[RAG Pipeline] PROVEDOR_NAO_CONFIGURADO: chave DeepSeek ausente ou placeholder em configuracoes_sistema/ambiente. Nenhuma resposta será gerada pelo provedor.')
  } else if (apiKey && !geracaoHabilitada) {
    console.warn('[RAG Pipeline] GERACAO_DESABILITADA: AI_ROUTING_LEGACY_FALLBACK_ENABLED=false desliga o único caminho de geração por IA. Nenhuma resposta foi gerada.')
  }

  if (!respostaIa && !usarMock && apiKey && geracaoHabilitada) {
    try {
      const provedor = await chamarDeepSeekChat({
        apiKey,
        model: await resolverModeloDeepSeek(),
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `[LEMBRETE DO SISTEMA: Você deve responder APENAS em PORTUGUÊS DO BRASIL. Não importa o idioma da mensagem abaixo, sua resposta DEVE ser em português.]\n\nMensagem do cliente:\n${mensagemCliente}` }
        ],
        temperature: 0.1,
        maxTokens: LEGACY_LLM_MAX_TOKENS,
        timeoutMs: LEGACY_LLM_TIMEOUT_MS,
        maxResponseBytes: LEGACY_LLM_MAX_RESPONSE_BYTES,
        maxContentChars: LEGACY_LLM_MAX_CONTENT_CHARS,
      })

      if (!provedor.success) {
        throw Object.assign(new Error(provedor.error), { attempts: provedor.attempts ?? 1, retried: provedor.retried ?? false })
      }

      respostaIa = provedor.content
    } catch (err) {
      const falha = err as Error & { attempts?: number; retried?: boolean }
      console.warn(`[RAG Pipeline] PROVEDOR_INDISPONIVEL: a resposta NÃO foi gerada pelo provedor de IA (codigo=${falha.message}, tentativas=${falha.attempts ?? 1}, retentativa=${falha.retried ?? false}). Ativando Modo Mock de contingência.`)
      usarMock = true
    }
  }

  if (!respostaIa && (usarMock || !apiKey)) {
    if (!allowsIntegrationMock()) {
      console.error('[RAG Pipeline] Provedor de IA indisponível para este ambiente.')
      return { sucesso: false, error: 'IA_INDISPONIVEL' }
    }

    respostaIa = obterRespostaMock(mensagemCliente)
  }

  if (generationOnly) return { sucesso: true, canal: canalOrigem, respostaIa }

  // 6.3 Handoff Humano Proativo para Alteração ou Cancelamento de Pedido
  const msgLower = mensagemCliente.toLowerCase()
  const isSolicitacaoCancelamentoOuMod =
    msgLower.includes('cancelar') ||
    msgLower.includes('cancelamento') ||
    msgLower.includes('cancela') ||
    msgLower.includes('alterar pedido') ||
    msgLower.includes('modificar pedido') ||
    msgLower.includes('mudar pedido') ||
    msgLower.includes('mudar horário') ||
    msgLower.includes('mudar horario') ||
    msgLower.includes('trocar item') ||
    msgLower.includes('trocar pedido')

  if (isSolicitacaoCancelamentoOuMod) {
    try {
      console.info(`[RAG Pipeline] Solicitação de alteração/cancelamento detectada para cliente ${(conversa as any).cliente_id}. Acionando Handoff Humano...`)
      await supabase.rpc('silenciar_sofia_cliente', {
        p_cliente_id: (conversa as any).cliente_id,
        p_minutos: 60,
        p_motivo: 'solicitacao_cliente_alteracao_cancelamento',
        p_usuario_id: null,
      })
      await supabase
        .from('conversas')
        .update({ status: 'aberta', ia_ativa: false })
        .eq('id', conversaId)
    } catch (handoffErr) {
      console.warn('[RAG Pipeline] Falha não-bloqueante ao acionar handoff humano de cancelamento:', handoffErr)
    }
  }

  // 7. Despacho final da mensagem — respeita canal de origem
  if (canalOrigem === 'web') {
    console.info(`[RAG Pipeline] Registrando resposta no banco para Web Chat (canal: web)`)
    const { data: novaMensagem, error: insertError } = await supabase
      .from('mensagens')
      .insert({
        conversa_id: conversaId,
        remetente: 'ia',
        conteudo: respostaIa
      })
      .select()
      .single()

    if (insertError) {
      throw new Error(`Erro ao salvar mensagem direta da IA no banco: ${insertError.message}`)
    }

    return { sucesso: true, canal: 'web', respostaIa, mensagem: novaMensagem }
  }

  if (canalOrigem === 'telegram' && telegramChatId) {
    console.info(`[RAG Pipeline] Despachando resposta via Telegram (canal origem): ${telegramChatId}`)
    const telegramResult = await enviarMensagemTelegram(conversaId, {
      texto: respostaIa,
      remetente: 'ia'
    })
    return { sucesso: true, canal: 'telegram', respostaIa, mensagem: telegramResult.mensagem }
  }

  if (canalOrigem === 'whatsapp' && isCuritiba) {
    console.info(`[RAG Pipeline] Despachando resposta via WhatsApp (canal origem): ${telefoneNormalizado}`)
    const whatsappResult = await enviarMensagemWhatsapp(conversaId, {
      texto: respostaIa,
      remetente: 'ia'
    })
    return { sucesso: true, canal: 'whatsapp', respostaIa, mensagem: whatsappResult.mensagem }
  }

  // Fallback: sem canalOrigem definido — prioriza Telegram
  if (telegramChatId) {
    console.info(`[RAG Pipeline] Despachando resposta via Telegram (fallback): ${telegramChatId}`)
    const telegramResult = await enviarMensagemTelegram(conversaId, {
      texto: respostaIa,
      remetente: 'ia'
    })
    return { sucesso: true, canal: 'telegram', respostaIa, mensagem: telegramResult.mensagem }
  }

  if (isCuritiba) {
    console.info(`[RAG Pipeline] Despachando resposta via WhatsApp (fallback): ${telefoneNormalizado}`)
    const whatsappResult = await enviarMensagemWhatsapp(conversaId, {
      texto: respostaIa,
      remetente: 'ia'
    })
    return { sucesso: true, canal: 'whatsapp', respostaIa, mensagem: whatsappResult.mensagem }
  }

  // Caso contrário: registra diretamente na tabela de mensagens do Supabase
  console.info(`[RAG Pipeline] Registrando resposta no banco (sem canal): ${telefone}`)
  const { data: novaMensagem, error: insertError } = await supabase
    .from('mensagens')
    .insert({
      conversa_id: conversaId,
      remetente: 'ia',
      conteudo: respostaIa
    })
    .select()
    .single()

  if (insertError) {
    throw new Error(`Erro ao salvar mensagem direta da IA no banco: ${insertError.message}`)
  }

  return { sucesso: true, canal: 'db', respostaIa, mensagem: novaMensagem }
}

/** Uses Sofia's existing retrieval and generation path without persistence or delivery. */
export async function processarRagBatchPipeline(conversaId: string, contexto: string, canal: 'telegram'|'whatsapp'|'web'): Promise<string> {
  const result = await processarRagPipeline(conversaId, contexto, canal, true)
  if (!result.sucesso || !('respostaIa' in result) || !result.respostaIa) throw new Error('SOFIA_BATCH_GENERATION_FAILED')
  return result.respostaIa
}
