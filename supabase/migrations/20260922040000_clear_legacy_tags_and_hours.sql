-- Exact seed-only cleanup: customized tag arrays and hours messages remain untouched.
update public.base_conhecimento
set tags = ARRAY['combo 1', 'frango recheado', 'cardápio', 'almoço', 'maionese', 'farofa', 'preço', 'família']::varchar(100)[]
where tags = ARRAY['combo 1', 'frango recheado', 'cardápio', 'almoço', 'maionese', 'farofa', 'preço', 'família', 'clássico brasa e sabor']::varchar(100)[];

update public.base_conhecimento
set tags = ARRAY['combo 3', 'frango', 'costelinha', 'porco', 'batata rustica', 'preço']::varchar(100)[]
where tags = ARRAY['combo 3', 'dueto brasa & sabor', 'frango', 'costelinha', 'porco', 'batata rustica', 'preço']::varchar(100)[];

update public.base_conhecimento
set tags = ARRAY['horários', 'retirada', 'balcão', 'delivery', 'entrega', 'agendamento', 'sem fila']::varchar(100)[]
where tags = ARRAY['horários', 'retirada', 'balcão', 'delivery', 'entrega', 'umbara', 'curitiba', 'agendamento', 'sem fila']::varchar(100)[];

update public.configuracoes_sistema
set valor = 'Olá! No momento estamos fora do horário de atendimento.

Nosso horário de funcionamento é:
📅 {dias_semana}
🕐 {horario_inicio} às {horario_fim}

Envie sua mensagem durante esse período para que possamos ajudar você.

Equipe de atendimento'
where chave = 'MENSAGEM_FORA_HORARIO'
and valor = $$Olá! 😊 Agora estamos fora do nosso horário de atendimento, mas não se preocupe — sua mensagem é muito importante para nós! 🥩

Nosso horário de funcionamento é:
📅 {dias_semana}
🕐 {horario_inicio} às {horario_fim}

Ficaremos felizes em atendê-lo(a) durante esse período. Envie sua mensagem quando estivermos abertos que será um prazer ajudar você com o melhor churrasco de Curitiba! 🍖

Atenciosamente,
Equipe Asados ❤️$$;
