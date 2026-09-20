/**
 * Integration & Security Test Suite - Épica 6 (CRM & Sales Integration)
 * Tests CRM Updates, Operator Orders creation, Google Calendar Mock and Resilient failure paths,
 * and RLS security enforcement.
 */

const { createClient } = require('@supabase/supabase-js');
const path = require('path');
const fs = require('fs');

const SUPABASE_URL = 'http://127.0.0.1:54321';
const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';
const SERVICE_ROLE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';

process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL;
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = ANON_KEY;
process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_ROLE_KEY;

// Parse extra environment variables if present (to avoid overwriting real credentials if needed)
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

// Import actions using jiti compiled on the fly
const jiti = require('jiti')(__filename, {
  alias: {
    '@': path.resolve(__dirname, '../apps/web/src'),
    'next/headers': path.resolve(__dirname, './mock-headers.js'),
    'next/cache': path.resolve(__dirname, './mock-cache.js')
  }
});

const mockHeaders = require('./mock-headers');
const { atualizarClienteCrm } = jiti('../apps/web/src/app/actions/clientes');
const { criarProduto } = jiti('../apps/web/src/app/actions/produtos');
const { criarPedidoOperador, confirmarPedidoOperador } = jiti('../apps/web/src/app/actions/pedidos');

// Helper to update the mock headers cookie with user session
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
  logSection('Starting CRM, Sales, and Google Calendar Integration Tests (Épica 6)');

  const testOperatorEmail = `op_${Date.now()}@crmsofiamanager.com.br`;
  const testAdminEmail = `admin_${Date.now()}@crmsofiamanager.com.br`;
  const testClientEmail = `client_${Date.now()}@crmsofiamanager.com.br`;
  const testPassword = 'Password123!';

  let operatorUser = null;
  let adminUser = null;
  let clientUser = null;
  
  let operatorSession = null;
  let adminSession = null;
  let clientSession = null;
  
  let clientDbClient = null;

  let clientRecord = null;
  let picanhaProduto = null;
  let garlicBreadProduto = null;
  let firstPedido = null;
  let secondPedido = null;

  // Track logs during execution to verify LGPD Audit (no PII leaking in logs)
  let loggedOutputs = [];
  const originalConsoleError = console.error;
  const originalConsoleWarn = console.warn;
  const originalConsoleLog = console.log;

  console.error = (...args) => {
    loggedOutputs.push(args.join(' '));
    originalConsoleError.apply(console, args);
  };
  console.warn = (...args) => {
    loggedOutputs.push(args.join(' '));
    originalConsoleWarn.apply(console, args);
  };
  console.log = (...args) => {
    loggedOutputs.push(args.join(' '));
    originalConsoleLog.apply(console, args);
  };

  try {
    // ----------------------------------------------------
    // SETUP: Create Test Users & Profiles & Clients
    // ----------------------------------------------------
    console.log('Setting up test users in Supabase Auth...');

    // 1. Create Vendedor (Operator) User
    const { data: opData, error: opCreateError } = await adminClient.auth.admin.createUser({
      email: testOperatorEmail,
      password: testPassword,
      email_confirm: true,
      user_metadata: { nome: 'Vendedor Teste' }
    });
    if (opCreateError) throw opCreateError;
    operatorUser = opData.user;

    const { error: opProfileError } = await adminClient
      .from('perfis')
      .update({ funcao: 'vendedor', ativo: true })
      .eq('id', operatorUser.id);
    if (opProfileError) throw opProfileError;

    // 2. Create Admin User
    const { data: adData, error: adCreateError } = await adminClient.auth.admin.createUser({
      email: testAdminEmail,
      password: testPassword,
      email_confirm: true,
      user_metadata: { nome: 'Admin Teste' }
    });
    if (adCreateError) throw adCreateError;
    adminUser = adData.user;

    const { error: adProfileError } = await adminClient
      .from('perfis')
      .update({ funcao: 'admin', ativo: true })
      .eq('id', adminUser.id);
    if (adProfileError) throw adProfileError;

    // 3. Create Client User
    const { data: clData, error: clCreateError } = await adminClient.auth.admin.createUser({
      email: testClientEmail,
      password: testPassword,
      email_confirm: true,
      user_metadata: { nome: 'Sofia Client Test' }
    });
    if (clCreateError) throw clCreateError;
    clientUser = clData.user;

    logSuccess('Created operator and client auth users.');

    // Log in to get sessions
    const { data: opLogin, error: opLoginError } = await anonClient.auth.signInWithPassword({
      email: testOperatorEmail,
      password: testPassword
    });
    if (opLoginError) throw opLoginError;
    operatorSession = opLogin.session;

    const { data: adLogin, error: adLoginError } = await anonClient.auth.signInWithPassword({
      email: testAdminEmail,
      password: testPassword
    });
    if (adLoginError) throw adLoginError;
    adminSession = adLogin.session;

    const { data: clLogin, error: clLoginError } = await anonClient.auth.signInWithPassword({
      email: testClientEmail,
      password: testPassword
    });
    if (clLoginError) throw clLoginError;
    clientSession = clLogin.session;

    clientDbClient = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
    await clientDbClient.auth.setSession(clientSession);

    // Delete conflicting client and its orders from previous failed runs if any
    const { data: existingClient } = await adminClient
      .from('clientes')
      .select('id')
      .eq('telefone', '5541999991234')
      .maybeSingle();

    if (existingClient) {
      await adminClient.from('pedidos').delete().eq('cliente_id', existingClient.id);
      await adminClient.from('clientes').delete().eq('id', existingClient.id);
    }

    // Create client record (Curitiba number constraint)
    const { data: cli, error: cliError } = await adminClient
      .from('clientes')
      .insert({
        usuario_id: clientUser.id,
        nome: 'Maria da Silva',
        telefone: '5541999991234',
        endereco: 'Rua XV de Novembro, 1000'
      })
      .select()
      .single();
    if (cliError) throw cliError;
    clientRecord = cli;

    logSuccess('Initialized client record with Curitiba phone constraint.');

    // ----------------------------------------------------
    // Scenario 1: Update Client CRM Metadata
    // ----------------------------------------------------
    logSection('Scenario 1: Update Client CRM Metadata (atualizarClienteCrm)');
    
    // Log in as Vendedor
    setSessionCookies(operatorSession);
    const updateResult = await atualizarClienteCrm(clientRecord.id, {
      endereco: 'Avenida Sete de Setembro, 2500',
      tags: ['vip', 'premium'],
      notas: 'Prefere receber carne bem embalada e quente.',
      score: 85
    });

    if (!updateResult.success) {
      throw new Error(`Failed to update CRM data: ${updateResult.error}`);
    }

    // Verify in database
    const { data: cliVerify, error: verifyError } = await adminClient
      .from('clientes')
      .select('*')
      .eq('id', clientRecord.id)
      .single();

    if (verifyError || !cliVerify) throw verifyError;
    if (cliVerify.endereco !== 'Avenida Sete de Setembro, 2500') throw new Error('Address not updated correctly');
    if (cliVerify.score !== 85) throw new Error('Score not updated correctly');
    if (!cliVerify.tags.includes('vip') || !cliVerify.tags.includes('premium')) throw new Error('Tags not updated correctly');
    if (cliVerify.notas !== 'Prefere receber carne bem embalada e quente.') throw new Error('Notas not updated correctly');

    logSuccess('CRM metadata updated and verified in database.');

    // ----------------------------------------------------
    // Scenario 2: Create Operator Order & Calculate Totals
    // ----------------------------------------------------
    logSection('Scenario 2: Create Operator Order & Calculate Totals (criarPedidoOperador)');

    // We must create products as Admin since vendedor cannot write products
    setSessionCookies(adminSession);
    const prod1Res = await criarProduto({
      nome: 'Picanha Uruguaia 1kg',
      descricao: 'Carne nobre e macia grelhada na brasa',
      preco_centavos: 12000, // R$ 120,00
      ativo: true
    });
    if (!prod1Res.success) throw new Error(`Failed to create product 1: ${prod1Res.error}`);
    picanhaProduto = prod1Res.data;

    const prod2Res = await criarProduto({
      nome: 'Pão de Alho Especial',
      descricao: 'Pão recheado com queijo e alho',
      preco_centavos: 2500, // R$ 25,00
      ativo: true
    });
    if (!prod2Res.success) throw new Error(`Failed to create product 2: ${prod2Res.error}`);
    garlicBreadProduto = prod2Res.data;

    logSuccess('Catalog products created successfully.');

    // Now, create order as Vendedor
    setSessionCookies(operatorSession);
    const orderRes = await criarPedidoOperador({
      cliente_id: clientRecord.id,
      tipo_entrega: 'entrega',
      endereco_entrega: 'Avenida Sete de Setembro, 2500',
      taxa_entrega_centavos: 1500, // R$ 15,00
      meio_pagamento: 'pix',
      itens: [
        { produto_id: picanhaProduto.id, quantidade: 1 }, // 1 * 12000 = 12000 centavos
        { produto_id: garlicBreadProduto.id, quantidade: 2 } // 2 * 2500 = 5000 centavos
      ]
    });

    if (!orderRes.success) {
      throw new Error(`Failed to create order as operator: ${orderRes.error}`);
    }
    firstPedido = orderRes.data;

    // Verify calculated totals: total_produtos = 17000, total_pedido = 18500
    const { data: dbOrder, error: dbOrderError } = await adminClient
      .from('pedidos')
      .select('*, itens:itens_pedido(*)')
      .eq('id', firstPedido.id)
      .single();

    if (dbOrderError || !dbOrder) throw dbOrderError;
    if (dbOrder.status !== 'novo') throw new Error(`Expected status 'novo', got ${dbOrder.status}`);
    if (dbOrder.total_produtos_centavos !== 17000) {
      throw new Error(`Expected total_produtos_centavos = 17000, got ${dbOrder.total_produtos_centavos}`);
    }
    if (dbOrder.total_pedido_centavos !== 18500) {
      throw new Error(`Expected total_pedido_centavos = 18500, got ${dbOrder.total_pedido_centavos}`);
    }
    if (dbOrder.itens.length !== 2) throw new Error(`Expected 2 items, got ${dbOrder.itens.length}`);

    logSuccess('Order created successfully. Calculated totals verified in centavos (R$ 185,00 total).');

    // ----------------------------------------------------
    // Scenario 3: Confirm Order & Google Calendar (Mock Mode)
    // ----------------------------------------------------
    logSection('Scenario 3: Confirm Order in Calendar Mock Mode');

    // Ensure we are in Mock Mode for this test scenario
    process.env.GOOGLE_CLIENT_EMAIL = 'placeholder-email';
    process.env.GOOGLE_PRIVATE_KEY = 'placeholder-key';
    process.env.GOOGLE_CALENDAR_ID = 'placeholder-id';

    const confirmRes = await confirmarPedidoOperador(firstPedido.id);
    if (!confirmRes.success) {
      throw new Error(`Failed to confirm order in mock mode: ${confirmRes.error}`);
    }

    // Verify status updated to 'confirmado' and google_event_id populated
    const { data: confirmedOrder, error: confErr } = await adminClient
      .from('pedidos')
      .select('*')
      .eq('id', firstPedido.id)
      .single();

    if (confErr || !confirmedOrder) throw confErr;
    if (confirmedOrder.status !== 'confirmado') {
      throw new Error(`Expected status 'confirmado', got ${confirmedOrder.status}`);
    }
    if (!confirmedOrder.google_event_id || !confirmedOrder.google_event_id.startsWith('mock-event-id-')) {
      throw new Error(`Expected mock google_event_id starting with 'mock-event-id-', got ${confirmedOrder.google_event_id}`);
    }

    logSuccess(`Order confirmed and scheduled in Mock Mode. google_event_id: ${confirmedOrder.google_event_id}`);

    // ----------------------------------------------------
    // Scenario 4: Resilient Google Calendar Failure handling
    // ----------------------------------------------------
    logSection('Scenario 4: Calendar Failure Resilience (Invalid Environment Keys)');

    // Create a second order to test failure
    const secondOrderRes = await criarPedidoOperador({
      cliente_id: clientRecord.id,
      tipo_entrega: 'retirada',
      taxa_entrega_centavos: 0,
      meio_pagamento: 'dinheiro',
      itens: [
        { produto_id: picanhaProduto.id, quantidade: 2 } // 24000 centavos
      ]
    });
    if (!secondOrderRes.success) throw new Error(`Failed to create second order: ${secondOrderRes.error}`);
    secondPedido = secondOrderRes.data;

    // Force API Call to run but fail with invalid credentials (not placeholder, so it doesn't trigger mock mode)
    process.env.GOOGLE_CLIENT_EMAIL = 'invalid-email-format-not-mock@crmsofiamanager.com.br';
    process.env.GOOGLE_PRIVATE_KEY = 'invalid-key-data-not-mock';
    process.env.GOOGLE_CALENDAR_ID = 'invalid-calendar-id-not-mock';

    console.log('Attempting to confirm order with corrupted/invalid Calendar environment keys...');
    
    const confirmFailRes = await confirmarPedidoOperador(secondPedido.id);
    if (!confirmFailRes.success) {
      throw new Error(`Resilience Failure: Action returned error instead of recovering: ${confirmFailRes.error}`);
    }

    // Verify order is STILL confirmed in database and google_event_id is NULL
    const { data: resilientOrder, error: resErr } = await adminClient
      .from('pedidos')
      .select('*')
      .eq('id', secondPedido.id)
      .single();

    if (resErr || !resilientOrder) throw resErr;
    if (resilientOrder.status !== 'confirmado') {
      throw new Error(`Expected status 'confirmado' for resilient order, got ${resilientOrder.status}`);
    }
    if (resilientOrder.google_event_id !== null) {
      throw new Error(`Expected google_event_id = null for failed API connection, got ${resilientOrder.google_event_id}`);
    }

    logSuccess('Resilience Verified: The order status updated to confirmed even though Google Calendar connection failed.');

    // ----------------------------------------------------
    // Scenario 5: Security Blocks & RLS Policies
    // ----------------------------------------------------
    logSection('Scenario 5: Security & RLS Access Enforcement');

    // Define cookies for client user
    setSessionCookies(clientSession);

    // Test that client is blocked from executing Operator Actions like criarPedidoOperador or confirmarPedidoOperador:
    const clientCreateOrderRes = await criarPedidoOperador({
      cliente_id: clientRecord.id,
      tipo_entrega: 'retirada',
      taxa_entrega_centavos: 0,
      meio_pagamento: 'pix',
      itens: [{ produto_id: picanhaProduto.id, quantidade: 1 }]
    });

    if (clientCreateOrderRes.success) {
      throw new Error('Security Breach: Client was able to execute criarPedidoOperador Server Action');
    }
    logSuccess(`Client successfully blocked from executing criarPedidoOperador. Error: ${clientCreateOrderRes.error}`);

    const clientConfirmOrderRes = await confirmarPedidoOperador(firstPedido.id);
    if (clientConfirmOrderRes.success) {
      throw new Error('Security Breach: Client was able to execute confirmarPedidoOperador Server Action');
    }
    logSuccess(`Client successfully blocked from executing confirmarPedidoOperador. Error: ${clientConfirmOrderRes.error}`);

    // Test RLS: Client direct write to public.produtos table
    console.log('Verifying client user RLS block on direct writes to public.produtos table...');
    const { error: clientProdInsertError } = await clientDbClient
      .from('produtos')
      .insert({ nome: 'Hacker Meat', preco_centavos: 99999 });

    if (!clientProdInsertError) {
      throw new Error('Security Breach: Client was able to insert directly into public.produtos table');
    }
    logSuccess(`Client successfully blocked by RLS on public.produtos. Error: ${clientProdInsertError.message}`);

    // Test RLS: Client direct write to public.pedidos table
    console.log('Verifying client user RLS block on direct writes to public.pedidos table...');
    const { error: clientOrderInsertError } = await clientDbClient
      .from('pedidos')
      .insert({
        cliente_id: clientRecord.id,
        status: 'confirmado',
        tipo_entrega: 'retirada',
        total_produtos_centavos: 100,
        total_pedido_centavos: 100,
        meio_pagamento: 'pix'
      });

    if (!clientOrderInsertError) {
      throw new Error('Security Breach: Client was able to insert directly into public.pedidos table');
    }
    logSuccess(`Client successfully blocked by RLS on public.pedidos. Error: ${clientOrderInsertError.message}`);

    // ----------------------------------------------------
    // Scenario 6: Log Compliance Audit
    // ----------------------------------------------------
    logSection('Scenario 6: Log Compliance Audit (No PII Leaks)');

    // Scan through all logged outputs
    const piiFound = loggedOutputs.filter(output => {
      // Check for client's name or plain phone or notes
      const hasName = output.includes('Maria da Silva');
      const hasRawPhone = output.includes('5541999991234');
      const hasNotes = output.includes('carne bem embalada');
      return hasName || hasRawPhone || hasNotes;
    });

    if (piiFound.length > 0) {
      logError('PII Leak detected in logs!', piiFound);
      throw new Error('Security Compliance Failure: Logs contain raw customer PII.');
    }

    logSuccess('Compliance Audit Passed: Absolutely zero customer PII was found in logs.');

    logSection('All Integration, Security, and Resilience Tests Passed (100% SUCCESS)');

  } catch (err) {
    logError('An integration test failed!', err.message || err);
    process.exitCode = 1;
  } finally {
    // Restore console methods
    console.error = originalConsoleError;
    console.warn = originalConsoleWarn;
    console.log = originalConsoleLog;

    // ----------------------------------------------------
    // CLEANUP: Reset Database State & Delete Users
    // ----------------------------------------------------
    console.log('\nCleaning up integration test resources...');
    try {
      // 1. Delete orders (will cascade and delete items_pedido)
      if (firstPedido) {
        await adminClient.from('pedidos').delete().eq('id', firstPedido.id);
      }
      if (secondPedido) {
        await adminClient.from('pedidos').delete().eq('id', secondPedido.id);
      }

      // 2. Delete products
      if (picanhaProduto) {
        await adminClient.from('produtos').delete().eq('id', picanhaProduto.id);
      }
      if (garlicBreadProduto) {
        await adminClient.from('produtos').delete().eq('id', garlicBreadProduto.id);
      }

      // 3. Delete client records
      if (clientRecord) {
        await adminClient.from('clientes').delete().eq('id', clientRecord.id);
      }

      // 4. Delete auth users
      if (operatorUser) {
        await adminClient.auth.admin.deleteUser(operatorUser.id);
      }
      if (adminUser) {
        await adminClient.auth.admin.deleteUser(adminUser.id);
      }
      if (clientUser) {
        await adminClient.auth.admin.deleteUser(clientUser.id);
      }
      logSuccess('Test data cleaned up successfully.');
    } catch (cleanupErr) {
      logError('Failed to run final cleanup:', cleanupErr.message || cleanupErr);
    }
  }
}

runTests();
