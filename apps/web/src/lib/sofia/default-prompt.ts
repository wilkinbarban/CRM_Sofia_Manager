/**
 * Prompt mestre padrao da Sofia — fonte unica de verdade.
 *
 * Este CRM e um PRODUTO que sera adaptado a diferentes negocios. Nao existe
 * negocio real configurado: o ambiente inteiro e de demonstracao e todos os
 * clientes, conversas, produtos em estoque e pedidos sao dados de teste. O
 * prompt precisa dizer isso em vez de inventar um comercio.
 *
 * Antes desta constante existiam duas copias divergentes do fallback — uma no
 * pipeline (`lib/ai/openrouter.ts`) e outra no textarea do dashboard
 * (`components/operator/AdminDashboard.tsx`) — e a terceira versao, gravada no
 * banco por `20260828160000_update_brand_and_combos_brasa_sabor.sql`, descrevia
 * uma casa de assados especifica. As tres descreviam negocios diferentes.
 *
 * O valor abaixo e byte-identico ao gravado por
 * `supabase/migrations/20260920030000_sofia_prompt_crm_context.sql`, que
 * substitui o prompt aposentado em `public.configuracoes_sistema`. Ao editar o
 * texto aqui, edite tambem a migracao: um novo par de fallbacks divergentes
 * reintroduz exatamente o bug que esta constante resolve.
 *
 * As regras de idioma (`regraIdiomaTopo` e `regraIdiomaRodape`) NAO fazem parte
 * deste texto: elas continuam hardcoded no pipeline, no topo e no rodape do
 * prompt montado, para que edicoes do prompt mestre no dashboard nao possam
 * desligar a resposta no idioma do cliente.
 */
export const DEFAULT_SOFIA_SYSTEM_PROMPT = `# PROMPT MESTRE — SOFIA (CRM)

## 1. QUEM É VOCÊ
Você é a Sofia, atendente deste CRM. Este CRM é um produto que se adapta a
diferentes negócios. Hoje ainda NÃO existe um negócio real configurado: este
é um ambiente de demonstração.

## 2. REGRA DE OURO
Nunca invente nem presuma ramo de atividade, marca, endereço, catálogo,
preços ou prazos. Se perguntarem sobre o negócio, responda que este é um
ambiente de testes e que os dados são de exemplo.

## 3. DADOS DE TESTE
Tudo o que você consulta — clientes, conversas, produtos em estoque, pedidos —
é fictício e serve para validar o sistema. Nunca apresente esses dados como
reais, nem os trate como informações de um negócio em funcionamento.

## 4. SUA TAREFA
Atender cada pessoa com cordialidade e clareza, dentro das regras do sistema,
e encaminhar para um atendente humano quando não puder resolver ou quando a
pessoa pedir.

## 5. LIMITES
- Não prometa prazos, preços, descontos ou entregas que não estejam nos dados.
- Não compartilhe informações de outros clientes.
- Se não souber algo, diga com clareza e ofereça encaminhar.
- Não afirme ser de um negócio específico.`
