# Especificação de Requisitos: Dashboard Administrativo, Gestão de Operadores e Auditoria (dashboard_admin)

**ID da Mudança:** `epica8-dashboard-admin`  
**Domínio:** `dashboard_admin`  
**Status:** `Em Revisão`  

---

## 1. Descrição Executiva
Este documento especifica os requisitos de negócio e técnicos para o Painel Administrativo do portal da churrascaria **Asados**. O módulo centraliza a gestão de permissões e do status de ativação dos usuários do sistema, o teste de integração do Google Calendar, a exibição de métricas comparativas de atendimento (Humano vs. Inteligência Artificial), a auditoria de ações críticas por meio de logs imutáveis e a visualização do Master Prompt da assistente virtual Sofía.

---

## 2. Requisitos de Negócio e de Sistema (RFC 2119)

### 2.1 Workspace Administrativo e Controle de Acesso (`/atendimento/admin`)
*   **REQ-ADM-001**: O painel administrativo MUST ser disponibilizado sob a rota `/atendimento/admin`.
*   **REQ-ADM-002**: A rota `/atendimento/admin` e suas sub-rotas MUST ser restritas exclusivamente a usuários autenticados cujos perfis possuam a função (`funcao`) de `'admin'` ou `'supervisor'` na tabela `public.perfis`.
*   **REQ-ADM-003**: Qualquer tentativa de acesso à rota `/atendimento/admin` por um usuário com papel `'vendedor'`, `'cliente'` ou por um usuário não autenticado MUST ser bloqueada pelo Next.js Middleware, redirecionando o usuário para a rota `/403` (Acesso Negado) ou `/login`, respectivamente.
*   **REQ-ADM-004**: O acesso ao painel administrativo MUST ser negado imediatamente caso a flag `ativo` do perfil do operador no banco de dados esteja configurada como `false`, mesmo que ele possua as funções de `'admin'` ou `'supervisor'`.

### 2.2 Painel de Gestão de Usuários e Operadores
*   **REQ-ADM-005**: O sistema MUST exibir uma listagem de todos os usuários do sistema vinculados à tabela `public.perfis`, exibindo colunas de `Nome`, `Função`, `Status (Ativo/Inativo)` e a data de criação.
*   **REQ-ADM-006**: O e-mail do usuário cadastrado na tabela de autenticação `auth.users` SHOULD ser exibido de forma segura na listagem, obtido através de uma consulta ou função de backend segura (Server Action ou RPC) com privilégios de administrador.
*   **REQ-ADM-007**: Um operador com papel `'admin'` ou `'supervisor'` MUST poder alterar a função (`funcao`) de qualquer usuário para `'admin'`, `'supervisor'`, `'vendedor'` ou `'cliente'`.
*   **REQ-ADM-008**: Um operador com papel `'admin'` ou `'supervisor'` MUST poder habilitar ou desabilitar o acesso de um usuário alterando a coluna `ativo` na tabela `public.perfis` para `true` ou `false`.
*   **REQ-ADM-009**: O sistema MUST impedir que o operador autenticado desative o seu próprio perfil (auto-desativação) ou altere a sua própria função, prevenindo perda acidental de acesso administrativo (lockout).
*   **REQ-ADM-010**: O sistema MUST validar que exista pelo menos um perfil de usuário ativo com a função `'admin'` no banco de dados antes de permitir qualquer desativação ou alteração de cargo que reduza o número de administradores ativos a zero.

### 2.3 Integração com Google Calendar e Painel de Testes
*   **REQ-ADM-011**: O painel administrativo MUST expor uma área de visualização do status das credenciais da integração com o Google Calendar.
*   **REQ-ADM-012**: O status da configuração das chaves de ambiente `GOOGLE_CALENDAR_ID`, `GOOGLE_CLIENT_EMAIL` e `GOOGLE_PRIVATE_KEY` MUST ser exibido de forma mascarada (ex: exibindo apenas se a variável está "Configurada" ou "Não Configurada"), e as chaves privadas nunca SHALL ser enviadas ao navegador do cliente ou expostas na UI.
*   **REQ-ADM-013**: O sistema MUST disponibilizar um botão de ação com o rótulo "Testar Calendário" para administradores e supervisores.
*   **REQ-ADM-014**: Ao acionar "Testar Calendário", o sistema MUST invocar uma Server Action que dispara o envio de um evento de teste de curta duração (ex: 15 minutos) para a conta do calendário configurado.
*   **REQ-ADM-015**: O evento de teste enviado ao Google Calendar MUST conter no título a indicação explícita de teste (ex: `"[TESTE] Conexão Asados - [Timestamp]"`) e uma descrição genérica que não inclua dados pessoais de clientes reais.
*   **REQ-ADM-016**: A Server Action de teste MUST retornar um status de sucesso ou uma mensagem de erro detalhada e amigável à interface do usuário. A ação e seu resultado final MUST ser registrados na tabela de logs de auditoria.

### 2.4 Registros de Auditoria e Estatísticas de Uso da IA
*   **REQ-ADM-017**: Todas as ações administrativas críticas listadas abaixo MUST ser registradas de forma indelével na tabela `public.logs_auditoria`:
    *   Alteração do status de ativação (`ativo`) de um usuário.
    *   Alteração da função (`funcao`) de um usuário.
    *   Execução do teste de integração com o Google Calendar.
*   **REQ-ADM-018**: A tabela `public.logs_auditoria` MUST possuir as seguintes colunas e tipos:
    *   `id`: `UUID` (PRIMARY KEY, default `gen_random_uuid()`)
    *   `usuario_id`: `UUID` (REFERENCES `public.perfis(id)` ON DELETE SET NULL) — ID do administrador/supervisor que realizou a ação.
    *   `acao`: `VARCHAR(100)` (NOT NULL) — O identificador técnico da ação realizada (ex: `'alteracao_status_usuario'`, `'alteracao_funcao_usuario'`, `'teste_conexao_calendario'`).
    *   `detalhes`: `JSONB` (NOT NULL) — Contém os detalhes da ação (ex: `{ "usuario_alvo_id": "UUID", "valor_anterior": "admin", "valor_novo": "supervisor" }`).
    *   `data_criacao`: `TIMESTAMPTZ` (NOT NULL, default `now()`).
*   **REQ-ADM-019**: As políticas RLS para a tabela `public.logs_auditoria` MUST permitir leitura (`SELECT`) apenas para usuários ativos com papéis `'admin'` e `'supervisor'`.
*   **REQ-ADM-020**: O sistema SHALL NOT permitir operações de atualização (`UPDATE`) ou deleção (`DELETE`) de registros na tabela `public.logs_auditoria` sob nenhuma circunstância para garantir a integridade da trilha de auditoria (Logs Imutáveis).
*   **REQ-ADM-021**: Para conformidade com a LGPD, os logs de auditoria de console do servidor e do banco de dados SHALL NOT conter dados pessoais brutos (PII) dos clientes, como números de telefone não mascarados, e-mails ou nomes completos nos payloads de detalhes técnicos.
*   **REQ-ADM-022**: O painel administrativo MUST apresentar um dashboard de estatísticas de conversas, compilando a quantidade agregada de mensagens por tipo de remetente (coluna `remetente` na tabela `public.mensagens` com valores `'cliente'`, `'operador'` e `'ia'`).
*   **REQ-ADM-023**: O dashboard estatístico MUST calcular e apresentar de forma clara a proporção (taxa/razão) de mensagens respondidas de forma automática pela IA Sofía contra as intervenções humanas dos operadores.

### 2.5 Visualizador do Master Prompt da IA
*   **REQ-ADM-024**: O painel administrativo MUST expor uma área contendo o texto e diretrizes do Master System Prompt do assistente virtual Sofía (utilizado para interagir com a API de LLM via DeepSeek).
*   **REQ-ADM-025**: A área de visualização do Master Prompt MUST ser puramente de leitura (`read-only`), servindo estritamente para auditoria visual da persona e diretrizes de comportamento do robô. A edição do prompt via interface administrativa SHALL ser proibida neste release para evitar descalibração acidental do pipeline RAG.

### 2.6 Exclusão de Usuários e Clientes (deletarUsuarioAdmin)
*   **REQ-ADM-026**: A Server Action `deletarUsuarioAdmin` MUST permitir que administradores excluam usuários e clientes do sistema de forma limpa e completa.
*   **REQ-ADM-027**: O sistema MUST impedir que o operador exclua o último perfil de administrador ativo do banco de dados para evitar lockout acidental.
*   **REQ-ADM-028**: A Server Action MUST ser executada sob um contexto seguro utilizando o cliente Supabase com a role de serviço (`service_role`), bypassando as políticas de RLS normais da tabela `public.perfis` e `auth.users`.
*   **REQ-ADM-029**: A operação MUST realizar a deleção em cascata (cascading deletes) em todas as tabelas associadas ao cliente, incluindo pedidos (`public.pedidos` e seus respectivos itens de pedido em `public.itens_pedido`), mensagens (`public.mensagens`), conversas (`public.conversas`) e, por fim, remover o usuário de autenticação correspondente no Supabase Auth (`auth.users`).

### 2.7 Encerramento de Sessão (Logout)
*   **REQ-ADM-030**: A interface do painel do Dashboard Administrativo `/atendimento/admin` MUST exibir um botão visível para encerramento de sessão (logout).
*   **REQ-ADM-031**: O botão de logout MUST realizar o sign out completo do usuário atual utilizando a biblioteca de cliente do Supabase (`supabase.auth.signOut()`).
*   **REQ-ADM-032**: O sistema MUST assegurar que os cookies de sessão e dados de autenticação armazenados localmente sejam apagados do navegador.
*   **REQ-ADM-033**: Após o logout, o sistema MUST redirecionar automaticamente o usuário para a página de login em `/login`.

### 2.8 Gerenciamento Dinâmico de API Keys
*   **REQ-ADM-034**: Administradores MUST poder visualizar, editar e salvar chaves de API (Meta WhatsApp Cloud API e LLM/DeepSeek) dinamicamente pelo dashboard.
*   **REQ-ADM-035**: As configurações de chaves de API e tokens MUST ser salvas na tabela de configurações do sistema (ex: `public.configuracoes_sistema`).
*   **REQ-ADM-036**: O sistema MUST ler essas chaves em tempo de execução utilizando uma função utilitária com fallback automático para as variáveis de ambiente (`.env`) no servidor caso o registro no banco não esteja presente.
*   **REQ-ADM-037**: Para segurança, as chaves sensíveis (segredos/tokens) MUST ser exibidas de forma mascarada (ex: exibindo apenas caracteres iniciais e asteriscos) na interface do usuário e nunca SHALL ser impressas em texto claro nos logs de auditoria.

### 2.9 Incorporação da Base de Conhecimento no Dashboard
*   **REQ-ADM-038**: O painel administrativo em `/atendimento/admin` MUST integrar uma aba dedicada à gestão de artigos da Base de Conhecimento (`KnowledgeCRUD`).
*   **REQ-ADM-039**: A nova aba "Base de Conhecimento" MUST carregar e renderizar o componente de CRUD completo de artigos (previamente standalone).
*   **REQ-ADM-040**: O sistema MUST carregar dinamicamente os artigos da tabela `public.artigos_conhecimento` no carregamento inicial da página e repassar ao componente para visualização.
*   **REQ-ADM-041**: A interface incorporada MUST permitir a realização de todas as operações de criação, leitura, atualização e exclusão (CRUD) de artigos diretamente de dentro do Dashboard Administrativo.

### 2.10 Painel de Integrações Modular
*   **REQ-ADM-042**: A aba de Integrações no painel administrativo MUST ser reestruturada de um formulário monolítico para 5 cartões de gerenciamento independentes localizados em `src/components/operator/integrations/`:
    *   `LlmApiCard.tsx` (Gestão LLM API - Modelo da Sofía)
    *   `MetaWhatsAppCard.tsx` (Gestão WhatsApp API - Meta Cloud)
    *   `EvolutionApiCard.tsx` (Gestão WhatsApp QR - Evolution API)
    *   `GoogleCalendarCard.tsx` (Gestão Google Calendar API - Apenas leitura)
    *   `MercadoPagoCard.tsx` (Gestão Mercado Pago API)
    *   E o arquivo `index.ts` para exportações (barrel exports).
*   **REQ-ADM-043**: Cada componente de cartão MUST seguir a mesma interface padrão: receber `configInicial` (`Record<string, string>`) e `onToastMessage` (`(tipo: 'success' | 'error', msg: string) => void`), gerenciando seu próprio estado local de carregamento, validação e formulário.
*   **REQ-ADM-044**: Cada cartão MUST funcionar de forma independente, de modo que a edição ou salvamento em um cartão não afete nem submeta o estado dos outros.
*   **REQ-ADM-045**: O cartão de LLM API MUST gerenciar `DEEPSEEK_API_KEY` (campo tipo password) e `DEEPSEEK_MODEL` (select dropdown), oferecendo ações de Testar Conexão (`testAuthorizedDeepSeekModel`), Sincronizar Modelos (`listAuthorizedDeepSeekModels`) e Salvar LLM (`salvarConfiguracaoAdmin`). A lista de modelos MUST vir exclusivamente da ação de servidor autorizada, sem catálogo embutido no cliente: quando nenhum modelo autorizado for retornado para a chave configurada, o dropdown MUST exibir a opção "Nenhum modelo disponível" em vez de modelos padrão.
*   **REQ-ADM-046**: O cartão de WhatsApp API (Meta Cloud) MUST gerenciar as chaves `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_APP_SECRET` e `WHATSAPP_VERIFY_TOKEN`, com ações para Testar Conexão Meta e Salvar.
*   **REQ-ADM-047**: O cartão de WhatsApp QR (Evolution API) MUST gerenciar `EVOLUTION_API_URL`, `EVOLUTION_API_KEY` e `EVOLUTION_INSTANCE_NAME`, exibindo uma área de QR Code base64 obtida de `obterQrCodeEvolution` quando não conectado, e suportando o botão "Atualizar QR Code".
*   **REQ-ADM-048**: O cartão de Evolution API MUST conter o seletor `WHATSAPP_PROVIDER` (provedor ativo de WhatsApp) na parte inferior, representado como um interruptor/toggle com opções "Meta Cloud API" (`meta`) e "Evolution API" (`evolution`). A alteração do switch MUST exibir um aviso de confirmação e persistir imediatamente no banco de dados.
*   **REQ-ADM-049**: O cartão do Google Calendar MUST ser mantido em modo leitura, exibindo `GOOGLE_CALENDAR_ID` e `GOOGLE_CLIENT_EMAIL` mascarados, com o status de `GOOGLE_PRIVATE_KEY` (configurado/não configurado) e ação de Testar Conexão, sem botão de Salvar.
*   **REQ-ADM-050**: O cartão do Mercado Pago MUST gerenciar `MERCADO_PAGO_ACCESS_TOKEN` e `MERCADO_PAGO_PUBLIC_KEY`, contendo ação de testar conexão via endpoint `GET https://api.mercadopago.com/v1/payment_methods`.

### 2.11 Grade Responsiva no Dashboard de Integrações
*   **REQ-DSH-001**: O contêiner de exibição de cards na aba "Integrações" do painel `AdminDashboard` MUST ser alterado para renderizar em formato de grade responsiva.
*   **REQ-DSH-002**: Em resoluções móveis e tablets (telas pequenas e médias), a grade MUST exibir os cards em uma única coluna (`grid-cols-1`).
*   **REQ-DSH-003**: Em resoluções grandes (desktops e notebooks), a grade MUST exibir os cards em duas colunas (`lg:grid-cols-2`).
*   **REQ-DSH-004**: O espaçamento entre os cards na grade MUST utilizar a classe de utilidade de espaçamento padrão (`gap-6`).

### 2.12 Editor de Prompt do Sistema Mestre
*   **REQ-PRM-001**: O sistema de RAG Sofía MUST parar de carregar a Persona da IA e as instruções operacionais de arquivos estáticos ou variáveis de ambiente locais.
*   **REQ-PRM-002**: O pipeline de RAG MUST carregar o system prompt a ser enviado na requisição da DeepSeek a partir do valor registrado na tabela `public.configuracoes_sistema` sob a chave `'SOFIA_SYSTEM_PROMPT'`.
*   **REQ-PRM-003**: A aba "Prompt da IA" do painel `AdminDashboard` MUST exibir um editor de texto interativo (textarea) com a carga inicial de `'SOFIA_SYSTEM_PROMPT'`.
*   **REQ-PRM-004**: Ao clicar em "Salvar", o sistema MUST realizar uma operação de `upsert` na tabela `public.configuracoes_sistema` gravando o novo texto sob a chave `'SOFIA_SYSTEM_PROMPT'` com `eh_segredo = FALSE`.
*   **REQ-PRM-005**: A ação de salvar o Prompt do Sistema mestre MUST disparar a inclusão de um log de auditoria na tabela `public.logs_auditoria` identificando a ação `'atualizar_prompt_sistema'` e registrando o ID do operador.



---

## 3. Cenários de Aceitação (Gherkin - Given/When/Then)

### 3.1. Controle de Acesso ao Painel

#### Cenário 1: Acesso de Administrador ao Painel
*   **Given** que o usuário "admin.pedro@gmail.com" está autenticado,
*   **And** seu perfil na tabela `perfis` possui `funcao = 'admin'` e `ativo = true`,
*   **When** ele navega até a URL `/atendimento/admin`,
*   **Then** o Next.js Middleware permite o carregamento da página,
*   **And** a interface do Painel Administrativo é exibida com todas as opções de gerenciamento.

#### Cenário 2: Acesso de Supervisor ao Painel
*   **Given** que o usuário "supervisor.ana@gmail.com" está autenticado,
*   **And** seu perfil na tabela `perfis` possui `funcao = 'supervisor'` e `ativo = true`,
*   **When** ele navega até a URL `/atendimento/admin`,
*   **Then** o Next.js Middleware permite o carregamento da página,
*   **And** o painel é carregado com sucesso.

#### Cenário 3: Tentativa de Acesso por Vendedor (Acesso Negado)
*   **Given** que o usuário "vendedor.carlos@gmail.com" está autenticado,
*   **And** seu perfil na tabela `perfis` possui `funcao = 'vendedor'` e `ativo = true`,
*   **When** ele tenta acessar a URL `/atendimento/admin`,
*   **Then** o Next.js Middleware intercepta a requisição,
*   **And** redireciona o usuário para a página de erro de permissão `/403`,
*   **And** nenhuma informação administrativa é exposta.

#### Cenário 4: Tentativa de Acesso por Cliente Comum
*   **Given** que o usuário "cliente.maria@gmail.com" está autenticado com papel `funcao = 'cliente'`,
*   **When** ele tenta navegar diretamente para `/atendimento/admin`,
*   **Then** o Next.js Middleware intercepta o acesso e redireciona para a página `/403`.

#### Cenário 5: Operador Administrativo com Perfil Inativo
*   **Given** que o usuário "admin.desativado@gmail.com" possui papel `funcao = 'admin'`,
*   **And** o seu perfil na tabela `perfis` está marcado como `ativo = false`,
*   **When** ele tenta acessar a rota `/atendimento/admin` ou fazer login no sistema,
*   **Then** o sistema recusa a autenticação ou bloqueia a rota,
*   **And** redireciona o usuário para a tela de login com o parâmetro de erro de inatividade `?erro=inativo`.

---

### 3.2. Painel de Gestão de Usuários e Operadores

#### Cenário 1: Toggle do Status de Ativação do Usuário por Administrador
*   **Given** que o administrador "admin.pedro@gmail.com" está logado e na tela de Gestão de Usuários em `/atendimento/admin`,
*   **And** visualiza o usuário "vendedor.carlos@gmail.com" com status `ativo = true`,
*   **When** ele clica no controle (switch/botão) para desativar o usuário,
*   **Then** o sistema invoca a Server Action de alteração de status,
*   **And** atualiza a linha correspondente de "vendedor.carlos" na tabela `public.perfis` configurando `ativo = false`,
*   **And** insere um novo registro na tabela `public.logs_auditoria` com `usuario_id` do Pedro, `acao = 'alteracao_status_usuario'` e detalhes contendo o ID do Carlos e `valor_novo = false`,
*   **And** atualiza a listagem na tela exibindo o status do usuário como "Inativo".

#### Cenário 2: Prevenção de Auto-desativação do Administrador Logado
*   **Given** que o administrador "admin.pedro@gmail.com" está logado em `/atendimento/admin`,
*   **When** ele visualiza seu próprio perfil na lista de gestão de operadores,
*   **Then** o botão/controle de alteração de status "Ativo" de seu próprio perfil MUST estar desabilitado (disabled),
*   **And** se ele submeter manualmente uma requisição de desativação para o seu ID, a Server Action MUST rejeitar a requisição com erro de validação.

#### Cenário 3: Alteração da Função (Role) de um Operador
*   **Given** que o supervisor "supervisor.ana@gmail.com" está logado no painel administrativo,
*   **And** localiza o perfil de "vendedor.carlos@gmail.com" com `funcao = 'vendedor'`,
*   **When** ele seleciona a nova função `'supervisor'` no menu de seleção e confirma,
*   **Then** o sistema atualiza a coluna `funcao` na tabela `public.perfis` para `'supervisor'`,
*   **And** gera o respectivo log na tabela `public.logs_auditoria` registrando a ação de alteração de cargo.

---

### 3.3. Teste do Google Calendar

#### Cenário 1: Teste de Conexão com Sucesso
*   **Given** que o administrador está no painel de Integrações em `/atendimento/admin`,
*   **And** as variáveis de ambiente da Service Account do Google Calendar estão configuradas corretamente no servidor,
*   **When** ele clica no botão "Testar Calendário",
*   **Then** o sistema executa a Server Action de teste,
*   **And** envia um evento temporário com título `"[TESTE] Conexão Asados"` para o Google Calendar,
*   **And** ao receber a resposta de sucesso da API do Google, exibe um alerta de sucesso na UI: "Integração validada com sucesso! Evento de teste criado.",
*   **And** insere um registro na tabela `public.logs_auditoria` documentando a realização do teste com status de sucesso.

#### Cenário 2: Teste de Conexão com Erro de Credenciais
*   **Given** que o administrador aciona o botão de teste de integração,
*   **And** as chaves de integração do Google Calendar no `.env` contêm credenciais inválidas ou expiradas,
*   **When** o teste é processado,
*   **Then** a chamada à API do Google retorna erro de autenticação,
*   **And** a Server Action captura a falha e retorna o detalhe do erro técnico (ex: "401 Unauthorized - Invalid Credentials"),
*   **And** exibe uma mensagem de falha na tela: "Falha na conexão com o Google Calendar. Verifique as credenciais no arquivo .env. Detalhes: [Erro]",
*   **And** cria um registro na tabela `public.logs_auditoria` com `acao = 'teste_conexao_calendario'` e os detalhes da falha.

---

### 3.4. Auditoria de Segurança, Estatísticas e Prompt

#### Cenário 1: Imutabilidade de Logs de Auditoria
*   **Given** que um usuário mal-intencionado obteve credenciais de administrador,
*   **When** ele tenta enviar uma instrução SQL de `UPDATE` ou `DELETE` diretamente na tabela `public.logs_auditoria`,
*   **Then** o banco de dados do Supabase rejeita a operação com base nas restrições de RLS ou políticas de escrita restrita,
*   **And** nenhum registro de log de auditoria é modificado ou excluído.

#### Cenário 2: Visualização de Estatísticas e Proporção IA vs Humano
*   **Given** que o administrador acessa o dashboard de atendimento,
*   **And** a tabela `public.mensagens` contém 150 mensagens com `remetente = 'cliente'`, 80 mensagens com `remetente = 'ia'` e 20 mensagens com `remetente = 'operador'`,
*   **When** a página do dashboard é renderizada,
*   **Then** o sistema exibe os contadores individuais de mensagens,
*   **And** apresenta o índice de automação (Ratio da IA) calculado como: `80 mensagens de IA / (80 IA + 20 Humano) = 80% de automação de respostas`.

#### Cenário 3: Auditoria Visual do Master Prompt da Sofía
*   **Given** que o supervisor acessa o painel de auditoria do prompt do assistente,
*   **When** ele visualiza a seção "Diretrizes da IA Sofía",
*   **Then** o sistema exibe o texto atual configurado no backend em `openrouter.ts` contendo as regras de persona, uso de gírias curitibanas ("piá", "daí") e emojis,
*   **And** o campo de exibição do prompt está configurado como somente leitura, sem botão ou meio de edição.

### 3.5. Exclusão de Usuários e Clientes (deletarUsuarioAdmin)

#### Cenário 1: Exclusão de um cliente e seus dados relacionados com sucesso
*   **Given** que o administrador está logado e acessa a área de Gestão de Usuários em `/atendimento/admin`,
*   **And** existe um cliente com ID de usuário correspondente com histórico de pedidos, conversas e mensagens associados,
*   **When** o administrador clica no botão para excluir o cliente e confirma a ação no modal,
*   **Then** o sistema invoca a Server Action `deletarUsuarioAdmin`,
*   **And** executa a deleção em cascata contornando as políticas RLS usando `service_role`,
*   **And** remove de forma irreversível os registros em `itens_pedido`, `pedidos`, `mensagens`, `conversas` e do cliente,
*   **And** remove o registro correspondente em `auth.users`,
*   **And** atualiza a listagem de usuários na tela, removendo o cliente.

#### Cenário 2: Bloqueio da exclusão do último administrador ativo (Prevenção de Lockout)
*   **Given** que o banco de dados contém apenas um usuário ativo com `funcao = 'admin'` e `ativo = true`,
*   **When** o administrador tenta excluir este usuário de ID correspondente ao último admin ativo,
*   **Then** a Server Action `deletarUsuarioAdmin` MUST abortar a transação imediatamente,
*   **And** retornar uma mensagem de erro informando que a operação é inválida para evitar lockout,
*   **And** manter o registro correspondente no banco de dados sem nenhuma alteração.

### 3.6. Encerramento de Sessão (Logout)

#### Cenário 1: Encerramento de sessão com sucesso
*   **Given** que o administrador está autenticado no painel administrativo `/atendimento/admin`,
*   **When** ele clica no botão "Sair" (Logout),
*   **Then** o sistema invoca a função de sign out do Supabase no cliente,
*   **And** limpa as credenciais locais e cookies de sessão do navegador,
*   **And** redireciona o usuário para a rota `/login`.

### 3.7. Gerenciamento Dinâmico de API Keys

#### Cenário 1: Visualização e atualização de chaves de API pelo administrador
*   **Given** que o administrador está autenticado no painel administrativo na aba "Integrações",
*   **When** ele preenche novos valores para o token da Meta e chave de API da DeepSeek e clica em "Salvar",
*   **Then** o sistema executa uma Server Action que valida as entradas e as persiste na tabela `public.configuracoes_sistema`,
*   **And** mascara a exibição da chave na interface do usuário após a gravação bem-sucedida,
*   **And** registra a ação na tabela de logs de auditoria sem expor os valores literais das chaves de API.

### 3.8. Incorporação da Base de Conhecimento no Dashboard

#### Cenário 1: Gerenciamento de artigos através da aba incorporada no dashboard
*   **Given** que o administrador acessa o Painel Administrativo em `/atendimento/admin`,
*   **When** ele seleciona a aba "Base de Conhecimento",
*   **Then** a interface renderiza a listagem de artigos disponíveis no banco,
*   **And** permite a execução das ações de criação de novo artigo, edição e exclusão dentro do mesmo contêiner visual de dashboard.

### 3.9. Interface Modular de Integrações

#### Cenário 1: Salvamento independente do cartão de LLM
*   **Given** que o operador está na aba de Integrações,
*   **And** o cartão de LLM exibe os campos `DEEPSEEK_API_KEY` e `DEEPSEEK_MODEL`,
*   **When** o operador modifica a chave de API do LLM e clica em "Salvar LLM",
*   **Then** apenas as chaves do LLM são salvas na tabela `configuracoes_sistema`,
*   **And** nenhuma outra configuração de integração é submetida ou alterada,
*   **And** uma mensagem de sucesso é exibida via toast.

#### Cenário 2: Exibição de QR Code no cartão Evolution API
*   **Given** que as credenciais do Evolution API estão configuradas,
*   **When** o operador clica em "Testar Conexão Evolution",
*   **Then** o sistema invoca a Server Action para verificar o status de conexão da instância,
*   **And** se a instância estiver desconectada, a área de QR Code exibe a imagem em base64 retornada pela Evolution API para pareamento.

#### Cenário 3: Alternância do provedor ativo de WhatsApp com aviso de confirmação
*   **Given** que o provedor ativo está configurado como "meta",
*   **And** o interruptor de provedor mostra "Meta Cloud API" ativo,
*   **When** o operador muda o interruptor para "evolution",
*   **Then** o sistema exibe um modal de confirmação alertando sobre o impacto imediato no envio/recebimento de mensagens,
*   **And** após a confirmação do operador, o sistema grava `WHATSAPP_PROVIDER = 'evolution'` no banco de dados e atualiza o badge do cartão para "Evolution API ativa".

#### Cenário 4: Teste de conexão Mercado Pago
*   **Given** que o operador forneceu um token de acesso do Mercado Pago,
*   **When** o operador clica em "Testar Conexão Mercado Pago",
*   **Then** o sistema invoca a Server Action de teste que consome a API do Mercado Pago,
*   **And** retorna sucesso se obtiver HTTP 200, ou exibe o erro amigável correspondente se falhar.

### 3.10. Grade Responsiva no Dashboard de Integrações

#### Cenário 1: Layout responsivo do painel de integrações
*   **Given** que o operador está autenticado como administrador no sistema Asados.
*   **And** acessa a aba "Integrações" do painel `/atendimento/dashboard`.
*   **When** a página é renderizada em uma tela com largura maior ou igual a 1024px.
*   **Then** o sistema exibe os cards em uma grade estruturada em exatamente duas colunas (`lg:grid-cols-2`).
*   **When** a tela é redimensionada para uma largura menor que 1024px.
*   **Then** a grade se ajusta de forma dinâmica, empilhando todos os cards verticalmente em uma única coluna (`grid-cols-1`).

### 3.11. Edição do Prompt do Sistema Mestre

#### Cenário 1: Edição em tempo real e uso do prompt mestre
*   **Given** que o administrador acessa a aba "Prompt da IA".
*   **When** altera o system prompt contendo as instruções de atendimento da persona e clica em "Salvar Alterações".
*   **Then** o sistema grava o novo conteúdo na tabela `public.configuracoes_sistema` na chave `'SOFIA_SYSTEM_PROMPT'`.
*   **And** insere um log em `public.logs_auditoria` com a ação `'atualizar_prompt_sistema'`.
*   **And** a próxima mensagem inbound que passar pelo pipeline de RAG Sofía utilizará imediatamente as novas instruções recém-gravadas.

---

## 4. Estrutura de Validação de Dados (Schema Zod Conceitual)

Para a atualização de permissões e execução de ações do dashboard admin, a validação de dados no servidor MUST impor regras equivalentes a este esquema conceitual:

```typescript
// Validação para atualização de perfil de usuário
const EsqueletoAtualizacaoUsuario = {
  usuarioAlvoId: "string (UUID válido)",
  funcao: "enum ('admin', 'supervisor', 'vendedor', 'cliente')",
  ativo: "boolean"
};

// Validação de segurança para impedir lockout
// Se (usuarioAlvoId === usuarioLogadoId), a ação de desativar (ativo = false) ou 
// rebaixar papel (funcao !== 'admin') MUST falhar na validação lógica de negócio.
```

---

## 5. Requisitos Não-Funcionais e Segurança

1.  **Imutabilidade da Auditoria**:
    *   A tabela `public.logs_auditoria` MUST ser estritamente protegida por políticas de RLS e triggers. Permissões de escrita direta por usuários via API do Supabase MUST ser desabilitadas para operações `UPDATE` e `DELETE`.
2.  **Segurança de Credenciais**:
    *   Credenciais de API e chaves privadas do Google Calendar MUST ser mantidas exclusivamente no servidor (variáveis de ambiente do arquivo `.env`) e nunca transmitidas ao navegador.
3.  **Conformidade com a LGPD**:
    *   Toda saída de logs de auditoria visual ou técnica não MUST expor dados sensíveis não mascarados. A listagem de emails do painel de controle MUST ser restrita apenas a usuários com papéis administrativos verificados em sessões seguras no lado do servidor.
4.  **Localização**:
    *   Todas as chaves de erros, cópias de telas, relatórios estatísticos e enums do banco de dados MUST seguir o Português do Brasil (pt-BR).

---

## 6. Produtos e Estoque no Dashboard Administrativo

### Requirement: Superfície oficial de Produtos/Estoque

O sistema MUST oferecer Produtos/Estoque somente dentro de `/atendimento/admin?tab=estoque`. A rota legada `/atendimento/produtos` MUST redirecionar para essa superfície oficial ou deixar de existir, sem manter uma segunda experiência funcional.

#### Scenario: Acesso à aba oficial

- GIVEN um usuário administrativo autenticado com perfil ativo
- WHEN ele acessa `/atendimento/admin?tab=estoque`
- THEN o sistema MUST exibir a experiência integrada de Produtos/Estoque

#### Scenario: Rota legada

- GIVEN qualquer solicitação para `/atendimento/produtos`
- WHEN a rota é resolvida
- THEN o sistema MUST redirecionar para `/atendimento/admin?tab=estoque` ou responder como rota inexistente
- AND MUST NOT oferecer ali uma experiência funcional duplicada

### Requirement: Grade responsiva de produtos

Na aba oficial de Estoque, o sistema MUST renderizar os produtos em cards compactos e responsivos. Em desktop, a grade MUST suportar até seis colunas; em telas menores, MUST adaptar a quantidade de colunas ao espaço disponível sem perder a operação dos cards.

#### Scenario: Grade desktop

- GIVEN a aba de Estoque aberta em uma viewport desktop
- WHEN os produtos são carregados
- THEN os cards MUST ser exibidos em uma grade compacta com no máximo seis colunas

#### Scenario: Grade responsiva

- GIVEN a aba de Estoque aberta em uma viewport menor
- WHEN os produtos são carregados
- THEN os cards MUST se reorganizar responsivamente
- AND cada ação administrativa MUST continuar acessível

### Requirement: Restrições administrativas existentes

O acesso à superfície oficial MUST preservar as restrições existentes do painel: somente usuários autenticados com função `admin` ou `supervisor` e perfil ativo podem utilizá-la; usuários não autenticados, inativos ou com outras funções MUST ser bloqueados conforme as regras existentes de `/atendimento/admin`.

#### Scenario: Usuário autorizado

- GIVEN um usuário autenticado com `funcao = 'admin'` ou `funcao = 'supervisor'` e `ativo = true`
- WHEN ele acessa a aba de Estoque
- THEN o sistema MUST permitir o uso da superfície oficial

#### Scenario: Usuário não autorizado

- GIVEN uma sessão ausente, um perfil inativo ou uma função diferente de `admin` e `supervisor`
- WHEN o usuário tenta acessar a aba de Estoque
- THEN o sistema MUST negar o acesso usando o comportamento já definido para o painel administrativo

## Requirements added by `sofia-customer-memory`

### Requirement: Anonymization removes the anonymized customer's facts

`public.anonymizar_usuario_admin(p_usuario_alvo_id uuid)` MUST delete the `public.fatos_cliente` rows
belonging to the target customer's client record. The deletion MUST happen before, or atomically
with, clearing `clientes.usuario_id`, because once that column is nulled the link from the user to the
client no longer exists and the facts become unreachable through that path.

The function's existing authorization (`public.tem_funcoes` including `admin`), its anti-lockout
rule, and its audit-log entry MUST be preserved. Facts belonging to every other customer MUST survive
the call.

#### Scenario: Anonymization purges the target customer's facts

- GIVEN a customer with facts, and other customers with their own facts
- WHEN an admin anonymizes that customer's user
- THEN the target customer's `fatos_cliente` rows MUST be deleted
- AND every other customer's facts MUST remain unchanged
- AND the call MUST still record its audit entry and still clear the profile fields it clears today

#### Scenario: Ordering does not lose the facts

- GIVEN the target customer's facts exist while `clientes.usuario_id` still points at the anonymized
  user
- WHEN the anonymization runs
- THEN the facts MUST be deleted within the same call
- AND after the call no fact row MUST remain reachable for that customer

#### Scenario: Unauthorized caller changes nothing

- GIVEN an authenticated caller without the `admin` function
- WHEN the caller invokes the anonymization function
- THEN the call MUST fail with `42501`
- AND no fact row MUST be deleted

### Requirement: Total purge keeps removing facts through the cascade

The total purge path (`iniciar_purga_total_usuario_admin` and its downstream jobs) MUST continue to
remove the customer's facts through the `on delete cascade` foreign key from `public.fatos_cliente`
when the customer row is deleted. The change MUST NOT require, and MUST NOT weaken, that cascade.

#### Scenario: Purge leaves no facts behind

- GIVEN a customer with facts
- WHEN the total purge completes and deletes the customer row
- THEN no `fatos_cliente` row MUST remain for that customer

#### Scenario: Purge does not touch other customers

- GIVEN a purge of one customer and other customers holding facts
- WHEN the purge completes
- THEN the other customers' facts MUST remain unchanged
