# Especificação de Requisitos: RAG e Base de Conhecimento (rag_conhecimento)

**ID da Mudança:** `epica5-rag-knowledge`  
**Domínio:** `rag_conhecimento`  
**Status:** `Aprovado`  

---

## 1. Descrição Executiva
Este documento especifica a implementação do módulo de Recuperação de Informação e Geração Aumentada por Recuperação (RAG - Retrieval-Augmented Generation) integrado à Base de Conhecimento da Churrascaria. O objetivo principal é automatizar o atendimento a clientes através do WhatsApp e Portal Web usando o modelo de linguagem da OpenRouter com a persona virtual "Sofía". A Inteligência Artificial responderá às dúvidas comuns dos clientes (cardápio, preços, horários de funcionamento, regras de reservas e endereço) baseando-se estritamente nos artigos cadastrados e mantidos por administradores em um painel gerencial dedicado.

---

## 2. Requisitos de Negócio e de Sistema (RFC 2119)

### 2.1 Modelagem do Banco de Dados da Base de Conhecimento
*   **REQ-RAG-001**: O sistema MUST criar a tabela `public.base_conhecimento` contendo a seguinte estrutura exata:
    *   `id` UUID PRIMARY KEY DEFAULT `gen_random_uuid()`
    *   `titulo` VARCHAR(255) NOT NULL
    *   `conteudo` TEXT NOT NULL
    *   `tags` VARCHAR(100)[] NOT NULL DEFAULT '{}'
    *   `ativo` BOOLEAN NOT NULL DEFAULT TRUE
    *   `data_criacao` TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    *   `data_atualizacao` TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
*   **REQ-RAG-002**: A tabela `public.base_conhecimento` MUST possuir um trigger `tr_base_conhecimento_atualizar_data` para executar a função `public.atualizar_data_atualizacao()` antes de qualquer operação de `UPDATE`.
*   **REQ-RAG-003**: As políticas de segurança no nível de linha (RLS) MUST ser ativadas para `public.base_conhecimento`.
*   **REQ-RAG-004**: Usuários autenticados com funções de operadores (`admin`, `supervisor`, `vendedor`) MUST possuir permissão completa para realizar operações CRUD (`SELECT`, `INSERT`, `UPDATE`, `DELETE`) na tabela `public.base_conhecimento`.
*   **REQ-RAG-005**: Usuários finais (`cliente`) e usuários anônimos (`public`) MUST NOT ter permissões de escrita (`INSERT`, `UPDATE`, `DELETE`) na tabela `public.base_conhecimento`.
*   **REQ-RAG-006**: A leitura (`SELECT`) direta via API cliente-side (anon/cliente) MUST ser negada, devendo o pipeline de IA consultar a base de conhecimento através de funções do banco configuradas como `SECURITY DEFINER` ou por meio de conexão de backend que utilize a chave `service_role` (bypass RLS).

### 2.2 Serviço de Recuperação de Conhecimento (Busca FTS)
*   **REQ-RAG-007**: O sistema MUST implementar um serviço ou função no banco de dados para buscar os artigos mais relevantes na tabela `public.base_conhecimento`.
*   **REQ-RAG-008**: A busca MUST utilizar indexação e sintaxe de busca textual (Full-Text Search) do PostgreSQL, aplicando o dicionário de idioma `'portuguese'`.
*   **REQ-RAG-009**: O serviço de busca MUST combinar e ponderar os campos `titulo` (com maior peso) e `conteudo` (com peso padrão) para o cálculo da relevância dos artigos.
*   **REQ-RAG-010**: Apenas artigos ativos (`ativo = TRUE`) MUST ser retornados pelo serviço de busca.
*   **REQ-RAG-011**: O serviço de busca MUST limitar o resultado a no máximo 3 (três) artigos com melhor classificação de relevância para a consulta informada.

### 2.3 Integração com OpenRouter e Persona "Sofía"
*   **REQ-RAG-012**: O backend do sistema MUST carregar as credenciais e parâmetros do modelo a partir das variáveis de ambiente `OPENROUTER_API_KEY` e `OPENROUTER_MODEL`.
*   **REQ-RAG-013**: A chave `OPENROUTER_API_KEY` MUST ser mantida em segredo absoluto no servidor e nunca ser exposta ao frontend ou gravada em logs de auditoria.
*   **REQ-RAG-014**: A persona da assistente virtual "Sofía" MUST seguir estritamente as seguintes diretrizes de escrita e comportamento no prompt do sistema (System Prompt):
    *   **Identidade**: Assistente virtual simpática da Churrascaria (Asados).
    *   **Tom e Linguagem**: Educação, presteza, respostas breves e uso moderado de emojis amigáveis.
    *   **Regionalismo**: Linguagem característica de Curitiba/PR (ex: uso natural de expressões locais, de forma polida e sutil), escrevendo estritamente em português do Brasil (`pt-BR`).
    *   **Aderência ao Contexto (Guardrails)**: Responder às perguntas com base única e exclusiva nas informações fornecidas no contexto dos artigos recuperados.
    *   **Tratamento de Alucinações**: Caso o contexto recuperado não contenha a resposta para a pergunta do cliente, a IA MUST informar educadamente que não possui a informação exata e se oferecer para transferir o atendimento para um operador humano.

### 2.4 Execução do Pipeline de RAG (Gancho de Entrada / Inbound Hook)
*   **REQ-RAG-015**: O pipeline de RAG MUST ser disparado de forma automática e assíncrona sempre que uma nova linha for inserida na tabela `public.mensagens` onde o `remetente` seja igual a `'cliente'`.
*   **REQ-RAG-016**: O pipeline de RAG SHALL NOT ser executado se a coluna `ia_ativa` na tabela `public.conversas` correspondente for igual a `FALSE`.
*   **REQ-RAG-017**: Ao iniciar a execução, o pipeline MUST construir o contexto de entrada para a chamada da API do OpenRouter, composto por:
    1.  **System Prompt**: Definição da Persona "Sofía", regras de comportamento e guardrails anti-alucinação.
    2.  **Contexto da Base de Conhecimento**: O conteúdo dos 3 artigos recuperados pelo Serviço de Recuperação de Conhecimento com base no texto da última mensagem do cliente.
    3.  **Histórico da Conversa**: As últimas 10 mensagens anteriores daquela conversa ordenadas cronologicamente (`data_criacao` ascendente), identificando claramente o remetente de cada uma (cliente, operador, ia).
    4.  **Mensagem Atual**: O conteúdo textual da mensagem recém-inserida pelo cliente.
*   **REQ-RAG-018**: O sistema MUST efetuar a chamada HTTP ao serviço da OpenRouter enviando o contexto construído e aguardar a geração da resposta.
*   **REQ-RAG-019**: Ao receber a resposta da OpenRouter, o sistema MUST inseri-la na tabela `public.mensagens` preenchendo a coluna `conversa_id`, definindo `remetente` como `'ia'::public.tipo_remetente` e o conteúdo retornado pela IA.
*   **REQ-RAG-020**: Caso a conversa correspondente esteja vinculada a um cliente com telefone validado e verificado (conforme políticas da Épica 1), o sistema MUST chamar de forma imediata e assíncrona a função de envio do WhatsApp (`enviarMensagemWhatsapp` ou correspondente da Meta Cloud API) para entregar a resposta gerada ao celular do cliente.

### 2.5 Painel Administrativo de CRUD da Base de Conhecimento
*   **REQ-RAG-021**: O sistema MUST disponibilizar a tela de gerenciamento de conhecimento no endereço `/atendimento/conhecimento` ou aba correspondente do painel administrativo.
*   **REQ-RAG-022**: Apenas usuários autenticados com funções de `admin` ou `supervisor` MUST ter permissão para acessar a página de gerenciamento de conhecimento. Acessos por usuários com outras funções MUST ser bloqueados e resultar em erro de acesso negado (Código HTTP 403).
*   **REQ-RAG-023**: A interface gráfica do painel administrativo MUST permitir:
    *   Visualizar a lista de todos os artigos da base de conhecimento em tabela organizada.
    *   Filtrar ou buscar artigos pelo título ou pelas tags cadastradas.
    *   Cadastrar um novo artigo com campos de Título, Conteúdo (Texto), Tags (lista ou texto separado por vírgula) e status Ativo.
    *   Editar um artigo existente, preservando o histórico de data de criação.
    *   Alternar rapidamente o status de um artigo (`ativo` = `TRUE`/`FALSE`) diretamente pela listagem.
    *   Excluir um artigo com confirmação de segurança.
*   **REQ-RAG-024**: O design do painel administrativo MUST seguir padrões estéticos modernos e premium do projeto, apresentando transições suaves de hover nos botões, modals flutuantes elegantes para criação/edição e feedback visual claro de sucesso/erro para cada ação.

### 2.6 Base de Conhecimento e Processamento de Documentos RAG (PDF/DOCX)
*   **REQ-RAG-DOC-001**: O sistema MUST criar a tabela `public.documentos_base_conhecimento` para cadastrar os arquivos físicos associados à base de conhecimento:
    *   `id` UUID PRIMARY KEY DEFAULT `gen_random_uuid()`
    *   `nome_arquivo` VARCHAR(255) NOT NULL
    *   `tamanho_bytes` BIGINT NOT NULL
    *   `tipo_mime` VARCHAR(100) NOT NULL
    *   `caminho_storage` TEXT NOT NULL (caminho no bucket do storage)
    *   `data_criacao` TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    *   `data_atualizacao` TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
*   **REQ-RAG-DOC-002**: O sistema MUST criar um trigger de alteração de timestamp de modificação na tabela `public.documentos_base_conhecimento`.
*   **REQ-RAG-DOC-003**: A tabela `public.base_conhecimento` MUST receber a coluna `documento_id` UUID que referencia `public.documentos_base_conhecimento(id)` com a política de integridade referencial `ON DELETE CASCADE`.
*   **REQ-RAG-DOC-004**: O painel de controle da Base de Conhecimento MUST incluir uma seção para upload de arquivos em PDF e DOCX.
*   **REQ-RAG-DOC-005**: O limite máximo de tamanho por arquivo carregado MUST ser de 10MB (`10.485.760 bytes`).
*   **REQ-RAG-DOC-006**: O limite máximo de registros ativos na tabela `public.documentos_base_conhecimento` MUST ser de 50. Carregamentos que excedam esse número total MUST ser recusados no backend com erro de limite.
*   **REQ-RAG-DOC-007**: Os arquivos carregados MUST ser armazenados em um bucket privado do Supabase Storage chamado `'documentos-conhecimento'`.
*   **REQ-RAG-DOC-008**: Após o upload do arquivo para o bucket, o backend do sistema MUST realizar a extração textual automática do conteúdo do documento PDF ou DOCX utilizando bibliotecas do lado do servidor (ex: `pdf-parse` e `mammoth` ou similares).
*   **REQ-RAG-DOC-009**: O texto resultante da extração MUST ser segmentado semânticamente em blocos (chunks) de texto de até 4000 caracteres.
*   **REQ-RAG-DOC-010**: Cada bloco de texto gerado a partir do documento MUST ser salvo automaticamente como um novo registro na tabela `public.base_conhecimento`, com:
    *   `titulo`: Nome do arquivo concatenado com a indicação da respectiva parte (ex: "manual_churrascaria.pdf - Parte 1").
    *   `conteudo`: O texto do bloco segmentado.
    *   `documento_id`: Referência ao `id` do documento gerador.
    *   `ativo`: `TRUE` por padrão.
*   **REQ-RAG-DOC-011**: Ao excluir um documento na tabela `public.documentos_base_conhecimento`, os registros de base de conhecimento vinculados a ele MUST ser apagados em cascata, e o arquivo correspondente no bucket do Supabase Storage MUST ser removido fisicamente.


---

## 3. Cenários de Aceitação (Gherkin - Given/When/Then)

### Cenário 1: Busca FTS retorna artigos corretos com base em relevância
*   **Given** que a tabela `public.base_conhecimento` possui os seguintes artigos ativos cadastrados:
    *   Artigo A: Título "Horários de Funcionamento", Conteúdo "Estamos abertos de terça a domingo das 11h30 às 23h."
    *   Artigo B: Título "Tipos de Cortes de Carne", Conteúdo "Servimos picanha, alcatra, costela e cupim."
    *   Artigo C: Título "Formas de Reserva", Conteúdo "Reservas de mesas podem ser feitas para terça a quinta."
*   **When** o serviço de recuperação de conhecimento é acionado com a query "Qual o horário que abre no domingo?"
*   **Then** o sistema realiza a busca por correspondência de texto completo (Full-Text Search) com dicionário em português.
*   **And** retorna o Artigo A como primeiro resultado devido à alta pontuação de relevância de palavras-chave.
*   **And** o número total de artigos retornados não ultrapassa o limite máximo de 3 registros.

### Cenário 2: Pipeline de RAG ativa ao receber mensagem do cliente com IA ligada
*   **Given** que existe uma conversa ativa (`status` = `'ia_atendendo'` ou `'aberta'`) com a flag `ia_ativa` = `TRUE`.
*   **When** uma nova mensagem é inserida na tabela `public.mensagens` com o conteúdo "Quais carnes vocês servem?" e `remetente` = `'cliente'`.
*   **Then** o sistema intercepta a inserção e dispara a execução do pipeline de RAG.
*   **And** busca os artigos relacionados ao termo "carnes" na tabela `public.base_conhecimento`.
*   **And** monta o prompt histórico com as últimas 10 mensagens, o system prompt da persona "Sofía" e os artigos recuperados.
*   **And** realiza a requisição ao OpenRouter.
*   **And** salva a resposta retornada pela IA na tabela `public.mensagens` com `remetente` = `'ia'`.

### Cenário 3: Pipeline de RAG ignora mensagem quando IA está desligada
*   **Given** que existe uma conversa com a flag `ia_ativa` = `FALSE` (atendimento humano assumido).
*   **When** o cliente insere uma nova mensagem na tabela `public.mensagens` com o conteúdo "Qual o endereço?".
*   **Then** o sistema intercepta a inserção, mas aborta a execução do pipeline de RAG imediatamente sem realizar consultas de artigos nem chamadas para a API do OpenRouter.

### Cenário 4: Resposta da IA enviada automaticamente para o WhatsApp do cliente verificado
*   **Given** que uma conversa está associada a um registro de cliente que possui o telefone verificado `5541988887777`.
*   **And** a IA "Sofía" gerou com sucesso uma resposta para o cliente no banco de dados.
*   **When** a resposta da IA é salva na tabela `public.mensagens` com `remetente` = `'ia'`.
*   **Then** o sistema identifica que o cliente associado possui um telefone verificado.
*   **And** invoca assincronamente a integração de saída Meta Cloud API enviando a mensagem de texto gerada para o WhatsApp do cliente.

### Cenário 5: Tratamento de dúvidas fora do escopo da Base de Conhecimento (Anti-alucinação)
*   **Given** que a base de conhecimento possui artigos apenas sobre horários, cardápio e endereço.
*   **When** o cliente envia a pergunta "Vocês vendem carvão para viagem?" e o serviço de FTS não encontra artigos de alta relevância ou os artigos recuperados não respondem à pergunta.
*   **Then** o OpenRouter processa a pergunta com base nos guardrails da persona "Sofía".
*   **And** a IA responde informando educadamente que não dispõe dessa informação específica.
*   **And** sugere a transferência do atendimento para um atendente humano para que ele possa ajudar com a dúvida.

### Cenário 6: Acesso restrito ao Painel CRUD da Base de Conhecimento
*   **Given** que o usuário está autenticado com o perfil de função `cliente` ou `vendedor`.
*   **When** o usuário tenta navegar diretamente para a rota `/atendimento/conhecimento`.
*   **Then** o sistema intercepta a rota no middleware ou validação server-side.
*   **And** rejeita a navegação exibindo uma tela de erro de acesso negado (HTTP 403) ou redireciona o usuário para a sua tela inicial com um alerta de privilégios insuficientes.

### Cenário 7: Administrador gerencia artigos no Painel CRUD
*   **Given** que o usuário está autenticado com a função `admin` e acessa `/atendimento/conhecimento`.
*   **When** o administrador preenche o formulário de novo artigo com Título = "Preço do Rodízio", Conteúdo = "O preço do rodízio completo é R$ 119,90 por pessoa.", Tags = "preco, rodizio, valores" e salva.
*   **Then** o sistema cria o registro na tabela `public.base_conhecimento`.
*   **And** atualiza a data de criação e atualização.
*   **And** exibe uma notificação visual moderna de sucesso: "Artigo cadastrado com sucesso!".

### Cenário 8: Upload de documento PDF excedendo o limite de tamanho
*   **Given** que o administrador acessa o painel de upload da base de conhecimento.
*   **When** arrasta ou seleciona um arquivo de documento PDF com tamanho de 15MB.
*   **Then** o frontend valida o tamanho localmente e bloqueia o upload.
*   **And** exibe uma mensagem de alerta em vermelho: "O arquivo excede o limite máximo permitido de 10MB".

### Cenário 9: Upload e fragmentação automatizada de documento PDF válido
*   **Given** que existem 10 documentos ativos cadastrados no sistema (abaixo do limite de 50).
*   **When** o administrador carrega um arquivo PDF válido `'politicas_reservas.pdf'` com 2MB.
*   **Then** o arquivo é transmitido para o bucket de storage `'documentos-conhecimento'`.
*   **And** cria uma linha em `public.documentos_base_conhecimento` com os metadados do arquivo.
*   **And** o backend extrai o texto do arquivo, quebra o conteúdo em blocos menores que 4000 caracteres e cria registros correspondentes na tabela `public.base_conhecimento` com o `documento_id` correspondente.

### Cenário 10: Exclusão em cascata de documento e seus blocos RAG
*   **Given** que existe um documento `'regras.docx'` que gerou 5 blocos de artigos na base de conhecimento.
*   **When** o administrador acessa a lista de documentos e clica no botão "Excluir" correspondente a `'regras.docx'`.
*   **Then** o registro do documento é deletado de `public.documentos_base_conhecimento`.
*   **And** todos os 5 artigos de base de conhecimento que possuem o `documento_id` daquele arquivo são automaticamente apagados (`ON DELETE CASCADE`).
*   **And** o arquivo físico no bucket `'documentos-conhecimento'` é apagado do Supabase Storage.


## Requirements added by `humanized-multichannel-sofia-responses`

### Requirement: Durable multichannel Sofia batch scheduling

For Telegram, WhatsApp/Evolution, and Web customer messages, the system MUST use one durable, per-conversation Sofia batching contract. The database admission time of each accepted inbound message MUST be authoritative for batching; process-local timers MUST NOT be the source of truth. At most one mutable pending batch SHALL exist per conversation.

A pending batch MUST be due at `min(latest_inbound_at + 25 seconds, first_inbound_at + 60 seconds)`. Each eligible arrival before claim MUST update `latest_inbound_at` without changing `first_inbound_at`. Durable maintenance MUST discover due batches at least every 2 seconds while maintenance is available.

> **Corrected values.** The delivered window is a 25-second sliding silence under a 60-second starvation cap, restored by commit `15cdd6a` (`supabase/migrations/20260913010000_sofia_timing_and_pacing_correction.sql`). This delta previously stated 10 seconds / 20 seconds. Those values were never the shipped behaviour, so they are superseded here to keep the canonical spec of record aligned with the runtime and with `docs/runbooks/sofia-multichannel-status-and-handover.md`.

#### Scenario: Latest admitted arrival resets the silence window

- GIVEN a pending batch whose first message was admitted at T0
- WHEN another eligible message is admitted at T1 before the batch is claimed
- THEN the batch MUST retain T0 as its first inbound time
- AND the batch MUST be due at the earlier of T1 plus 25 seconds or T0 plus 60 seconds

#### Scenario: Continuous arrivals reach the first-message cap

- GIVEN eligible messages keep being admitted to one pending batch
- WHEN 25 seconds after the latest message would be later than 60 seconds after the first message
- THEN the batch MUST be due no later than 60 seconds after its first admitted message

#### Scenario: Maintenance discovers durable due work

- GIVEN a due pending batch is durable and maintenance is available
- WHEN a maintenance interval elapses
- THEN the system MUST inspect due work within 2 seconds of the preceding inspection
- AND discovery MUST NOT depend on an in-memory timer created by message intake

### Requirement: Claim-bound batch membership and ordered context

The system MUST atomically claim a due batch before generating a Sofia response. A message admitted after that claim MUST belong to a new pending batch and MUST NOT modify the claimed batch's membership, timestamps, or generated context. The claimed context MUST preserve admitted inbound chronological order for text and attachments, retaining every attachment with its originating message.

#### Scenario: Arrival after claim is isolated

- GIVEN a worker has safely claimed a conversation batch
- WHEN a later eligible customer message is admitted for that conversation
- THEN the new message MUST be assigned to a distinct pending batch
- AND the claimed response context MUST remain unchanged

#### Scenario: Context retains text and attachments in order

- GIVEN a claimed batch contains text, then an attachment-only message, then more text
- WHEN Sofia context is constructed
- THEN the context MUST represent those messages in admitted chronological order
- AND the attachment MUST remain associated with its chronological message

### Requirement: Policy-safe and crash-fenced response authority

Before generation and before acquiring final response-delivery authority, the system MUST re-evaluate existing applicable automation policy and conversation fencing, including opt-out, handoff or manual pause, cooldown or sleep, business-hours, channel-global availability, and `ia_ativa`. Ineligible work MUST be cancelled without Sofia generation or delivery.

The system MUST durably fence claims, terminal transitions, and response delivery so concurrent workers, retries, lease recovery, or a crash produce at most one Sofia response and at most one external response attempt for a batch. Provider-visible effects MUST NOT occur before durable delivery authority is acquired. A crash after authority is acquired MUST NOT cause response regeneration or an additional external attempt.

#### Scenario: Policy changes during the waiting window

- GIVEN a pending batch was eligible when its messages were admitted
- WHEN an applicable opt-out, handoff, pause, availability rule, or fence makes it ineligible before response authority
- THEN the system MUST cancel the batch
- AND the system MUST NOT generate or deliver a Sofia response

#### Scenario: Concurrent recovery preserves one response

- GIVEN a claimed batch is observed by concurrent workers or recovery after interruption
- WHEN they contend for processing or delivery
- THEN no more than one worker MUST obtain final response-delivery authority
- AND no more than one Sofia response or external response attempt MUST result

### Requirement: Humanized post-authority response pacing

After final response-delivery authority is acquired, the system MUST derive a minimum visible activity duration from the final response length and MUST clamp that duration inclusively between 2 and 6 seconds. Generation elapsed time MUST count toward this minimum. The system MUST delay only `max(0, computed_minimum - generation_elapsed)` and MUST NOT add an unconditional post-generation delay.

The applicable activity indicator MUST remain active continuously from generation start through any remaining delay and MUST clear on final delivery or every terminal processing outcome. Responses MUST be delivered as final messages; token streaming and partial-response delivery MUST NOT be introduced.

#### Scenario: Slow generation needs no extra delay

- GIVEN the response-length-derived minimum is 4 seconds
- AND generation takes 5 seconds
- WHEN final delivery is prepared
- THEN the system MUST apply zero additional pacing delay
- AND the activity indicator MUST clear when delivery reaches its terminal outcome

#### Scenario: Fast generation receives only the remainder

- GIVEN the response-length-derived minimum is 4 seconds
- AND generation takes 1 second
- WHEN final delivery is prepared
- THEN the system MUST keep the activity indicator active for exactly the remaining 3 seconds before final delivery
- AND the response MUST be delivered as one final message without token streaming

### Requirement: Default-closed multichannel adoption

The durable batching and humanized-response behavior MUST be default-closed independently for Telegram, WhatsApp/Evolution, and Web. Presence of durable state or processing capability MUST NOT activate a channel. When a channel is disabled, the system MUST NOT enqueue new work through this behavior for that channel.

Meta WhatsApp Cloud and streaming transport behavior MUST remain excluded from this change.

#### Scenario: Disabled channel does not adopt batching

- GIVEN the new batching behavior is disabled for Web
- WHEN a Web customer message is accepted
- THEN the system MUST NOT route that message through the new batching behavior
- AND the disabled state MUST NOT activate Meta WhatsApp Cloud or streaming behavior

## Requirements added by `sofia-customer-memory`

### Requirement: Per-customer facts block in Sofia prompt assembly

When the customer memory gate is enabled and the current customer has approved facts, the assembled
Sofia system prompt MUST include one per-customer facts block, sourced only from the approved-facts
prompt read surface of `memoria_cliente`, placed between the active-orders context
(`contextoPedidosAtivos`) and the conversation history (`HISTÓRICO DA CONVERSA`) in
`apps/web/src/lib/ai/openrouter.ts`.

The block MUST be rendered as clearly labeled customer-provided data. It MUST be bounded to at most
20 facts and at most 1200 characters of rendered fact content; the design intent is "roughly", and
these numbers are the normative upper bound. The block MUST NOT be presented as policy: global
`base_conhecimento` articles remain the only authority for policy, price, hours, and product facts,
and a conflict between a customer fact and a global article MUST resolve in favour of the global
article.

Pending, rejected, and superseded facts, and `tipo = 'observacao'` notes, MUST NOT appear in the
block.

#### Scenario: Approved fact reaches the prompt in the right position

- GIVEN the memory gate is enabled and the customer has an approved `endereco` fact
- WHEN the Sofia prompt is assembled
- THEN the facts block MUST appear after the active-orders context and before the conversation
  history
- AND it MUST contain the approved fact

#### Scenario: Unapproved facts never reach the model

- GIVEN a customer with one pending, one rejected, and one superseded fact
- WHEN the Sofia prompt is assembled
- THEN none of those facts MUST appear in the prompt

#### Scenario: Internal notes never reach the model

- GIVEN an approved fact with `tipo = 'observacao'`
- WHEN the Sofia prompt is assembled
- THEN it MUST NOT appear in the prompt

#### Scenario: Customer facts stay subordinate to global knowledge

- GIVEN an approved customer fact that conflicts with an article of `public.base_conhecimento`
- WHEN the prompt is assembled and rendered
- THEN the customer fact MUST be labeled as customer-provided context
- AND the block MUST NOT be placed in, or represented as, the global knowledge section

#### Scenario: The block is capped

- GIVEN a customer with more than 20 approved facts whose rendered text exceeds 1200 characters
- WHEN the prompt is assembled
- THEN the block MUST contain no more than 20 facts and no more than 1200 characters of rendered
  fact content

#### Scenario: Closed gate leaves prompt assembly unchanged

- GIVEN `SOFIA_CUSTOMER_MEMORY_ENABLED` is not exactly `"true"`
- WHEN the Sofia prompt is assembled
- THEN no facts block MUST be added
- AND no fact MUST be read for prompt assembly
- AND no additional model call MUST be made
