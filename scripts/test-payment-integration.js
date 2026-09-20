/**
 * Integration & Security Test Suite - Épica 7 (Pedidos & Mercado Pago Integration)
 * Tests Preference Generation (Mock/Real), Webhook Processing, Google Calendar Sync,
 * RLS Security Policies, and LGPD Log Auditing.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert');
const { createClient } = require('@supabase/supabase-js');

// Configuration
const SUPABASE_URL = 'http://127.0.0.1:54321';
const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';
const SERVICE_ROLE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';
const NEXT_APP_URL = 'http://localhost:3000';

process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL;
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = ANON_KEY;
process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_ROLE_KEY;

// Load environment variables from .env if not loaded (without overwriting the emulator vars)
function loadEnv() {
  const envPath = path.resolve(__dirname, '../.env');
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, 'utf8');
    content.split('\n').forEach(line => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return;
      const index = trimmed.indexOf('=');
      if (index === -1) return;
      const key = trimmed.slice(0, index).trim();
      let val = trimmed.slice(index + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!process.env[key]) {
        process.env[key] = val;
      }
    });
  }
}

loadEnv();

// Supabase Admin and Anon clients
const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const anonClient = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });

// Colors for console logging
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

// Setup jiti to compile and import Server Actions and Route Handlers on the fly
const jiti = require('jiti')(__filename, {
  alias: {
    '@': path.resolve(__dirname, '../apps/web/src'),
    'next/headers': path.resolve(__dirname, './mock-headers.js'),
    'next/cache': path.resolve(__dirname, './mock-cache.js')
  }
});

const mockHeaders = require('./mock-headers');
const { gerarPreferenciaPagamento } = jiti('../apps/web/src/app/actions/pedidos');
const { POST: webhookPOST } = jiti('../apps/web/src/app/api/webhooks/mercadopago/route');

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
  logSection('Starting Payment Integration & Security Test Suite (Épica 7)');

  const testUserAEmail = `test_pay_usera_${Date.now()}@crmsofiamanager.com.br`;
  const testUserBEmail = `test_pay_userb_${Date.now()}@crmsofiamanager.com.br`;
  const testPassword = 'Password123!';

  let userASession = null;
  let userBSession = null;
  let clientA = null;
  let clientB = null;

  let userA = null;
  let userB = null;
  let clienteARecord = null;
  let clienteBRecord = null;
  let testProduct = null;

  let createdOrders = [];

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

  // Mock Google Calendar variables in environment to ensure mock fallback triggers
  const oldClientEmail = process.env.GOOGLE_CLIENT_EMAIL;
  const oldPrivateKey = process.env.GOOGLE_PRIVATE_KEY;
  const oldCalendarId = process.env.GOOGLE_CALENDAR_ID;

  process.env.GOOGLE_CLIENT_EMAIL = 'placeholder';
  process.env.GOOGLE_PRIVATE_KEY = 'placeholder';
  process.env.GOOGLE_CALENDAR_ID = 'placeholder';

  // Mock Mercado Pago variables
  const oldMpAccessToken = process.env.MERCADO_PAGO_ACCESS_TOKEN;

  try {
    // ----------------------------------------------------
    // SETUP: Create Test Users and Products
    // ----------------------------------------------------
    console.log('Setting up test users and clients in database...');

    const { data: userAData, error: createAError } = await adminClient.auth.admin.createUser({
      email: testUserAEmail,
      password: testPassword,
      email_confirm: true,
      user_metadata: { nome: 'Cliente Pay A' }
    });
    if (createAError) throw createAError;
    userA = userAData.user;

    const { data: userBData, error: createBError } = await adminClient.auth.admin.createUser({
      email: testUserBEmail,
      password: testPassword,
      email_confirm: true,
      user_metadata: { nome: 'Cliente Pay B' }
    });
    if (createBError) throw createBError;
    userB = userBData.user;

    // Log in to get tokens
    const { data: loginA, error: loginAError } = await anonClient.auth.signInWithPassword({
      email: testUserAEmail,
      password: testPassword
    });
    if (loginAError) throw loginAError;
    userASession = loginA.session;
    clientA = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    await clientA.auth.setSession(userASession);

    const { data: loginB, error: loginBError } = await anonClient.auth.signInWithPassword({
      email: testUserBEmail,
      password: testPassword
    });
    if (loginBError) throw loginBError;
    userBSession = loginB.session;
    clientB = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    await clientB.auth.setSession(userBSession);

    // Create client profile records with valid Curitiba phones
    const { data: cliA, error: errCliA } = await adminClient
      .from('clientes')
      .insert({ usuario_id: userA.id, nome: 'Cliente Pay A', telefone: '5541999991111' })
      .select()
      .single();
    if (errCliA) throw errCliA;
    clienteARecord = cliA;

    const { data: cliB, error: errCliB } = await adminClient
      .from('clientes')
      .insert({ usuario_id: userB.id, nome: 'Cliente Pay B', telefone: '5541999992222' })
      .select()
      .single();
    if (errCliB) throw errCliB;
    clienteBRecord = cliB;

    // Create a test product
    const { data: prod, error: errProd } = await adminClient
      .from('produtos')
      .insert({ nome: `Picanha Teste ${Date.now()}`, preco_centavos: 8900, ativo: true })
      .select()
      .single();
    if (errProd) throw errProd;
    testProduct = prod;

    logSuccess('Test users, profiles, and products setup successfully.');

    // ----------------------------------------------------
    // Scenario 1: Preference Generation in MOCK MODE
    // ----------------------------------------------------
    logSection('Scenario 1: Preference Generation (Mock Mode)');

    // 1. Create a test order for Client A
    const { data: orderMock, error: errOrderMock } = await adminClient
      .from('pedidos')
      .insert({
        cliente_id: clienteARecord.id,
        status: 'novo',
        tipo_entrega: 'entrega',
        endereco_entrega: 'Rua de Teste, 100',
        taxa_entrega_centavos: 1500,
        total_produtos_centavos: 8900,
        total_pedido_centavos: 10400,
        status_pagamento: 'pendente',
        meio_pagamento: 'cartao_credito'
      })
      .select()
      .single();
    if (errOrderMock) throw errOrderMock;
    createdOrders.push(orderMock.id);

    // Insert order item
    const { error: errItemMock } = await adminClient
      .from('itens_pedido')
      .insert({
        pedido_id: orderMock.id,
        produto_id: testProduct.id,
        quantidade: 1,
        preco_unitario_centavos: 8900
      });
    if (errItemMock) throw errItemMock;

    // Trigger mock mode in server action
    process.env.MERCADO_PAGO_ACCESS_TOKEN = 'placeholder';
    setSessionCookies(userASession);

    const resMock = await gerarPreferenciaPagamento(orderMock.id);
    assert.strictEqual(resMock.success, true, 'gerarPreferenciaPagamento failed in mock mode');
    assert.ok(resMock.url.includes(`mock_pref_${orderMock.id}`), 'Returned URL does not contain mock preference ID');

    // Verify it updated the database
    const { data: dbOrderMock } = await adminClient
      .from('pedidos')
      .select('mercado_pago_preferencia_id')
      .eq('id', orderMock.id)
      .single();
    
    assert.strictEqual(dbOrderMock.mercado_pago_preferencia_id, `mock_pref_${orderMock.id}`, 'Mock preference ID not persisted in database');
    logSuccess('Preference generation mock mode verified successfully.');

    // ----------------------------------------------------
    // Scenario 2: Preference Generation in REAL MODE SIMULATION
    // ----------------------------------------------------
    logSection('Scenario 2: Preference Generation (Real Mode Simulation)');

    // 1. Create another test order for Client A
    const { data: orderReal, error: errOrderReal } = await adminClient
      .from('pedidos')
      .insert({
        cliente_id: clienteARecord.id,
        status: 'novo',
        tipo_entrega: 'retirada',
        taxa_entrega_centavos: 0,
        total_produtos_centavos: 8900,
        total_pedido_centavos: 8900,
        status_pagamento: 'pendente',
        meio_pagamento: 'cartao_credito'
      })
      .select()
      .single();
    if (errOrderReal) throw errOrderReal;
    createdOrders.push(orderReal.id);

    const { error: errItemReal } = await adminClient
      .from('itens_pedido')
      .insert({
        pedido_id: orderReal.id,
        produto_id: testProduct.id,
        quantidade: 1,
        preco_unitario_centavos: 8900
      });
    if (errItemReal) throw errItemReal;

    // Set non-placeholder token
    process.env.MERCADO_PAGO_ACCESS_TOKEN = 'APP_USR-test-token-12345';

    // Mock global fetch
    const originalFetch = global.fetch;
    let mockFetchCalled = false;

    global.fetch = async (url, options) => {
      if (url === 'https://api.mercadopago.com/checkout/preferences') {
        mockFetchCalled = true;
        // Verify payload formats
        const body = JSON.parse(options.body);
        assert.strictEqual(body.external_reference, orderReal.id, 'Wrong external_reference sent');
        assert.strictEqual(body.items.length, 1, 'Should have exactly 1 item (no delivery fee)');
        assert.strictEqual(body.items[0].unit_price, 89.00, 'Price should be converted from centavos to decimal');

        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: 'real_pref_999888777',
            init_point: 'https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=real_pref_999888777',
            sandbox_init_point: 'https://sandbox.mercadopago.com.br/checkout/v1/redirect?pref_id=real_pref_999888777'
          }),
          text: async () => '{"id": "real_pref_999888777"}'
        };
      }
      return originalFetch(url, options);
    };

    const resReal = await gerarPreferenciaPagamento(orderReal.id);
    
    // Restore fetch immediately
    global.fetch = originalFetch;

    assert.strictEqual(resReal.success, true, 'gerarPreferenciaPagamento failed in real simulation');
    assert.strictEqual(mockFetchCalled, true, 'Mercado Pago checkout API was not called');
    assert.strictEqual(resReal.url, 'https://sandbox.mercadopago.com.br/checkout/v1/redirect?pref_id=real_pref_999888777');

    // Verify it updated the database
    const { data: dbOrderReal } = await adminClient
      .from('pedidos')
      .select('mercado_pago_preferencia_id')
      .eq('id', orderReal.id)
      .single();
    
    assert.strictEqual(dbOrderReal.mercado_pago_preferencia_id, 'real_pref_999888777', 'Real preference ID not persisted in database');
    logSuccess('Preference generation real mode simulation verified successfully.');

    // ----------------------------------------------------
    // Scenario 3: Webhook Simulation - Approved Payment & GCal Sync
    // ----------------------------------------------------
    logSection('Scenario 3: Webhook Simulation - Approved Payment & GCal Sync');

    // Create a new order to test Webhook Approval
    const { data: orderApproved, error: errOrderApproved } = await adminClient
      .from('pedidos')
      .insert({
        cliente_id: clienteARecord.id,
        status: 'novo',
        tipo_entrega: 'entrega',
        endereco_entrega: 'Rua das Flores, 456',
        taxa_entrega_centavos: 1000,
        total_produtos_centavos: 8900,
        total_pedido_centavos: 9900,
        status_pagamento: 'pendente',
        meio_pagamento: 'pix'
      })
      .select()
      .single();
    if (errOrderApproved) throw errOrderApproved;
    createdOrders.push(orderApproved.id);

    const { error: errItemApproved } = await adminClient
      .from('itens_pedido')
      .insert({
        pedido_id: orderApproved.id,
        produto_id: testProduct.id,
        quantidade: 1,
        preco_unitario_centavos: 8900
      });
    if (errItemApproved) throw errItemApproved;

    // Webhook executes in mock mode because MP token is placeholder
    process.env.MERCADO_PAGO_ACCESS_TOKEN = 'placeholder';

    // Simulate POST request to Webhook route handler
    const approvedWebhookUrl = `${NEXT_APP_URL}/api/webhooks/mercadopago?id=mock_payment_approved_9876&topic=payment&pedidoId=${orderApproved.id}`;
    const reqApproved = new Request(approvedWebhookUrl, { method: 'POST' });

    const respApproved = await webhookPOST(reqApproved);
    assert.strictEqual(respApproved.status, 200, 'Webhook approved POST did not return 200 OK immediately');
    
    const respApprovedJson = await respApproved.json();
    assert.strictEqual(respApprovedJson.status, 'received', 'Response body is incorrect');

    console.log('Waiting 500ms for background processing of approved webhook...');
    await new Promise(resolve => setTimeout(resolve, 550));

    // Assert database changes via service role
    const { data: finalOrderApproved } = await adminClient
      .from('pedidos')
      .select('status, status_pagamento, google_event_id')
      .eq('id', orderApproved.id)
      .single();

    assert.strictEqual(finalOrderApproved.status_pagamento, 'aprovado', 'Webhook did not update status_pagamento to aprovado');
    assert.strictEqual(finalOrderApproved.status, 'confirmado', 'Webhook did not update status to confirmado');
    assert.ok(finalOrderApproved.google_event_id, 'Google Calendar event was not scheduled/updated');
    assert.ok(finalOrderApproved.google_event_id.includes('mock-event-id'), 'Event ID does not contain mock-event-id prefix');

    logSuccess('Webhook approved flow and Google Calendar sync verified successfully.');

    // ----------------------------------------------------
    // Scenario 4: Webhook Simulation - Rejected Payment
    // ----------------------------------------------------
    logSection('Scenario 4: Webhook Simulation - Rejected Payment');

    // Create a new order to test Webhook Rejection
    const { data: orderRejected, error: errOrderRejected } = await adminClient
      .from('pedidos')
      .insert({
        cliente_id: clienteARecord.id,
        status: 'novo',
        tipo_entrega: 'retirada',
        taxa_entrega_centavos: 0,
        total_produtos_centavos: 8900,
        total_pedido_centavos: 8900,
        status_pagamento: 'pendente',
        meio_pagamento: 'pix'
      })
      .select()
      .single();
    if (errOrderRejected) throw errOrderRejected;
    createdOrders.push(orderRejected.id);

    const { error: errItemRejected } = await adminClient
      .from('itens_pedido')
      .insert({
        pedido_id: orderRejected.id,
        produto_id: testProduct.id,
        quantidade: 1,
        preco_unitario_centavos: 8900
      });
    if (errItemRejected) throw errItemRejected;

    // Simulate POST request to Webhook route handler
    const rejectedWebhookUrl = `${NEXT_APP_URL}/api/webhooks/mercadopago?id=mock_payment_rejected_9876&topic=payment&pedidoId=${orderRejected.id}`;
    const reqRejected = new Request(rejectedWebhookUrl, { method: 'POST' });

    const respRejected = await webhookPOST(reqRejected);
    assert.strictEqual(respRejected.status, 200, 'Webhook rejected POST did not return 200 OK immediately');

    console.log('Waiting 500ms for background processing of rejected webhook...');
    await new Promise(resolve => setTimeout(resolve, 550));

    // Assert database changes
    const { data: finalOrderRejected } = await adminClient
      .from('pedidos')
      .select('status, status_pagamento, google_event_id')
      .eq('id', orderRejected.id)
      .single();

    assert.strictEqual(finalOrderRejected.status_pagamento, 'rejeitado', 'Webhook did not update status_pagamento to rejeitado');
    // Rejected payments should NOT modify the order confirmation status (stays 'novo')
    assert.strictEqual(finalOrderRejected.status, 'novo', 'Order status was incorrectly changed for rejected payment');
    assert.strictEqual(finalOrderRejected.google_event_id, null, 'Event should not be scheduled for rejected payment');

    logSuccess('Webhook rejected flow verified successfully.');

    // ----------------------------------------------------
    // Scenario 5: Row Level Security (RLS) Tests
    // ----------------------------------------------------
    logSection('Scenario 5: Row Level Security (RLS) Policies');

    // 1. Verify Client A cannot read Client B's order
    console.log('Verifying standard client cannot read other clients\' orders...');
    // Create an order for Client B
    const { data: orderB, error: errOrderB } = await adminClient
      .from('pedidos')
      .insert({
        cliente_id: clienteBRecord.id,
        status: 'novo',
        tipo_entrega: 'retirada',
        taxa_entrega_centavos: 0,
        total_produtos_centavos: 8900,
        total_pedido_centavos: 8900,
        status_pagamento: 'pendente',
        meio_pagamento: 'pix'
      })
      .select()
      .single();
    if (errOrderB) throw errOrderB;
    createdOrders.push(orderB.id);

    // Client A tries to select Client B's order
    const { data: selectBByA, error: selectBByAError } = await clientA
      .from('pedidos')
      .select('*')
      .eq('id', orderB.id)
      .maybeSingle();

    if (selectBByA) {
      throw new Error('RLS Violation: Client A was able to read Client B\'s order!');
    }
    logSuccess('Standard client is prevented from reading other clients\' orders.');

    // 2. Verify standard client cannot update status, payment status, preference ID, or calendar event ID directly
    console.log('Verifying standard client cannot update critical order fields directly...');
    
    const { data: updateRes, error: updateError } = await clientA
      .from('pedidos')
      .update({
        status_pagamento: 'aprovado',
        status: 'confirmado',
        mercado_pago_preferencia_id: 'hacked_pref',
        google_event_id: 'hacked_event'
      })
      .eq('id', orderMock.id)
      .select();

    // RLS in Supabase blocks client update entirely (either throws or returns 0 rows updated)
    const { data: checkOrderMock } = await adminClient
      .from('pedidos')
      .select('status_pagamento, status, mercado_pago_preferencia_id, google_event_id')
      .eq('id', orderMock.id)
      .single();

    assert.strictEqual(checkOrderMock.status_pagamento, 'pendente', 'RLS Violation: client modified status_pagamento');
    assert.strictEqual(checkOrderMock.mercado_pago_preferencia_id, `mock_pref_${orderMock.id}`, 'RLS Violation: client modified preference ID');
    assert.strictEqual(checkOrderMock.google_event_id, null, 'RLS Violation: client modified google_event_id');

    logSuccess('Standard client is prevented from altering critical columns directly.');

    // ----------------------------------------------------
    // Scenario 6: Log Compliance Audit (No PII Leaks)
    // ----------------------------------------------------
    logSection('Scenario 6: Log Compliance Audit (No PII Leaks)');

    // Scan through all logged outputs to ensure raw names, phone numbers, or tokens are not leaked
    const piiLeaks = loggedOutputs.filter(output => {
      // Check for raw phones or names
      const hasNameA = output.includes('Cliente Pay A');
      const hasPhoneA = output.includes('5541999991111');
      const hasNameB = output.includes('Cliente Pay B');
      const hasPhoneB = output.includes('5541999992222');
      const hasRealToken = output.includes('APP_USR-test-token-12345');
      return hasNameA || hasPhoneA || hasNameB || hasPhoneB || hasRealToken;
    });

    if (piiLeaks.length > 0) {
      logError('PII/Token Leak detected in terminal logs!', piiLeaks);
      throw new Error('Security Compliance Failure: Logs contain raw customer PII or API tokens.');
    }

    logSuccess('Compliance Audit Passed: Absolutely zero customer PII or credentials found in logs.');

    logSection('All Integration, Security, and Resilience Tests Passed (100% SUCCESS)');

  } catch (err) {
    logError('An integration test failed!', err.message || err);
    process.exitCode = 1;
  } finally {
    // Restore console methods
    console.error = originalConsoleError;
    console.warn = originalConsoleWarn;
    console.log = originalConsoleLog;

    // Restore environment variables
    process.env.GOOGLE_CLIENT_EMAIL = oldClientEmail;
    process.env.GOOGLE_PRIVATE_KEY = oldPrivateKey;
    process.env.GOOGLE_CALENDAR_ID = oldCalendarId;
    process.env.MERCADO_PAGO_ACCESS_TOKEN = oldMpAccessToken;

    // ----------------------------------------------------
    // CLEANUP: Reset Database State & Delete Users
    // ----------------------------------------------------
    console.log('\nCleaning up integration test resources...');
    try {
      // 1. Delete created orders (cascades and deletes items_pedido)
      for (const orderId of createdOrders) {
        await adminClient.from('pedidos').delete().eq('id', orderId);
      }

      // 2. Delete test product
      if (testProduct) {
        await adminClient.from('produtos').delete().eq('id', testProduct.id);
      }

      // 3. Delete client records
      if (clienteARecord) {
        await adminClient.from('clientes').delete().eq('id', clienteARecord.id);
      }
      if (clienteBRecord) {
        await adminClient.from('clientes').delete().eq('id', clienteBRecord.id);
      }

      // 4. Delete auth users
      if (userA) {
        await adminClient.auth.admin.deleteUser(userA.id);
      }
      if (userB) {
        await adminClient.auth.admin.deleteUser(userB.id);
      }
      logSuccess('Test data cleaned up successfully.');
    } catch (cleanupErr) {
      logError('Failed to run final cleanup:', cleanupErr.message || cleanupErr);
    }
  }
}

runTests();
