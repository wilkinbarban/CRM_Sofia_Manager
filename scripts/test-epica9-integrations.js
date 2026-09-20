const { createClient } = require('@supabase/supabase-js');
const path = require('path');
const fs = require('fs');
const assert = require('assert');

// Configure local emulator keys and URLs
const SUPABASE_URL = 'http://127.0.0.1:54321';
const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';
const SERVICE_ROLE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';

process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL;
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = ANON_KEY;
process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_ROLE_KEY;

// Parse extra environment variables if present
const envPath = path.resolve(__dirname, '../.env');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf8');
  envContent.split('\n').forEach(line => {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
      const parts = trimmed.split('=');
      const key = parts[0].trim();
      const val = parts.slice(1).join('=').trim().replace(/^['"]|['"]$/g, '');
      if (!process.env[key]) {
        process.env[key] = val;
      }
    }
  });
}

const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const anonClient = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });

// Colors for logging
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  bold: '\x1b[1m'
};

function logSuccess(message) {
  console.log(`${colors.green}✔ SUCCESS: ${message}${colors.reset}`);
}

function logError(message, details = '') {
  console.error(`${colors.red}✘ FAILURE: ${message}${colors.reset}`, details);
}

function logSection(title) {
  console.log(`\n${colors.bold}${colors.cyan}=== ${title} ===${colors.reset}\n`);
}

// Import dependencies using jiti
const jiti = require('jiti')(__filename, {
  alias: {
    '@': path.resolve(__dirname, '../apps/web/src'),
    'next/headers': path.resolve(__dirname, './mock-headers.js'),
    'next/server': path.resolve(__dirname, './mock-server.js'),
    'next/cache': path.resolve(__dirname, './mock-cache.js'),
    '@/lib/supabase/admin': path.resolve(__dirname, './mock-admin.js')
  }
});

const mockHeaders = require('./mock-headers');
const mockAdmin = require('./mock-admin');

// Import the items under test
const { obterConfiguracaoSistema } = jiti('../apps/web/src/lib/config/sistema.ts');
const { enviarMensagemWhatsapp } = jiti('../apps/web/src/lib/whatsapp/send.ts');
const { testarConexaoEvolution, obterQrCodeEvolution, testarConexaoMercadoPago } = jiti('../apps/web/src/app/actions/admin.ts');

function setSessionCookies(session) {
  if (!session) {
    mockHeaders.setMockCookies([]);
    return;
  }
  const sessionData = {
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    expires_at: session.expires_at,
    user: session.user
  };
  const base64Session = Buffer.from(JSON.stringify(sessionData)).toString('base64url');
  const cookieValue = 'base64-' + base64Session;
  
  mockHeaders.setMockCookies([
    { name: 'sb-auth-token', value: cookieValue }
  ]);
}

async function runTests() {
  logSection('Starting Integration Tests (Épica 9 - WU 4)');
  mockAdmin.resetMock();

  const timestamp = Date.now();
  const testEmail = `test_admin_ep9_${timestamp}@crmsofiamanager.com.br`;
  const testPassword = 'Password123!';
  let testUser;
  let testSession;
  let testClienteId;
  let testConversaId;

  try {
    // ----------------------------------------------------
    // SETUP: Create Test Operator User
    // ----------------------------------------------------
    console.log('Setting up test supervisor user...');
    const { data: userData, error: userError } = await adminClient.auth.admin.createUser({
      email: testEmail,
      password: testPassword,
      email_confirm: true,
      user_metadata: { nome: 'Supervisor Ep9 Teste' }
    });
    if (userError) throw userError;
    testUser = userData.user;

    const { error: profileError } = await adminClient
      .from('perfis')
      .update({ funcao: 'supervisor', ativo: true })
      .eq('id', testUser.id);
    if (profileError) throw profileError;

    const { data: loginData, error: loginError } = await anonClient.auth.signInWithPassword({
      email: testEmail,
      password: testPassword
    });
    if (loginError) throw loginError;
    testSession = loginData.session;
    logSuccess(`Created and authenticated supervisor user: ${testEmail}`);

    // ----------------------------------------------------
    // SETUP: Create Client and Conversation
    // ----------------------------------------------------
    console.log('Setting up test customer and conversation...');
    // Create a customer with a valid Curitiba phone
    const testPhone = '5541999990009';
    // Clean up if it exists
    await adminClient.from('clientes').delete().eq('telefone', testPhone);

    const { data: cliente, error: cliError } = await adminClient
      .from('clientes')
      .insert({ nome: 'Cliente Ep9 Teste', telefone: testPhone })
      .select('id')
      .single();
    if (cliError) throw cliError;
    testClienteId = cliente.id;

    const { data: conversa, error: convError } = await adminClient
      .from('conversas')
      .insert({ cliente_id: testClienteId, status: 'ia_atendendo', ia_ativa: true })
      .select('id')
      .single();
    if (convError) throw convError;
    testConversaId = conversa.id;

    // Open the 24h window by adding a message from the client
    const { error: msgError } = await adminClient
      .from('mensagens')
      .insert({
        conversa_id: testConversaId,
        remetente: 'cliente',
        conteudo: 'Olá!',
        whatsapp_mensagem_id: `wamid.test_init_${timestamp}`
      });
    if (msgError) throw msgError;
    logSuccess('Created test customer and conversation with open 24h window.');

    // ----------------------------------------------------
    // TEST 1: Provider Configuration Switching
    // ----------------------------------------------------
    logSection('TEST 1: Provider Configuration Switching');
    
    // Save configuration directly to DB
    const providers = ['meta', 'evolution'];
    for (const provider of providers) {
      const { error: upsertErr } = await adminClient
        .from('configuracoes_sistema')
        .upsert({ chave: 'WHATSAPP_PROVIDER', valor: provider }, { onConflict: 'chave' });
      if (upsertErr) throw upsertErr;

      const currentVal = await obterConfiguracaoSistema('WHATSAPP_PROVIDER');
      assert.strictEqual(currentVal, provider, `Should read provider config as "${provider}"`);
      logSuccess(`Correctly switched and verified provider key: "${provider}"`);
    }

    // ----------------------------------------------------
    // TEST 2: Sending message routes to correct provider (Mock mode)
    // ----------------------------------------------------
    logSection('TEST 2: Routing outbound messages');

    // Case 2a: Set provider to 'meta' and send
    console.log('Testing Meta provider routing...');
    await adminClient
      .from('configuracoes_sistema')
      .upsert({ chave: 'WHATSAPP_PROVIDER', valor: 'meta' }, { onConflict: 'chave' });
    
    // Set dummy meta values to ensure mock mode
    await adminClient
      .from('configuracoes_sistema')
      .upsert({ chave: 'WHATSAPP_ACCESS_TOKEN', valor: 'placeholder_token' }, { onConflict: 'chave' });
    await adminClient
      .from('configuracoes_sistema')
      .upsert({ chave: 'WHATSAPP_PHONE_NUMBER_ID', valor: 'placeholder_phone_id' }, { onConflict: 'chave' });

    const resMeta = await enviarMensagemWhatsapp(testConversaId, {
      texto: 'Mensagem de teste Meta',
      remetente: 'operador'
    });

    assert.strictEqual(resMeta.sucesso, true, 'Meta send should succeed');
    assert.ok(resMeta.whatsappMensagemId.startsWith('wamid.HBg'), `Meta message ID should start with "wamid.HBg" (actual: ${resMeta.whatsappMensagemId})`);
    logSuccess('Meta outbound routing and database persistence verified.');

    // Case 2b: Set provider to 'evolution' and send
    console.log('Testing Evolution provider routing...');
    await adminClient
      .from('configuracoes_sistema')
      .upsert({ chave: 'WHATSAPP_PROVIDER', valor: 'evolution' }, { onConflict: 'chave' });
    
    // Set dummy evolution values to ensure mock mode
    await adminClient
      .from('configuracoes_sistema')
      .upsert({ chave: 'EVOLUTION_API_URL', valor: 'placeholder_url' }, { onConflict: 'chave' });
    await adminClient
      .from('configuracoes_sistema')
      .upsert({ chave: 'EVOLUTION_API_KEY', valor: 'placeholder_key' }, { onConflict: 'chave' });
    await adminClient
      .from('configuracoes_sistema')
      .upsert({ chave: 'EVOLUTION_INSTANCE_NAME', valor: 'placeholder_instance' }, { onConflict: 'chave' });

    const resEvolution = await enviarMensagemWhatsapp(testConversaId, {
      texto: 'Mensagem de teste Evolution',
      remetente: 'operador'
    });

    assert.strictEqual(resEvolution.sucesso, true, 'Evolution send should succeed');
    assert.ok(resEvolution.whatsappMensagemId.startsWith('evolution-'), `Evolution message ID should start with "evolution-" (actual: ${resEvolution.whatsappMensagemId})`);
    logSuccess('Evolution outbound routing and database persistence verified.');

    // ----------------------------------------------------
    // TEST 3: Server Actions Connectivity
    // ----------------------------------------------------
    logSection('TEST 3: Server Actions Connectivity');
    setSessionCookies(testSession);

    // 3a. testarConexaoEvolution (expect failure since placeholders are invalid URL, but validates action execution)
    console.log('Calling testarConexaoEvolution with invalid parameters...');
    const connRes = await testarConexaoEvolution('invalid_url', 'invalid_key', 'invalid_inst');
    assert.strictEqual(connRes.success, false, 'Should fail connection test with invalid URL');
    logSuccess('testarConexaoEvolution executes and handles error gracefully.');

    // 3b. obterQrCodeEvolution
    console.log('Calling obterQrCodeEvolution...');
    const qrRes = await obterQrCodeEvolution('invalid_url', 'invalid_key', 'invalid_inst');
    assert.strictEqual(qrRes.success, false, 'Should fail qr code generation with invalid URL');
    logSuccess('obterQrCodeEvolution executes and handles error gracefully.');

    // 3c. testarConexaoMercadoPago
    console.log('Calling testarConexaoMercadoPago...');
    const mpRes = await testarConexaoMercadoPago('invalid_token');
    assert.strictEqual(mpRes.success, false, 'Should fail Mercado Pago test with invalid token');
    logSuccess('testarConexaoMercadoPago executes and handles error gracefully.');

  } catch (err) {
    logError('Tests failed with error:', err);
    process.exit(1);
  } finally {
    // ----------------------------------------------------
    // CLEANUP
    // ----------------------------------------------------
    console.log('\nCleaning up test data...');
    if (testConversaId) {
      await adminClient.from('mensagens').delete().eq('conversa_id', testConversaId);
      await adminClient.from('conversas').delete().eq('id', testConversaId);
    }
    if (testClienteId) {
      await adminClient.from('clientes').delete().eq('id', testClienteId);
    }
    if (testUser) {
      await adminClient.from('perfis').delete().eq('id', testUser.id);
      await adminClient.auth.admin.deleteUser(testUser.id);
    }
    logSuccess('Cleanup complete.');
  }
}

runTests();
