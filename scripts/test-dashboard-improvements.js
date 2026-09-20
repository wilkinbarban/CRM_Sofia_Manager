/**
 * Integration Test Suite - Épica 8 (Dashboard Improvements: Diagnostics & Integration Tests)
 * Tests Lockout protection, Minimum active admin guard, Safe cascading deletion, and Dynamic Configuration Fallback.
 */

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

const { deletarUsuarioAdmin } = jiti('../apps/web/src/app/actions/admin.ts');
const { obterConfiguracaoSistema } = jiti('../apps/web/src/lib/config/sistema.ts');

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
  logSection('Starting Dashboard Improvements Integration Tests (Épica 8 - WU 4)');
  mockAdmin.resetMock();

  const testPassword = 'Password123!';
  const timestamp = Date.now();

  const emails = {
    callerAdmin: `test_cld_${timestamp}@crmsofiamanager.com.br`,
    otherAdmin: `test_oad_${timestamp}@crmsofiamanager.com.br`,
    targetUser: `test_tgt_${timestamp}@crmsofiamanager.com.br`
  };

  const users = {};
  const sessions = {};

  try {
    // ----------------------------------------------------
    // SETUP: Create Test Users
    // ----------------------------------------------------
    console.log('Setting up test users in Supabase Auth...');

    const createTestUser = async (email, role, active = true) => {
      const { data, error } = await adminClient.auth.admin.createUser({
        email,
        password: testPassword,
        email_confirm: true,
        user_metadata: { nome: `${role} Teste` }
      });
      if (error) throw error;
      
      const user = data.user;
      
      // Update profile
      const { error: profileError } = await adminClient
        .from('perfis')
        .update({ funcao: role, ativo: active })
        .eq('id', user.id);
      if (profileError) throw profileError;

      // Authenticate to get session
      const { data: loginData, error: loginError } = await anonClient.auth.signInWithPassword({
        email,
        password: testPassword
      });
      if (loginError) throw loginError;

      return { user, session: loginData.session };
    };

    // We need:
    // 1. A supervisor/admin to call the deletion (callerAdmin)
    // 2. An active admin (otherAdmin)
    // 3. A client user (targetUser)
    
    const resCaller = await createTestUser(emails.callerAdmin, 'supervisor');
    users.callerAdmin = resCaller.user;
    sessions.callerAdmin = resCaller.session;
    logSuccess(`Created callerAdmin user (Role: supervisor)`);

    const resOther = await createTestUser(emails.otherAdmin, 'admin');
    users.otherAdmin = resOther.user;
    sessions.otherAdmin = resOther.session;
    logSuccess(`Created otherAdmin user (Role: admin)`);

    const resTarget = await createTestUser(emails.targetUser, 'cliente');
    users.targetUser = resTarget.user;
    sessions.targetUser = resTarget.session;
    logSuccess(`Created targetUser (Role: cliente)`);

    // ----------------------------------------------------
    // TEST 1: Lockout protection
    // ----------------------------------------------------
    logSection('TEST 1: Lockout protection (prevent self-deletion)');
    
    // Set callerAdmin session
    setSessionCookies(sessions.callerAdmin);
    
    const selfDeleteRes = await deletarUsuarioAdmin(users.callerAdmin.id);
    assert.strictEqual(selfDeleteRes.success, false, 'Should not allow self-deletion');
    assert.strictEqual(selfDeleteRes.error, 'ANTI_LOCKOUT_AUTO_EXCLUSAO', 'Expected ANTI_LOCKOUT_AUTO_EXCLUSAO error');
    
    logSuccess('Lockout protection successfully blocked self-deletion.');

    // ----------------------------------------------------
    // TEST 2: Minimum active admin guard
    // ----------------------------------------------------
    logSection('TEST 2: Minimum active admin guard');

    // Currently otherAdmin is the ONLY active admin in the database.
    // Let's verify by counting active admins.
    const { count: activeAdminsCount, error: countErr } = await adminClient
      .from('perfis')
      .select('*', { count: 'exact', head: true })
      .eq('funcao', 'admin')
      .eq('ativo', true);
    
    if (countErr) throw countErr;
    console.log(`Active admins in database: ${activeAdminsCount}`);

    // If activeAdminsCount > 1, we must deactivate the other active admins (excluding otherAdmin) to test the guard
    if (activeAdminsCount > 1) {
      console.log('Deactivating extra active admins to isolate test...');
      const { error: deacErr } = await adminClient
        .from('perfis')
        .update({ ativo: false })
        .eq('funcao', 'admin')
        .neq('id', users.otherAdmin.id);
      if (deacErr) throw deacErr;
    }

    // Call deletarUsuarioAdmin on otherAdmin (who is the sole active admin)
    const lastAdminDeleteRes = await deletarUsuarioAdmin(users.otherAdmin.id);
    assert.strictEqual(lastAdminDeleteRes.success, false, 'Should not allow deleting the last active admin');
    assert.strictEqual(lastAdminDeleteRes.error, 'MINIMO_UM_ADMIN_ATIVO', 'Expected MINIMO_UM_ADMIN_ATIVO error');

    logSuccess('Minimum active admin guard successfully blocked deleting the last active admin.');

    // Restore any extra admins if needed (or we will do cleanup anyway)

    // ----------------------------------------------------
    // TEST 3: Safe cascading deletion
    // ----------------------------------------------------
    logSection('TEST 3: Safe cascading deletion');

    // Create target records:
    // A. Client in public.clientes
    const { data: clientRecord, error: clientErr } = await adminClient
      .from('clientes')
      .insert({
        usuario_id: users.targetUser.id,
        nome: 'Target Client',
        telefone: '5541999990001',
        endereco: 'Rua de Teste Cascata, 123'
      })
      .select()
      .single();
    if (clientErr) throw clientErr;
    logSuccess(`Created public.clientes record for targetUser`);

    // B. Conversation in public.conversas
    const { data: convRecord, error: convErr } = await adminClient
      .from('conversas')
      .insert({
        cliente_id: clientRecord.id,
        status: 'ia_atendendo',
        ia_ativa: true
      })
      .select()
      .single();
    if (convErr) throw convErr;
    logSuccess(`Created public.conversas record`);

    // C. Message in public.mensagens
    const { data: msgRecord, error: msgErr } = await adminClient
      .from('mensagens')
      .insert({
        conversa_id: convRecord.id,
        remetente: 'cliente',
        conteudo: 'Mensagem de Teste Cascata'
      })
      .select()
      .single();
    if (msgErr) throw msgErr;
    logSuccess(`Created public.mensagens record`);

    // D. Product in public.produtos (find or create)
    let productRecord = null;
    const { data: existingProducts } = await adminClient.from('produtos').select('*').limit(1);
    if (existingProducts && existingProducts.length > 0) {
      productRecord = existingProducts[0];
    } else {
      const { data: newProd, error: newProdError } = await adminClient
        .from('produtos')
        .insert({
          nome: 'Costela Premium',
          preco_centavos: 12000,
          ativo: true
        })
        .select()
        .single();
      if (newProdError) throw newProdError;
      productRecord = newProd;
    }
    logSuccess(`Using product ID: ${productRecord.id}`);

    // E. Order in public.pedidos
    const { data: orderRecord, error: orderErr } = await adminClient
      .from('pedidos')
      .insert({
        cliente_id: clientRecord.id,
        conversa_id: convRecord.id,
        status: 'novo',
        tipo_entrega: 'retirada',
        endereco_entrega: 'Rua de Teste Cascata, 123',
        total_produtos_centavos: productRecord.preco_centavos,
        total_pedido_centavos: productRecord.preco_centavos,
        meio_pagamento: 'pix',
        status_pagamento: 'pendente'
      })
      .select()
      .single();
    if (orderErr) throw orderErr;
    logSuccess(`Created public.pedidos record`);

    // F. Item in public.itens_pedido
    const { data: itemRecord, error: itemErr } = await adminClient
      .from('itens_pedido')
      .insert({
        pedido_id: orderRecord.id,
        produto_id: productRecord.id,
        preco_unitario_centavos: productRecord.preco_centavos,
        quantidade: 1
      })
      .select()
      .single();
    if (itemErr) throw itemErr;
    logSuccess(`Created public.itens_pedido record`);

    // Reset the mock stats
    mockAdmin.resetMock();

    // Call deletarUsuarioAdmin on targetUser
    console.log(`Calling deletarUsuarioAdmin on targetUser (${users.targetUser.id})...`);
    const deleteRes = await deletarUsuarioAdmin(users.targetUser.id);
    assert.strictEqual(deleteRes.success, true, `Deletion failed: ${deleteRes.error}`);

    // Assert that the auth delete user mock was called with targetUser.id
    assert.strictEqual(mockAdmin.getDeleteUserCallCount(), 1, 'Expected auth delete user mock to be called once');
    assert.strictEqual(mockAdmin.getLastDeletedUserId(), users.targetUser.id, 'Expected auth delete to be called for targetUser');
    logSuccess('Verified mock for auth admin delete user was successfully triggered.');

    // Assert that all related records are physically deleted from the database
    // 1. perfis
    const { data: profileCheck } = await adminClient.from('perfis').select('*').eq('id', users.targetUser.id);
    assert.strictEqual(profileCheck.length, 0, 'Profile record should be physically deleted');

    // 2. clientes
    const { data: clientCheck } = await adminClient.from('clientes').select('*').eq('id', clientRecord.id);
    assert.strictEqual(clientCheck.length, 0, 'Client record should be physically deleted');

    // 3. conversas
    const { data: convCheck } = await adminClient.from('conversas').select('*').eq('id', convRecord.id);
    assert.strictEqual(convCheck.length, 0, 'Conversation record should be physically deleted');

    // 4. mensagens
    const { data: msgCheck } = await adminClient.from('mensagens').select('*').eq('id', msgRecord.id);
    assert.strictEqual(msgCheck.length, 0, 'Message record should be physically deleted');

    // 5. pedidos
    const { data: orderCheck } = await adminClient.from('pedidos').select('*').eq('id', orderRecord.id);
    assert.strictEqual(orderCheck.length, 0, 'Order record should be physically deleted');

    // 6. itens_pedido
    const { data: itemCheck } = await adminClient.from('itens_pedido').select('*').eq('id', itemRecord.id);
    assert.strictEqual(itemCheck.length, 0, 'Order item record should be physically deleted');

    logSuccess('All cascading delete assertions passed successfully.');

    // ----------------------------------------------------
    // TEST 4: Dynamic Configuration Fallback Helper
    // ----------------------------------------------------
    logSection('TEST 4: Dynamic Configuration Fallback Helper');

    const testKey = `TEST_FALLBACK_KEY_${timestamp}`;
    const envValue = 'value-from-env';
    const dbValue = 'value-from-db';

    // 4.1. Clean DB key just in case
    await adminClient.from('configuracoes_sistema').delete().eq('chave', testKey);

    // 4.2. Verify fallback to process.env
    process.env[testKey] = envValue;
    const fallbackRes = await obterConfiguracaoSistema(testKey);
    assert.strictEqual(fallbackRes, envValue, 'Should fall back to environment variable when not in DB');
    logSuccess('Fallback to process.env verified successfully.');

    // 4.3. Verify DB priority
    const { error: dbInsertErr } = await adminClient
      .from('configuracoes_sistema')
      .insert({
        chave: testKey,
        valor: dbValue,
        eh_segredo: false
      });
    if (dbInsertErr) throw dbInsertErr;

    const dbPriorityRes = await obterConfiguracaoSistema(testKey);
    assert.strictEqual(dbPriorityRes, dbValue, 'Should fetch from database first even if present in environment');
    logSuccess('Database priority over process.env verified successfully.');

    // Cleanup configuration key
    await adminClient.from('configuracoes_sistema').delete().eq('chave', testKey);
    delete process.env[testKey];

    logSection('All Tests Passed Successfully! (100% SUCCESS)');

  } catch (err) {
    logError('An integration test failed!', err.stack || err.message || err);
    process.exitCode = 1;
  } finally {
    // ----------------------------------------------------
    // CLEANUP: Reset Database State & Delete Users
    // ----------------------------------------------------
    console.log('\nCleaning up integration test resources...');
    try {
      // 1. Delete auth users using real auth delete
      for (const key of Object.keys(users)) {
        if (users[key]) {
          await adminClient.auth.admin.deleteUser(users[key].id);
        }
      }
      logSuccess('Test data cleaned up successfully.');
    } catch (cleanupErr) {
      logError('Failed to run final cleanup:', cleanupErr.message || cleanupErr);
    }
  }
}

runTests();
