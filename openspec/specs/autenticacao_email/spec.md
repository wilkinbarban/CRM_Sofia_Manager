# Especificação de Requisitos: Confirmação de E-mail e Internacionalização (autenticacao_email)

**ID da Mudança:** `epica9-melhorias-integracao`  
**Domínio:** `autenticacao_email`  
**Status:** `Aprovado`  

---

## 1. Descrição Executiva

Este documento especifica a correção do redirecionamento de confirmação de e-mail (que anteriormente apontava para `localhost:3000`), a tradução de todos os textos voltados ao usuário na página `/verificar-email` do espanhol (Rioplatense) para o português do Brasil (pt-BR), a criação de um modelo de e-mail HTML personalizado da marca para a confirmação de cadastro no Supabase, e a documentação das etapas de configuração manual necessárias no console do Supabase.

---

## 2. Requisitos de Configuração Externa (Supabase)

### 2.1 Supabase Dashboard — Site URL
*   **REQ-EMAIL-001**: O projeto no Supabase Cloud MUST ter sua `Site URL` configurada como `https://crmsofiamanager.duckdns.org`.
    *   **Local:** Supabase Dashboard → Authentication → URL Configuration → Site URL
    *   **Valor anterior:** `http://localhost:3000`
    *   **Valor alvo:** `https://crmsofiamanager.duckdns.org`
    *   **Impacto:** Todos os links de confirmação gerados usarão esta URL como base para a variável de template `{{ .ConfirmationURL }}`.

### 2.2 Supabase Dashboard — Redirect URLs
*   **REQ-EMAIL-002**: O projeto no Supabase Cloud MUST incluir `https://crmsofiamanager.duckdns.org/**` na lista de URLs de redirecionamento permitidas (Redirect URLs).
    *   **Local:** Supabase Dashboard → Authentication → URL Configuration → Redirect URLs

### 2.3 Supabase Dashboard — Template de E-mail de Confirmação
*   **REQ-EMAIL-003**: O projeto no Supabase Cloud MUST substituir o template de e-mail de "Confirm signup" pelo conteúdo HTML pt-BR oficial personalizado criado em `docs/templates/email-confirmacao.html`.
    *   **Assunto do e-mail:** `Confirme seu e-mail — Casa de Asados`
    *   **Corpo:** Cópia fiel de `docs/templates/email-confirmacao.html`
    *   **Variáveis obrigatórias:** `{{ .ConfirmationURL }}`

---

## 3. Especificação do Template de E-mail

### 3.1 Arquivo de Modelo (Template)
*   **REQ-EMAIL-004**: Um template HTML de e-mail institucional MUST ser criado em `docs/templates/email-confirmacao.html`.
*   **REQ-EMAIL-005**: O template de e-mail MUST usar exclusivamente estilos CSS inline (sem blocos `<style>` ou folhas de estilo externas) para garantir compatibilidade máxima com leitores de e-mail.
*   **REQ-EMAIL-006**: O layout do e-mail MUST ser baseado em tabelas (`<table>`) para compatibilidade com Outlook e clientes legados.
*   **REQ-EMAIL-007**: O template MUST conter os seguintes elementos textuais e visuais:
    *   Idioma: Português do Brasil (pt-BR)
    *   Nome da marca: `Casa de Asados`
    *   Slogan: `Churrascaria Premium`
    *   Paleta de cores: Primária: `#dc2626` (red-600), Destaque: `#f59e0b` (amber-500), Fundo: `#18181b` (zinc-900), Texto: `#fafafa` (zinc-50)
    *   Texto do botão CTA: `Confirmar Meu E-mail`
    *   Link do CTA: `{{ .ConfirmationURL }}`
    *   Aviso de expiração do link (24 horas)
    *   Aviso de segurança: "Se você não criou esta conta, ignore este e-mail."
    *   Rodapé: "© 2026 Casa de Asados — Churrascaria Premium"

---

## 4. Tradução da Página `/verificar-email`

### 4.1 Conteúdo Textual
*   **REQ-EMAIL-008**: Todas as strings visíveis ao usuário na rota `/verificar-email` MUST ser traduzidas do Espanhol (Espanha/Rioplatense) para o Português do Brasil (pt-BR), de acordo com o seguinte mapeamento:

| Estado da Tela | Espanhol (Anterior) | Português (Alvo) |
|---|---|---|
| `sucesso === 'true'` (Título) | `¡Email Verificado!` | `E-mail Verificado!` |
| `sucesso === 'true'` (Corpo) | `Tu dirección de correo electrónico ha sido confirmada con éxito. Ya podés acceder a todos los servicios de la churrascaria.` | `Seu endereço de e-mail foi confirmado com sucesso. Você já pode acessar todos os serviços da churrascaria.` |
| `sucesso === 'true'` (Botão) | `Continuar` | `Continuar` |
| `sucesso === 'false'` (Título) | `Error de Verificación` | `Erro de Verificação` |
| `sucesso === 'false'` (Corpo) | `No pudimos verificar tu dirección de correo electrónico. El enlace de confirmación puede haber expirado o ya haber sido utilizado.` | `Não foi possível verificar seu endereço de e-mail. O link de confirmação pode ter expirado ou já ter sido utilizado.` |
| `sucesso === 'false'` (Botão) | `Volver al Login` | `Voltar ao Login` |
| `sucesso === null` (Título) | `Verificá tu Correo` | `Verifique seu E-mail` |
| `sucesso === null` (Corpo) | `Te enviamos un enlace de activación a tu cuenta de e-mail. Por favor, revisá tu bandeja de entrada (y la carpeta de spam) y hacé clic en el enlace para confirmar tu cuenta.` | `Enviamos um link de ativação para o seu e-mail. Por favor, verifique sua caixa de entrada (e a pasta de spam) e clique no link para confirmar sua conta.` |
| `sucesso === null` (Botão) | `Volver al Login` | `Voltar ao Login` |

*   **REQ-EMAIL-009**: O nome da churrascaria no cabeçalho MUST permanecer como `Asados Sofía` por motivos de identidade da marca.

---

## 5. Cenários de Aceitação (Gherkin - Given/When/Then)

### Cenário 1: Redirecionamento correto do link de e-mail
*   **Given** que a `Site URL` do Supabase está configurada como `https://crmsofiamanager.duckdns.org`,
*   **And** as URLs de redirecionamento contêm o padrão coringa para o domínio de produção,
*   **When** um novo cliente se cadastra com um e-mail válido,
*   **Then** o link de ativação no e-mail enviado MUST usar o domínio de produção como base e não o localhost.

### Cenário 2: Confirmação e Redirecionamento para a tela de status
*   **Given** que o usuário clica no link de confirmação do e-mail recebido,
*   **When** o navegador navega para a rota de callback do backend (`/api/auth/callback`),
*   **Then** a rota valida o token de sessão e redireciona o cliente com sucesso para `/verificar-email?sucesso=true`.

### Cenário 3: Exibição correta da tela em português (Sucesso)
*   **Given** que o usuário chega à rota `/verificar-email?sucesso=true`,
*   **When** a tela é renderizada,
*   **Then** o título exibido MUST ser "E-mail Verificado!" em português,
*   **And** o botão "Continuar" redireciona o cliente para o fluxo de verificação de telefone.

### Cenário 4: Exibição correta da tela em português (Falha)
*   **Given** que a validação falhou e o usuário chega à rota `/verificar-email?sucesso=false`,
*   **When** a tela é renderizada,
*   **Then** o título exibido MUST ser "Erro de Verificação",
*   **And** o botão exibe "Voltar ao Login" redirecionando para `/login`.

---

## 6. Documentação e Requisitos Não Funcionais
*   **REQ-EMAIL-010**: Um runbook explicativo detalhado MUST ser criado em `docs/supabase-email-setup.md` contendo as instruções passo a passo para as 3 alterações manuais exigidas no dashboard do Supabase Cloud, além de critérios de validação e rollback.
*   **REQ-EMAIL-011**: O design visual, animações e layout originais da página `/verificar-email` MUST ser mantidos idênticos — apenas o texto traduzido é alterado.
