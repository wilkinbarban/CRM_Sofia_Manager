# Especificação Formal: Épica 6 — CRM, Vendas, Pedidos e Google Calendar

Este documento define as especificações de negócio, comportamento do sistema e requisitos técnicos para a Épica 6 (Módulo `crm_vendas`).

## 1. Visão Geral

Esta épica introduz a gestão de catálogo de produtos, o enriquecimento de dados de clientes no chat de atendimento, a facilidade de criação rápida de pedidos diretamente pelo operador e a integração com o Google Calendar para agendamento automático de entregas/retiradas de forma resiliente.

---

## 2. Requisitos de Negócio e Funcionais

### 2.1. Catálogo de Produtos e CRUD Administrativo

#### 2.1.1. Modelo de Dados (`public.produtos`)
O sistema MUST persistir os produtos na tabela `public.produtos`. O esquema da tabela SHALL ser definido com as seguintes colunas:
*   `id`: `UUID` (PRIMARY KEY, default `gen_random_uuid()`)
*   `nome`: `VARCHAR(255)` (NOT NULL) — Nome de exibição do produto.
*   `descricao`: `TEXT` (NULLABLE) — Descrição detalhada do produto.
*   `preco_centavos`: `INTEGER` (NOT NULL, positivo) — Preço unitário em centavos (ex: R$ 45,00 é guardado como `4500`).
*   `ativo`: `BOOLEAN` (NOT NULL, default `true`) — Define se o produto está visível para vendas e no catálogo.
*   `url_imagem`: `TEXT` (NULLABLE) — Link ou caminho para a imagem do produto.
*   `data_criacao`: `TIMESTAMPTZ` (NOT NULL, default `now()`)
*   `data_atualizacao`: `TIMESTAMPTZ` (NOT NULL, default `now()`)

#### 2.1.2. Painel de Gerenciamento CRUD
*   O sistema SHALL expor uma tela de gerenciamento de produtos no caminho `/atendimento/produtos` acessível apenas por usuários com a role de Admin ou Supervisor.
*   A tela MUST permitir:
    *   Listar todos os produtos com suporte a busca textual por `nome` e filtro por status `ativo`.
    *   Criar um novo produto informando `nome`, `descricao`, `preco_centavos` (ou valor formatado em R$), `ativo` e `url_imagem`.
    *   Editar os dados de um produto existente.
    *   Desativar um produto (definindo `ativo = false`), mas não sua exclusão física, para garantir a integridade referencial com pedidos passados.

---

### 2.2. Painel Lateral de Detalhes do Cliente (Chat Workspace)

No workspace de chat em `/atendimento`, ao selecionar uma conversa ativa com um cliente:
*   O sistema SHALL renderizar um painel lateral direito dedicado aos detalhes do perfil do cliente selecionado.
*   O painel MUST ler e permitir a edição em tempo real das seguintes informações do cliente:
    *   `endereco`: Campo de texto completo para entrega.
    *   `tags`: Lista dinâmica de etiquetas textuais (array de strings) para segmentação rápida (ex: "VIP", "Curitiba-Centro", "Reclamão").
    *   `notas`: Área de texto (textarea) para anotações internas dos operadores sobre o histórico ou preferências do cliente.
*   Toda atualização realizada neste painel MUST ser salva imediatamente de forma assíncrona (via Server Action ou chamada de API) no banco de dados.

---

### 2.3. Formulário de Criação Rápida de Pedidos

*   O operador SHALL poder abrir um modal de "Criar Pedido" diretamente a partir do console de chat ativo em `/atendimento`.
*   O formulário de criação rápida de pedido MUST conter os seguintes campos:
    *   **Seleção de Itens**: Multi-seleção de produtos ativos da tabela `public.produtos`, com definição de quantidade para cada um.
    *   **Tipo de Entrega**: Seleção exclusiva entre `retirada` ou `entrega`.
    *   **Taxa de Entrega**: Campo editável `taxa_entrega_centavos`, inicializado com o padrão da região ou zero, permitindo alteração manual pelo operador.
    *   **Endereço de Entrega**: Campo de texto pré-preenchido com o endereço cadastrado do cliente, mas editável para aquele pedido específico.
    *   **Meio de Pagamento**: Seleção do método de pagamento (ex: `pix`, `cartao_credito`, `cartao_debito`, `dinheiro`).
*   **Cálculo Automático**:
    *   O sistema MUST calcular em tempo real o subtotal dos produtos: `total_produtos_centavos = soma(preco_centavos * quantidade)`.
    *   O sistema MUST calcular o total do pedido: `total_pedido_centavos = total_produtos_centavos + taxa_entrega_centavos`.
*   **Persistência**:
    *   Ao submeter, o sistema MUST criar um registro na tabela `public.pedidos` com:
        *   `status`: `'novo'`
        *   `status_pagamento`: `'pendente'`
        *   `meio_pagamento`: O selecionado pelo operador.
        *   `total_produtos_centavos` e `total_pedido_centavos` conforme calculados.

---

### 2.4. Integração com Google Calendar e Resiliência

*   Quando o status de um pedido transicionar para `'confirmado'` (via Server Action ou trigger equivalente de atualização de status):
    *   O sistema MUST disparar uma integração com o Google Calendar da Churrascaria.
    *   A autenticação com a API do Google Calendar SHALL utilizar credenciais de Service Account configuradas no servidor através das variáveis de ambiente:
        *   `GOOGLE_CALENDAR_ID`
        *   `GOOGLE_CLIENT_EMAIL`
        *   `GOOGLE_PRIVATE_KEY`
    *   O evento inserido no calendário MUST conter na descrição as seguintes informações textuais estruturadas:
        *   Itens do pedido (produto e quantidade).
        *   Nome do cliente.
        *   Telefone de contato do cliente.
        *   Tipo de entrega (entrega ou retirada).
        *   Endereço de entrega (se aplicável).
        *   Valor total do pedido formatado em R$.
*   **Resiliência a Falhas (CRITICAL)**:
    *   Se a chamada à API do Google Calendar falhar (devido a problemas de rede, credenciais inválidas ou limite de requisições excedido), ou se as variáveis de ambiente não estiverem configuradas:
        *   A transição de status do pedido para `'confirmado'` MUST ser concluída com sucesso no banco de dados.
        *   A transação do banco de dados não SHALL ser abortada ou revertida em decorrência de falhas no calendário.
        *   O registro do pedido correspondente SHALL gravar a coluna `google_event_id` como `NULL` (podendo ser marcado para sincronização em segundo plano/re-tentativa futura).
    *   Em caso de sucesso na API do Google Calendar, o ID retornado pelo Google MUST ser salvo na coluna `google_event_id` do registro do pedido.

---

## 3. Cenários de Aceitação (Dado / Quando / Então)

### 3.1. CRUD de Produtos

#### Cenário 1: Criação de um produto válido por operador autorizado
*   **Dado** que o usuário está autenticado com a role de Admin ou Supervisor,
*   **E** está na página `/atendimento/produtos`,
*   **Quando** ele preenche o formulário informando Nome: "Costela Premium 1kg", Preço: "R$ 89,90" (representado internamente como `8990`), Descrição: "Costela assada lentamente no bafo por 12 horas", Ativo: `true`,
*   **E** clica em "Salvar",
*   **Então** o sistema deve persistir o produto no banco com `preco_centavos = 8990` e `ativo = true`,
*   **E** deve exibir uma mensagem de sucesso,
*   **E** o novo produto deve aparecer na listagem de produtos.

#### Cenário 2: Tentativa de criação de produto por usuário comum (Operador comum ou Cliente)
*   **Dado** que o usuário está autenticado com a role de Operador comum ou está desautenticado,
*   **Quando** ele tenta acessar ou fazer uma requisição POST para `/atendimento/produtos`,
*   **Então** o sistema deve retornar um erro de permissão (403 Forbidden ou 401 Unauthorized),
*   **E** não deve permitir a visualização ou modificação do catálogo de produtos.

---

### 3.2. Painel Lateral de Detalhes do Cliente

#### Cenário 1: Atualização de notas e tags do cliente no chat
*   **Dado** que o operador está com o chat do cliente "João Silva" aberto em `/atendimento`,
*   **E** o painel lateral de detalhes exibe as notas atuais como vazias e nenhuma tag,
*   **Quando** o operador digita no campo de notas "Cliente prefere carne mal passada" e adiciona as tags "VIP" e "Curitiba-Centro",
*   **E** salva as alterações (ou o sistema salva automaticamente após debouncing),
*   **Então** os dados devem ser atualizados imediatamente na tabela de clientes do banco de dados,
*   **E** o painel lateral deve refletir as informações salvas de maneira persistente na próxima seleção do chat do João Silva.

---

### 3.3. Criação Rápida de Pedidos

#### Cenário 1: Criação de pedido com sucesso a partir do chat
*   **Dado** que o operador está atendendo o cliente "Maria Oliveira" no workspace `/atendimento`,
*   **Quando** ele abre o modal "Criar Pedido",
*   **E** seleciona 2x "Costela Premium 1kg" (Preço: R$ 89,90/cada) e 1x "Maionese Artesanal" (Preço: R$ 15,00/cada),
*   **E** define o tipo de entrega como "entrega" com taxa de "R$ 10,00" (representada como `1000`),
*   **E** escolhe o meio de pagamento "pix",
*   **Então** o sistema deve exibir em tempo real no modal:
    *   Subtotal de produtos: `R$ 194,80` (representado como `19480`),
    *   Total do pedido: `R$ 204,80` (representado como `20480`),
*   **Quando** o operador confirma o envio do formulário,
*   **Então** o sistema deve criar um pedido na tabela `public.pedidos` associado ao cliente "Maria Oliveira" com status `novo`, status_pagamento `pendente`, meio_pagamento `pix`, `total_produtos_centavos = 19480` e `total_pedido_centavos = 20480`.

---

### 3.4. Integração com Google Calendar e Resiliência

#### Cenário 1: Confirmação de pedido com sucesso na API do Google Calendar
*   **Dado** um pedido existente na tabela `public.pedidos` pertencente ao cliente "Maria Oliveira" com status `novo`,
*   **E** a integração com o Google Calendar está devidamente configurada no servidor,
*   **Quando** o status do pedido é alterado para `confirmado`,
*   **Então** o sistema deve acionar a integração do Google Calendar informando os dados formatados do pedido,
*   **E** após a API retornar sucesso com um ID de evento (ex: `cal_event_12345`),
*   **Então** o sistema deve atualizar o registro do pedido no banco de dados gravando `google_event_id = 'cal_event_12345'`.

#### Cenário 2: Falha ou ausência de configuração da API do Google Calendar na confirmação de pedido
*   **Dado** um pedido existente na tabela `public.pedidos` com status `novo`,
*   **E** a integração com o Google Calendar está inacessível ou não configurada (ex: sem chaves no `.env`),
*   **Quando** o status do pedido é alterado para `confirmado`,
*   **Então** o sistema deve tentar a integração e capturar graciosamente qualquer erro ocorrido,
*   **E** deve concluir a alteração do status do pedido no banco de dados para `confirmado` com sucesso absoluto,
*   **E** deve salvar o campo `google_event_id` como `NULL`, sem disparar exceções para o operador ou interromper a Server Action de confirmação.

---

## 5. Requisitos Não-Funcionais e Restrições do Projeto

1.  **Segurança (RLS e Roles)**:
    *   A tabela `public.produtos` deve possuir políticas de Row Level Security (RLS) que permitam a leitura pública por qualquer usuário autenticado ou anônimo, mas inserção/atualização restrita apenas a usuários com roles de `admin` ou `supervisor`.
2.  **Validações e Tipagem**:
    *   Valores monetários MUST ser mantidos estritamente como inteiros representativos de centavos no banco de dados e nos cálculos do backend.
    *   O tratamento do fuso horário nas operações de agendamento do Google Calendar MUST respeitar o fuso local configurado (America/Sao_Paulo).
3.  **Localização**:
    *   Todas as tabelas, colunas, enums e strings de interface expostas aos operadores MUST ser em Português do Brasil (pt-BR).

## Requirements added by `sofia-customer-memory`

### Requirement: Operator fact review surface for the selected customer

The operator chat workspace MUST offer a customer facts review surface for the selected customer,
alongside the existing client details panel. The surface MUST list facts in every state (`pendente`,
`aprovado`, `rejeitado`, `substituido`) with their `tipo`, `chave`, `valor`, `origem`, `confianca`,
and originating conversation, and MUST let the operator approve, reject, or correct a fact.
Rejection and supersession MUST keep the row as history.

Access MUST follow the existing operator authorization (`verificarOperadorAutorizado()`) and the
`atualizarClienteCrm` / `ClientCrmPanel.tsx` pattern. All reads and writes MUST go through the
`memoria_cliente` function surface; the surface MUST NOT read `public.fatos_cliente` directly. The
existing `endereco`, `tags`, and `notas` editing MUST keep its current behaviour and MUST NOT be
replaced by the facts surface.

#### Scenario: Vendor reviews a pending inference

- GIVEN an operator authorized to use the workspace and a customer with a pending inferred fact
- WHEN the operator opens the facts review surface
- THEN the pending fact MUST be listed with `origem = 'ia'` and its confidence
- AND the operator MUST be able to approve or reject it

#### Scenario: Approval is attributed to the operator

- GIVEN a pending fact under review
- WHEN the operator approves it
- THEN the stored fact MUST become `estado = 'aprovado'` with `revisado_por` and `revisado_em`
  recorded
- AND it MUST be readable by the approved-facts prompt surface

#### Scenario: Correction stays explainable by the human gate

- GIVEN a pending inferred fact
- WHEN the operator corrects its value and approves it
- THEN the stored fact MUST remain explainable as human-reviewed through `revisado_por`
- AND the corrected value MUST be the value read by the prompt surface

#### Scenario: Unauthorized caller is blocked

- GIVEN an authenticated caller without operator authorization
- WHEN the caller requests the surface or invokes its review path
- THEN access MUST be denied and no customer fact MUST be disclosed

#### Scenario: Existing client details behaviour is preserved

- GIVEN an operator with a customer selected in the workspace
- WHEN the facts review surface is added
- THEN editing and saving `endereco`, `tags`, and `notas` MUST keep working exactly as before
