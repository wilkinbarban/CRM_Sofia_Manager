import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import ChatContainer from '@/components/chat/ChatContainer';
import { getBusinessProfile } from '@/lib/config/business-profile';

export const dynamic = 'force-dynamic';

export default async function ClienteChatPage() {
  const supabase = await createClient();

  // 1. Obter usuário autenticado
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    redirect('/login');
  }

  // 2. Buscar o registro de cliente vinculado ao usuario_id
  const { data: cliente, error: clienteError } = await supabase
    .from('clientes')
    .select('id, nome, telefone')
    .eq('usuario_id', user.id)
    .single();

  if (clienteError || !cliente) {
    // Se não tiver registro de cliente (telefone verificado), redireciona
    redirect('/cliente/verificar-telefone');
  }

  // 3. Buscar uma conversa ativa (status diferente de 'fechada')
  const activeConversationResult = await supabase
    .from('conversas')
    .select('*')
    .eq('cliente_id', cliente.id)
    .neq('status', 'fechada')
    .order('data_atualizacao', { ascending: false })
    .limit(1)
    .maybeSingle();

  let conversa = activeConversationResult.data;
  const conversaError = activeConversationResult.error;

  if (conversaError) {
    console.error('Erro ao buscar conversa ativa:', conversaError);
  }

  // 4. Se não existir uma conversa ativa, cria uma nova
  if (!conversa) {
    const { data: novaConversa, error: createError } = await supabase
      .from('conversas')
      .insert({
        cliente_id: cliente.id,
        status: 'ia_atendendo',
        ia_ativa: true,
      })
      .select()
      .single();

    if (createError || !novaConversa) {
      console.error('Erro ao criar nova conversa:', createError);
      throw new Error('Não foi possível iniciar o seu atendimento de chat.');
    }
    conversa = novaConversa;
  }

  // 5. Buscar as últimas 50 mensagens da conversa
  const { data: mensagensDb, error: mensagensError } = await supabase
    .from('mensagens')
    .select('*')
    .eq('conversa_id', conversa.id)
    .order('data_criacao', { ascending: false })
    .limit(50);

  if (mensagensError) {
    console.error('Erro ao buscar mensagens do chat:', mensagensError);
  }

  // Inverter a ordem para exibir cronologicamente (da mais antiga para a mais recente)
  const mensagensIniciais = mensagensDb ? [...mensagensDb].reverse() : [];

  // 6. Buscar produtos disponíveis no estoque
  const { data: produtos, error: produtosError } = await supabase
    .rpc('buscar_produtos_disponiveis');

  if (produtosError) {
    console.error('Erro ao buscar produtos disponíveis:', produtosError);
  }

  const businessProfile = await getBusinessProfile()

  return (
    <main className="flex-1 flex flex-col h-screen w-full bg-zinc-950 text-zinc-100 overflow-hidden">
      <ChatContainer
        clienteNome={cliente.nome}
        conversaInicial={conversa}
        mensagensIniciais={mensagensIniciais}
        produtos={produtos || []}
        brandName={businessProfile.name}
      />
    </main>
  );
}
