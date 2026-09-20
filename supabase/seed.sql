-- Seed Data para Testes Locais: Autenticação e Validação de Telefone (Épica 1)

-- 1. Limpeza de dados existentes (de baixo para cima devido a chaves estrangeiras)
TRUNCATE public.produto_imagem_orfao_eventos CASCADE;
TRUNCATE public.produto_imagem_orfao_reconciliacoes CASCADE;
TRUNCATE public.logs_auditoria CASCADE;
TRUNCATE public.codigos_verificacao CASCADE;
TRUNCATE public.clientes CASCADE;
TRUNCATE public.perfis CASCADE;
DELETE FROM auth.users WHERE true;

-- 2. Inserir usuários de teste na tabela auth.users do Supabase Auth
-- Senha de teste padrão criptografada com bcrypt usando a extensão pgcrypto
INSERT INTO auth.users (
    instance_id,
    id,
    aud,
    role,
    email,
    phone,
    encrypted_password,
    email_confirmed_at,
    phone_confirmed_at,
    recovery_sent_at,
    last_sign_in_at,
    raw_app_meta_data,
    raw_user_meta_data,
    created_at,
    updated_at,
    confirmation_token,
    email_change,
    email_change_token_new,
    recovery_token
) VALUES
-- Admin
(
    '00000000-0000-0000-0000-000000000000',
    'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1',
    'authenticated',
    'authenticated',
    'admin@crmsofiamanager.com.br',
    NULL,
    extensions.crypt('SenhaAdmin123', extensions.gen_salt('bf')),
    now(),
    NULL,
    null,
    null,
    '{"provider": "email", "providers": ["email"]}',
    '{"nome": "Carlos Admin"}',
    now(),
    now(),
    '',
    '',
    '',
    ''
),
-- Vendedor
(
    '00000000-0000-0000-0000-000000000000',
    'b2b2b2b2-b2b2-b2b2-b2b2-b2b2b2b2b2b2',
    'authenticated',
    'authenticated',
    'vendedor@crmsofiamanager.com.br',
    NULL,
    extensions.crypt('SenhaVendedor123', extensions.gen_salt('bf')),
    now(),
    NULL,
    null,
    null,
    '{"provider": "email", "providers": ["email"]}',
    '{"nome": "Ana Vendedora"}',
    now(),
    now(),
    '',
    '',
    '',
    ''
),
-- Supervisor
(
    '00000000-0000-0000-0000-000000000000',
    '7c7c7c7c-7c7c-7c7c-7c7c-7c7c7c7c7c7c',
    'authenticated',
    'authenticated',
    'supervisor@crmsofiamanager.com.br',
    NULL,
    extensions.crypt('SenhaSupervisor123', extensions.gen_salt('bf')),
    now(),
    NULL,
    null,
    null,
    '{"provider": "email", "providers": ["email"]}',
    '{"nome": "Julia Supervisor"}',
    now(),
    now(),
    '',
    '',
    '',
    ''
),
-- Cliente João Web (Phone-First)
(
    '00000000-0000-0000-0000-000000000000',
    'c3c3c3c3-c3c3-c3c3-c3c3-c3c3c3c3c3c3',
    'authenticated',
    'authenticated',
    NULL,
    '5541988888888',
    extensions.crypt('SenhaCliente123', extensions.gen_salt('bf')),
    NULL,
    now(),
    null,
    null,
    '{"provider": "phone", "providers": ["phone"]}',
    '{"nome": "João Web"}',
    now(),
    now(),
    '',
    '',
    '',
    ''
),
-- Cliente Phone-First
(
    '00000000-0000-0000-0000-000000000000',
    'd5d5d5d5-d5d5-d5d5-d5d5-d5d5d5d5d5d5',
    'authenticated',
    'authenticated',
    NULL,
    '5541999998888',
    extensions.crypt('SenhaCliente123', extensions.gen_salt('bf')),
    NULL,
    now(),
    null,
    null,
    '{"provider": "phone", "providers": ["phone"]}',
    '{"nome": "Carlos Phone"}',
    now(),
    now(),
    '',
    '',
    '',
    ''
);

-- 3. Atualizar as funções na tabela de perfis (já que o trigger tr_ao_criar_usuario criou como 'cliente')
UPDATE public.perfis
SET funcao = 'admin'::public.tipo_funcao
WHERE id = 'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1';

UPDATE public.perfis
SET funcao = 'vendedor'::public.tipo_funcao
WHERE id = 'b2b2b2b2-b2b2-b2b2-b2b2-b2b2b2b2b2b2';

UPDATE public.perfis
SET funcao = 'supervisor'::public.tipo_funcao
WHERE id = '7c7c7c7c-7c7c-7c7c-7c7c-7c7c7c7c7c7c';


-- 4. Inserir clientes de teste
-- Cliente prévio do WhatsApp (sem usuario_id)
INSERT INTO public.clientes (
    id,
    usuario_id,
    nome,
    telefone,
    endereco
) VALUES (
    'd4d4d4d4-d4d4-d4d4-d4d4-d4d4d4d4d4d4',
    NULL,
    'João WhatsApp',
    '5541999999999',
    'Rua das Flores, 123 - Curitiba'
);

-- Cliente Web criado no fluxo Auth
INSERT INTO public.clientes (
    id,
    usuario_id,
    nome,
    telefone,
    endereco
) VALUES (
    'c3c3c3c3-c3c3-c3c3-c3c3-c3c3c3c3c3c3',
    'c3c3c3c3-c3c3-c3c3-c3c3-c3c3c3c3c3c3',
    'João Web',
    '5541988888888',
    'Av. Sete de Setembro, 456 - Curitiba'
);

-- Cliente Phone-First criado no fluxo de telefone
INSERT INTO public.clientes (
    id,
    usuario_id,
    nome,
    telefone,
    endereco
) VALUES (
    'd5d5d5d5-d5d5-d5d5-d5d5-d5d5d5d5d5d5',
    'd5d5d5d5-d5d5-d5d5-d5d5-d5d5d5d5d5d5',
    'Carlos Phone',
    '5541999998888',
    'Rua XV de Novembro, 789 - Curitiba'
);

-- 5. Inserir Conversas de Teste
INSERT INTO public.conversas (
    id,
    cliente_id,
    status,
    ia_ativa
) VALUES (
    'e5e5e5e5-e5e5-e5e5-e5e5-e5e5e5e5e5e5',
    'c3c3c3c3-c3c3-c3c3-c3c3-c3c3c3c3c3c3',
    'ia_atendendo',
    TRUE
);

-- 6. Inserir Mensagens de Teste
INSERT INTO public.mensagens (
    id,
    conversa_id,
    remetente,
    conteudo,
    url_anexo
) VALUES 
(
    'f6f6f6f6-f6f6-f6f6-f6f6-f6f6f6f6f6f6',
    'e5e5e5e5-e5e5-e5e5-e5e5-e5e5e5e5e5e5',
    'cliente',
    'Olá! Gostaria de saber os valores dos kits de churrasco.',
    NULL
),
(
    'f7f7f7f7-f7f7-f7f7-f7f7-f7f7f7f7f7f7',
    'e5e5e5e5-e5e5-e5e5-e5e5-e5e5e5e5e5e5',
    'ia',
    'Olá, João! Eu sou a Sofía, atendente deste CRM em ambiente de demonstração com dados de teste. Nossos kits variam de R$ 150 a R$ 450. Qual tamanho de evento você planeja?',
    NULL
);
