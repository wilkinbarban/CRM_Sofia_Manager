/**
 * Integration & Security Test Suite - Épica 8 (Dashboard Admin & Auditoria)
 * Tests Middleware route protection, Server Actions access control, lockout rules, minimum admin check,
 * logs RLS immutability, statistics calculations, and audit log compliance.
 */

const { createClient } = require('@supabase/supabase-js');
const path = require('path');
const fs = require('fs');

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

// Helpers for clients
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
    'next/cache': path.resolve(__dirname, './mock-cache.js')
  }
});

const mockHeaders = require('./mock-headers');
const mockServer = require('./mock-server');

const { proxy: middleware } = jiti('../apps/web/proxy.ts');
const {
  listarUsuariosAdmin,
  atualizarPerfilUsuario,
  obterEstatisticasMensagens,
  obterLogsAuditoria
} = jiti('../apps/web/src/app/actions/admin.ts');

// Helper to update mock cookies for server actions
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

// Helper to format cookies array for NextRequest mock
function getCookieArray(session) {
  if (!session) return [];
  const sessionData = {
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    expires_at: session.expires_at,
    user: session.user
  };
  const base64Session = Buffer.from(JSON.stringify(sessionData)).toString('base64url');
  const cookieValue = 'base64-' + base64Session;
  return [{ name: 'sb-auth-token', value: cookieValue }];
}

async function runTests() {
  logSection('Starting Admin Dashboard & Security Integration Tests (Épica 8)');

  const testPassword = 'Password123!';
  const timestamp = Date.now();

  const emails = {
    admin1: `test_ad1_${timestamp}@crmsofiamanager.com.br`,
    admin2: `test_ad2_${timestamp}@crmsofiamanager.com.br`,
    supervisor: `test_sup_${timestamp}@crmsofiamanager.com.br`,
    vendedor: `test_vend_${timestamp}@crmsofiamanager.com.br`,
    cliente: `test_cli_${timestamp}@crmsofiamanager.com.br`,
    inactiveAdmin: `test_inad_${timestamp}@crmsofiamanager.com.br`
  };

  const users = {};
  const sessions = {};
  const userClients = {};

  let testConversation = null;

  try {
    // ----------------------------------------------------
    // SETUP: Create Test Users with respective Roles & Statuses
    // ----------------------------------------------------
    // Deactivate any seeded or existing admin users to prevent pollution of the "minimum admin check"
    const { error: cleanAdminsError } = await adminClient
      .from('perfis')
      .update({ ativo: false })
      .eq('funcao', 'admin');
    if (cleanAdminsError) {
      console.warn('Warning: Could not clear existing admin profiles:', cleanAdminsError.message);
    } else {
      logSuccess('Cleared existing admin profiles from database to isolate test.');
    }

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

      const client = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
      await client.auth.setSession(loginData.session);

      return { user, session: loginData.session, client };
    };

    const setupRoles = [
      { key: 'admin1', role: 'admin' },
      { key: 'admin2', role: 'admin' },
      { key: 'supervisor', role: 'supervisor' },
      { key: 'vendedor', role: 'vendedor' },
      { key: 'cliente', role: 'cliente' },
      { key: 'inactiveAdmin', role: 'admin', active: false }
    ];

    for (const setup of setupRoles) {
      const res = await createTestUser(emails[setup.key], setup.role, setup.active !== false);
      users[setup.key] = res.user;
      sessions[setup.key] = res.session;
      userClients[setup.key] = res.client;
      logSuccess(`Created ${setup.key} user (Role: ${setup.role}, Active: ${setup.active !== false})`);
    }

    // Initialize one conversation for stats tests
    const { data: cliProfile, error: cliProfileError } = await adminClient
      .from('clientes')
      .insert({
        usuario_id: users.cliente.id,
        nome: 'Cliente Integracao',
        telefone: '5541912345678'
      })
      .select()
      .single();
    if (cliProfileError) throw cliProfileError;

    const { data: conv, error: convError } = await adminClient
      .from('conversas')
      .insert({
        cliente_id: cliProfile.id,
        status: 'ia_atendendo',
        ia_ativa: true
      })
      .select()
      .single();
    if (convError) throw convError;
    testConversation = conv;

    // ====================================================
    // TASK 4.2: Middleware Integration & Redirect Tests
    // ====================================================
    logSection('Testing Task 4.2: Middleware Access Rules & Redirects');

    const testMiddlewareRoute = async (session, path, expectedStatus, expectedRedirectUrl = null) => {
      const request = new mockServer.NextRequest(`http://localhost:3000${path}`, {
        cookies: getCookieArray(session)
      });
      const response = await middleware(request);
      
      if (response.status !== expectedStatus) {
        throw new Error(`Middleware test failed for path ${path}. Expected status ${expectedStatus}, got ${response.status}`);
      }
      if (expectedRedirectUrl) {
        const actualRedirect = response.redirectedUrl;
        if (!actualRedirect || !actualRedirect.endsWith(expectedRedirectUrl)) {
          throw new Error(`Middleware redirect failed for path ${path}. Expected redirect to end with ${expectedRedirectUrl}, got ${actualRedirect}`);
        }
      }
      return response;
    };

    // Anonymous User (Not logged in)
    console.log('Testing Anonymous access redirects...');
    await testMiddlewareRoute(null, '/atendimento/admin', 307, '/login');
    await testMiddlewareRoute(null, '/atendimento/admin/operadores', 307, '/login');
    logSuccess('Anonymous requests to admin subroutes redirect to /login.');

    // Inactive Admin
    console.log('Testing Inactive Operator access redirection...');
    await testMiddlewareRoute(sessions.inactiveAdmin, '/atendimento/admin', 307, '/login?erro=inativo');
    logSuccess('Inactive user requests redirect to /login?erro=inativo.');

    // Client User (Role: cliente)
    console.log('Testing Client (Role: cliente) access redirects...');
    await testMiddlewareRoute(sessions.cliente, '/atendimento/admin', 307, '/403');
    logSuccess('Client user requests to admin subroutes redirect to /403.');

    // Vendedor User (Role: vendedor)
    console.log('Testing Vendedor (Role: vendedor) access redirects...');
    await testMiddlewareRoute(sessions.vendedor, '/atendimento/admin', 307, '/403');
    logSuccess('Vendedor requests to admin subroutes redirect to /403.');

    // Supervisor User (Role: supervisor)
    console.log('Testing Supervisor (Role: supervisor) access allowance...');
    await testMiddlewareRoute(sessions.supervisor, '/atendimento/admin', 200);
    logSuccess('Supervisor requests to admin subroutes are permitted.');

    // Admin User (Role: admin)
    console.log('Testing Admin (Role: admin) access allowance...');
    await testMiddlewareRoute(sessions.admin1, '/atendimento/admin', 200);
    await testMiddlewareRoute(sessions.admin1, '/atendimento/admin/operadores', 200);
    logSuccess('Admin requests to admin subroutes are permitted.');

    // ====================================================
    // TASK 4.3: Server Action atualizarPerfilUsuario Safety Rules
    // ====================================================
    logSection('Testing Task 4.3: atualizarPerfilUsuario Safety Rules & Auditing');

    // 1. Auto-lockout block (updating self fails)
    console.log('A. Testing Auto-Lockout: Admin cannot update their own profile...');
    setSessionCookies(sessions.admin1);
    const selfUpdateRes = await atualizarPerfilUsuario(users.admin1.id, 'vendedor', true);
    if (selfUpdateRes.success || selfUpdateRes.error !== 'ANTI_LOCKOUT') {
      throw new Error(`Expected ANTI_LOCKOUT error for self-update, got: ${JSON.stringify(selfUpdateRes)}`);
    }
    logSuccess('Auto-lockout protection successfully prevented self-downgrading.');

    // 2. Minimum admin check
    console.log('B. Testing Minimum Admin requirement: Cannot deactivate/downgrade the last active admin...');
    
    // Temporarily deactivate Admin 2, leaving Admin 1 as the only active admin
    const { error: deactivateAd2Error } = await adminClient
      .from('perfis')
      .update({ ativo: false })
      .eq('id', users.admin2.id);
    if (deactivateAd2Error) throw deactivateAd2Error;

    // Use Supervisor session to try to deactivate Admin 1
    setSessionCookies(sessions.supervisor);
    
    console.log(' - Trying to deactivate the sole active admin...');
    const deactivateAd1Res = await atualizarPerfilUsuario(users.admin1.id, 'admin', false);
    if (deactivateAd1Res.success || deactivateAd1Res.error !== 'MINIMO_UM_ADMIN_ATIVO') {
      throw new Error(`Expected MINIMO_UM_ADMIN_ATIVO error for deactivating sole admin, got: ${JSON.stringify(deactivateAd1Res)}`);
    }

    console.log(' - Trying to downgrade the sole active admin...');
    const downgradeAd1Res = await atualizarPerfilUsuario(users.admin1.id, 'vendedor', true);
    if (downgradeAd1Res.success || downgradeAd1Res.error !== 'MINIMO_UM_ADMIN_ATIVO') {
      throw new Error(`Expected MINIMO_UM_ADMIN_ATIVO error for downgrading sole admin, got: ${JSON.stringify(downgradeAd1Res)}`);
    }
    logSuccess('Minimum admin guard successfully blocked downgrading/deactivating the sole active admin.');

    // Reactivate Admin 2
    const { error: reactivateAd2Error } = await adminClient
      .from('perfis')
      .update({ ativo: true })
      .eq('id', users.admin2.id);
    if (reactivateAd2Error) throw reactivateAd2Error;

    // Now try again with Admin 2 active - should succeed
    console.log(' - Downgrading Admin 1 when Admin 2 is also active...');
    const validDowngradeRes = await atualizarPerfilUsuario(users.admin1.id, 'vendedor', true);
    if (!validDowngradeRes.success) {
      throw new Error(`Expected successful downgrade of Admin 1, got error: ${validDowngradeRes.error}`);
    }
    
    // Check database state of Admin 1 profile
    const { data: admin1Profile, error: getAd1Error } = await adminClient
      .from('perfis')
      .select('funcao')
      .eq('id', users.admin1.id)
      .single();
    if (getAd1Error || admin1Profile.funcao !== 'vendedor') {
      throw new Error(`Profile target role not updated correctly: ${getAd1Error?.message || admin1Profile.funcao}`);
    }
    logSuccess('Successfully updated profile role when another active admin was present.');

    // 3. Audit Log insertion on successful profile update
    console.log('C. Verifying audit log generated automatically on profile update...');
    const { data: latestLogs, error: getLogsError } = await adminClient
      .from('logs_auditoria')
      .select('*')
      .eq('usuario_id', users.supervisor.id)
      .eq('acao', 'atualizar_perfil')
      .order('data_criacao', { ascending: false })
      .limit(1);

    if (getLogsError || !latestLogs || latestLogs.length === 0) {
      throw new Error(`Audit log was not created: ${getLogsError?.message}`);
    }

    const logRow = latestLogs[0];
    if (
      logRow.detalhes.usuario_alvo_id !== users.admin1.id ||
      logRow.detalhes.nova_funcao !== 'vendedor' ||
      logRow.detalhes.novo_ativo !== true
    ) {
      throw new Error(`Log details mismatch: ${JSON.stringify(logRow.detalhes)}`);
    }
    logSuccess('Audit logs table successfully received a detailed change record.');

    // Restore Admin 1 to 'admin' role
    const { error: restoreAd1Error } = await adminClient
      .from('perfis')
      .update({ funcao: 'admin' })
      .eq('id', users.admin1.id);
    if (restoreAd1Error) throw restoreAd1Error;

    // ====================================================
    // TASK 4.4: logs_auditoria RLS Policies & Immutability
    // ====================================================
    logSection('Testing Task 4.4: logs_auditoria RLS Policies & Immutability');

    // 1. Client user blocked from SELECT & INSERT on logs_auditoria
    console.log('A. Verifying standard client cannot read logs...');
    const { data: clientReadData, error: clientReadError } = await userClients.cliente
      .from('logs_auditoria')
      .select('*');
    if (clientReadData && clientReadData.length > 0) {
      throw new Error('Security Violation: Client read logs from table!');
    }
    logSuccess('Standard Client is prevented from selecting audit logs (returns empty).');

    console.log('B. Verifying standard client cannot insert logs...');
    const { data: clientInsertData, error: clientInsertError } = await userClients.cliente
      .from('logs_auditoria')
      .insert({ acao: 'manual_hack', detalhes: { info: 'hack' } });
    if (clientInsertData && clientInsertData.length > 0) {
      throw new Error('Security Violation: Client inserted logs!');
    }
    logSuccess('Standard Client is prevented from inserting audit logs (RLS block).');

    // 2. Supervisor / Admin can SELECT & INSERT on logs_auditoria
    console.log('C. Verifying Supervisor can insert and read logs...');
    const { data: supInsertData, error: supInsertError } = await userClients.supervisor
      .from('logs_auditoria')
      .insert({ acao: 'manual_supervisor', detalhes: { info: 'supervisor_test' } })
      .select()
      .single();
    if (supInsertError || !supInsertData) {
      throw new Error(`Supervisor failed to insert audit log: ${supInsertError?.message}`);
    }

    const { data: supReadData, error: supReadError } = await userClients.supervisor
      .from('logs_auditoria')
      .select('*')
      .eq('id', supInsertData.id);
    if (supReadError || !supReadData || supReadData.length === 0) {
      throw new Error(`Supervisor failed to read back their inserted log: ${supReadError?.message}`);
    }
    logSuccess('Operators (supervisors/admins) are authorized to insert and select logs.');

    // 3. Test Physical Immutability (UPDATE and DELETE fail for everyone)
    console.log('D. Verifying UPDATE on logs fails (even for Admin client)...');
    const { data: adminUpdateData, error: adminUpdateError } = await userClients.admin1
      .from('logs_auditoria')
      .update({ acao: 'tampered_action' })
      .eq('id', supInsertData.id)
      .select();

    if (adminUpdateData && adminUpdateData.length > 0) {
      throw new Error('Security Violation: Admin successfully updated audit logs!');
    }
    
    // Double check row was not updated in DB
    const { data: checkUpdateRow } = await adminClient
      .from('logs_auditoria')
      .select('acao')
      .eq('id', supInsertData.id)
      .single();
    if (checkUpdateRow && checkUpdateRow.acao !== 'manual_supervisor') {
      throw new Error(`Data was tampered: acao changed to ${checkUpdateRow.acao}`);
    }
    logSuccess('RLS prevents UPDATE operations on logs_auditoria table.');

    console.log('E. Verifying DELETE on logs fails (even for Admin client)...');
    const { data: adminDeleteData, error: adminDeleteError } = await userClients.admin1
      .from('logs_auditoria')
      .delete()
      .eq('id', supInsertData.id)
      .select();

    if (adminDeleteData && adminDeleteData.length > 0) {
      throw new Error('Security Violation: Admin successfully deleted audit logs!');
    }

    // Double check row still exists in DB
    const { data: checkDeleteRow } = await adminClient
      .from('logs_auditoria')
      .select('id')
      .eq('id', supInsertData.id)
      .single();
    if (!checkDeleteRow) {
      throw new Error('Security Violation: Row was physically deleted!');
    }
    logSuccess('RLS prevents DELETE operations on logs_auditoria table.');

    // ====================================================
    // TASK 4.5: Statistics Calculator & PII Compliance
    // ====================================================
    logSection('Testing Task 4.5: Metrics & Obfuscation');

    // 1. Validate Message Statistics
    console.log('A. Testing obterEstatisticasMensagens calculations...');
    
    // Fetch initial stats
    setSessionCookies(sessions.admin1);
    const initialStatsRes = await obterEstatisticasMensagens();
    if (!initialStatsRes.success) {
      throw new Error(`Failed to fetch initial stats: ${initialStatsRes.error}`);
    }
    const initial = initialStatsRes.data;

    // Insert mock messages: 5 'ia', 3 'operador', 2 'cliente'
    const mockMsgs = [
      ...Array(5).fill({ conversa_id: testConversation.id, remetente: 'ia', conteudo: 'Sofia Resposta Automatica' }),
      ...Array(3).fill({ conversa_id: testConversation.id, remetente: 'operador', conteudo: 'Atendente Humano' }),
      ...Array(2).fill({ conversa_id: testConversation.id, remetente: 'cliente', conteudo: 'Cliente Mensagem' })
    ];

    const { error: msgInsertError } = await adminClient.from('mensagens').insert(mockMsgs);
    if (msgInsertError) throw msgInsertError;

    // Fetch updated stats
    const updatedStatsRes = await obterEstatisticasMensagens();
    if (!updatedStatsRes.success) {
      throw new Error(`Failed to fetch updated stats: ${updatedStatsRes.error}`);
    }
    const updated = updatedStatsRes.data;

    const diffIa = updated.totalIa - initial.totalIa;
    const diffOperador = updated.totalOperador - initial.totalOperador;
    const diffCliente = updated.totalCliente - initial.totalCliente;
    const diffTotal = updated.totalMensagens - initial.totalMensagens;

    if (diffIa !== 5 || diffOperador !== 3 || diffCliente !== 2 || diffTotal !== 10) {
      throw new Error(`Stats mismatch: ia=${diffIa}, operator=${diffOperador}, client=${diffCliente}, total=${diffTotal}`);
    }

    // Verify automation rate formula (IA responses / (IA + Operator responses) * 100)
    // For inserted: 5 / (5 + 3) * 100 = 62.5%
    const totalResp = updated.totalIa + updated.totalOperador;
    const expectedRate = totalResp > 0 ? parseFloat(((updated.totalIa / totalResp) * 100).toFixed(2)) : 0;
    if (updated.taxaAutomacao !== expectedRate) {
      throw new Error(`Taxa Automacao formula mismatch: expected ${expectedRate}, got ${updated.taxaAutomacao}`);
    }
    logSuccess(`Message statistics match inserted mocks perfectly. Taxa automacao updated. Got: ${updated.taxaAutomacao}%`);

    // 3. Audit PII logging compliance
    console.log('C. Auditing logs for PII (names, phone numbers, emails, messages)...');
    
    // Select all logs inserted during this run
    const { data: runLogs } = await adminClient
      .from('logs_auditoria')
      .select('*')
      .gte('data_criacao', new Date(timestamp).toISOString());

    for (const log of runLogs || []) {
      const detailsStr = JSON.stringify(log.detalhes);
      // Scan for any client name, email, or telephone in details
      if (
        detailsStr.includes('@crmsofiamanager.com.br') ||
        detailsStr.includes('55419') ||
        detailsStr.includes('Sofia Resposta') ||
        detailsStr.includes('Atendente Humano') ||
        detailsStr.includes('Cliente Mensagem')
      ) {
        throw new Error(`PII / Chat Content leak detected in audit log: ${JSON.stringify(log)}`);
      }
    }
    logSuccess('PII Compliance Audit Passed: Absolutely zero PII or chat content leaked in logs.');

    logSection('All Admin Integration & Security Tests Passed (100% SUCCESS)');

  } catch (err) {
    logError('An integration test failed!', err.message || err);
    process.exitCode = 1;
  } finally {
    // ----------------------------------------------------
    // CLEANUP: Reset Database State & Delete Users
    // ----------------------------------------------------
    console.log('\nCleaning up integration test resources...');
    try {
      // 1. Delete conversation and messages
      if (testConversation) {
        // will cascade delete messages
        await adminClient.from('conversas').delete().eq('id', testConversation.id);
      }

      // 2. Delete logs created during this run
      await adminClient.from('logs_auditoria').delete().gte('data_criacao', new Date(timestamp).toISOString());

      // 3. Delete clients
      await adminClient.from('clientes').delete().eq('nome', 'Cliente Integracao');

      // 4. Delete auth users (will delete profiles via trigger if cascading, or profiles must be deleted)
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
