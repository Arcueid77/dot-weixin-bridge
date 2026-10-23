import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {PassThrough} from 'node:stream';
import {loginWithQr} from '../src/login.js';
import {runLogin, readHiddenCode} from '../scripts/login.js';
import {readPrivateFile} from '@dot-bridge/core/platform/private-files.js';
import {privateMkdtempSync, assertPrivateFixture, cleanupPrivateFixture} from '@dot-bridge/core/platform/test-fixtures.js';

const origin = 'https://ilinkai.weixin.qq.com';
const qr = {qrcode: 'fixture-qr', qrcode_img_content: 'https://example.invalid/synthetic-qr'};
const confirmed = {status: 'confirmed', bot_token: 'fixture-only-token', ilink_bot_id: 'fixture@im.bot',
  ilink_user_id: 'fixture@im.wechat', baseurl: origin};
const expected = {ownerId: confirmed.ilink_user_id, conversationId: confirmed.ilink_user_id,
  botId: confirmed.ilink_bot_id, botToken: confirmed.bot_token};
const response = value => new Response(JSON.stringify(value));
const reason = expected => error => error.reason === expected && error.message === 'Weixin login did not complete.';
const destination = path.join(os.tmpdir(), 'synthetic-weixin.credentials.json');
const flags = ['--credentials-file', destination, '--confirm-private-storage', '--confirm-stopped'];
function server(values, options = {}) {
  const calls = []; let now = 100000;
  const config = {confirmStopped: true, clock: () => now, showQr: async () => {},
    wait: async ms => { now += ms; }, fetch: async (url, init) => {
      calls.push({url, init});
      if (!values.length) throw Error('unexpected request with private details');
      const value = values.shift(); return value instanceof Response ? value : response(value);
    }, ...options};
  return {config, calls, advance: ms => { now += ms; }};
}
function terminal() {
  let text = ''; return {isTTY: true, write(value) { text += value; }, text: () => text};
}
function uiFixture() {
  const shown = []; let closed = false;
  return {shown, get closed() { return closed; }, showQr: async value => { shown.push(value); }, close: () => { closed = true; }};
}

test('official confirmed login binds the authenticated scanning owner without consuming any messages', async () => {
  const shown = [], states = [];
  const {config, calls} = server([qr, {status: 'wait'}, {status: 'scaned'}, confirmed],
    {showQr: async value => { shown.push(value); }, onState: value => { states.push(value); }});
  assert.deepEqual(await loginWithQr(config), expected);
  assert.deepEqual(shown, [qr.qrcode_img_content]); assert.deepEqual(states, ['scanned']);
  assert.equal(calls.length, 4);
  assert.equal(calls[0].url, origin + '/ilink/bot/get_bot_qrcode?bot_type=3');
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].init.body), {local_token_list: []});
  for (const {url, init} of calls) {
    assert.equal(new URL(url).origin, origin); assert.equal(init.redirect, 'error'); assert.equal(init.credentials, 'omit');
    assert.equal(init.headers.Authorization, undefined); assert.equal(url.includes('getupdates'), false);
  }
  assert.equal(calls[1].init.method, 'GET');
});

test('explicit stopped confirmation and display callback are required before any request', async () => {
  const {config, calls} = server([]);
  await assert.rejects(loginWithQr({...config, confirmStopped: false}), reason('confirmation_required'));
  await assert.rejects(loginWithQr({...config, showQr: undefined}), reason('qr_display_unavailable'));
  assert.equal(calls.length, 0);
});

test('confirmed status without a complete private owner, bot, token and fixed API origin is not a binding', async () => {
  const cases = [
    [{ilink_user_id: undefined}, 'owner_evidence_missing'], [{ilink_user_id: ''}, 'owner_evidence_missing'],
    [{ilink_user_id: 'other@chatroom'}, 'owner_evidence_missing'], [{ilink_user_id: confirmed.ilink_bot_id}, 'owner_evidence_missing'],
    [{ilink_user_id: 'owner\nprivate'}, 'owner_evidence_missing'], [{ilink_user_id: 'https://private.example'}, 'owner_evidence_missing'],
    [{ilink_bot_id: undefined}, 'login_response_invalid'], [{bot_token: ''}, 'login_response_invalid'],
    [{bot_token: 'private\nBearer'}, 'login_response_invalid'], [{baseurl: undefined}, 'unsupported_login_region'],
    [{baseurl: 'https://ilinkai.weixin.qq.com.evil.invalid/'}, 'unsupported_login_region'],
    [{baseurl: 'https://ilinkai.weixin.qq.com/private'}, 'unsupported_login_region'],
    [{baseurl: 'http://ilinkai.weixin.qq.com'}, 'unsupported_login_region'],
  ];
  for (const [change, expectedReason] of cases) {
    const {config} = server([qr, {...confirmed, ...change}]);
    await assert.rejects(loginWithQr(config), reason(expectedReason));
  }
  assert.deepEqual(await loginWithQr(server([qr, {...confirmed, baseurl: origin + '/'}]).config), expected);
});

test('redirect, expired, blocked and already-bound states fail once without switching host or refreshing', async () => {
  for (const [status, failure] of [['scaned_but_redirect', 'unsupported_login_region'], ['expired', 'login_expired'],
    ['verify_code_blocked', 'verification_blocked'], ['binded_redirect', 'already_bound'], ['unrecognized-private-status', 'login_response_invalid']]) {
    const {config, calls} = server([qr, {status, redirect_host: 'private.invalid', bot_token: 'private'}]);
    await assert.rejects(loginWithQr(config), reason(failure));
    assert.equal(calls.length, 2);
  }
});

test('response bodies, UTF-8, API errors and redirect results are bounded and sanitized', async () => {
  const invalid = [new Response('private', {status: 302}), new Response('private', {headers: {'content-length': '32769'}}),
    new Response('x'.repeat(32769)), new Response(Buffer.from([0xff])), response([]), response({ret: 9, message: 'private'}),
    response({...qr, qrcode_img_content: '\u001b[2Jprivate'}), response({...qr, qrcode: 'x'.repeat(2049)})];
  for (const result of invalid) {
    const {config, calls} = server([result]);
    await assert.rejects(loginWithQr(config), error =>
      ['login_response_invalid', 'login_request_failed'].includes(error.reason) && !error.message.includes('private'));
    assert.equal(calls.length, 1);
  }
  const redirected = response(qr); Object.defineProperty(redirected, 'url', {value: 'https://private.invalid/'});
  await assert.rejects(loginWithQr(server([redirected]).config), reason('login_response_invalid'));
});

test('phone verification uses hidden callback input only in the fixed status request', async () => {
  const inputs = [], {config, calls} = server([qr, {status: 'need_verifycode'}, {status: 'scaned'}, confirmed],
    {readVerificationCode: async ({retry, signal}) => { inputs.push({retry, aborted: signal.aborted}); return '004466'; }});
  assert.deepEqual(await loginWithQr(config), expected);
  assert.deepEqual(inputs, [{retry: false, aborted: false}]);
  assert.equal(new URL(calls[2].url).searchParams.get('verify_code'), '004466');
  assert.equal(new URL(calls[3].url).searchParams.has('verify_code'), false);
  await assert.rejects(loginWithQr(server([qr, {status: 'need_verifycode'}]).config), reason('verification_required'));
  await assert.rejects(loginWithQr(server([qr, {status: 'need_verifycode'}], {readVerificationCode: async () => 'private text'}).config), reason('verification_invalid'));
  let attempts = 0;
  const blocked = server([qr, ...Array.from({length: 4}, () => ({status: 'need_verifycode'}))],
    {readVerificationCode: async () => { attempts++; return '123456'; }});
  await assert.rejects(loginWithQr(blocked.config), reason('verification_blocked'));
  assert.equal(attempts, 3); assert.equal(blocked.calls.length, 5);
});

test('expiry or cancellation while displaying or polling prevents returning credentials', async () => {
  const expired = server([qr], {showQr: async () => expired.advance(300000)});
  await assert.rejects(loginWithQr(expired.config), reason('login_expired')); assert.equal(expired.calls.length, 1);
  const controller = new AbortController();
  const cancelled = server([qr], {signal: controller.signal, showQr: async () => controller.abort()});
  await assert.rejects(loginWithQr(cancelled.config), reason('login_cancelled'));
  let started; const entered = new Promise(resolve => { started = resolve; }); const pending = new AbortController();
  const run = loginWithQr({confirmStopped: true, signal: pending.signal, showQr: () => {}, fetch: async (url, {signal}) => {
    if (url.includes('get_bot_qrcode')) return response(qr);
    started(); return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(Error('private')), {once: true}));
  }});
  await entered; pending.abort(); await assert.rejects(run, reason('login_cancelled'));
});

test('login CLI checks confirmation, TTY and the no-overwrite private destination before login', async () => {
  let requests = 0; const output = terminal(); const input = {isTTY: true};
  const dependencies = {input, output, login: async () => { requests++; return expected; }, assertDestination: () => {}};
  await assert.rejects(runLogin(flags.slice(0, -1), dependencies), reason('confirmation_required'));
  await assert.rejects(runLogin([...flags, '--confirm-stopped'], dependencies), reason('arguments_invalid'));
  await assert.rejects(runLogin(flags, {...dependencies, output: {isTTY: false}}), reason('interactive_terminal_required'));
  await assert.rejects(runLogin(flags, {...dependencies, assertDestination: () => { throw Error('private path'); }}), reason('private_destination_unavailable'));
  assert.equal(requests, 0); assert.equal(output.text(), '');
});

test('CLI persists only verified credentials and clears the QR UI on success or failure', async () => {
  const output = terminal(), ui = uiFixture(), writes = [];
  const dependencies = {input: {isTTY: true}, output, ui, assertDestination: () => {},
    login: options => loginWithQr({...server([qr, confirmed]).config, ...options}), write: (file, value) => writes.push({file, value})};
  assert.deepEqual(await runLogin(flags, dependencies), {paired: true, credentialsSaved: true});
  assert.equal(ui.closed, true); assert.deepEqual(writes, [{file: destination, value: expected}]);
  assert.ok(!output.text().includes('fixture')); assert.equal(ui.shown.length, 1);
  const failedUi = uiFixture(); let written = false;
  await assert.rejects(runLogin(flags, {...dependencies, ui: failedUi, login: async () => { throw Error('private'); }, write: () => { written = true; }}));
  assert.equal(written, false); assert.equal(failedUi.closed, true);
  const aborted = new AbortController();
  await assert.rejects(runLogin(flags, {...dependencies, ui: uiFixture(), signal: aborted.signal,
    login: async () => { aborted.abort(); return expected; }, write: () => { written = true; }}), reason('login_cancelled'));
  assert.equal(written, false);
});

test('default QR renderer uses only the temporary terminal screen and never prints the login URL', async () => {
  const output = terminal();
  await runLogin(flags, {input: {isTTY: true}, output, assertDestination: () => {}, write: () => {},
    login: options => loginWithQr({...server([qr, confirmed]).config, ...options})});
  assert.ok(output.text().includes('\u001b[?1049h')); assert.ok(output.text().includes('\u001b[?1049l'));
  assert.equal(output.text().includes(qr.qrcode_img_content), false); assert.equal(output.text().includes('fixture-only-token'), false);
});

test('real private writer creates the owner-bound file once and never replaces existing credentials', async t => {
  const directory = privateMkdtempSync(path.join(os.tmpdir(), 'weixin-login-')); cleanupPrivateFixture(t, directory);
  const file = path.join(directory, 'weixin.credentials.json'); const output = terminal(); let logins = 0;
  const args = ['--credentials-file', file, '--confirm-private-storage', '--confirm-stopped'];
  const deps = {input: {isTTY: true}, output, ui: uiFixture(), login: async () => { logins++; return expected; }};
  await runLogin(args, deps); assertPrivateFixture(assert, file, 0o600);
  const bytes = readPrivateFile(file, {maxBytes: 16384});
  try { assert.deepEqual(JSON.parse(bytes), expected); } finally { bytes.fill(0); }
  await assert.rejects(runLogin(args, {...deps, ui: uiFixture()}), reason('private_destination_unavailable'));
  assert.equal(logins, 1); assert.equal(fs.statSync(file).nlink, 1);
});

test('hidden verification input never echoes digits and restores the terminal on completion or cancellation', async () => {
  const input = new PassThrough(); input.isTTY = true; input.isRaw = false; input.setRawMode = value => { input.isRaw = value; };
  const output = terminal(); const pending = readHiddenCode({input, output});
  input.write('00124\b3\r'); assert.equal(await pending, '00123'); assert.equal(input.isRaw, false);
  assert.equal(output.text().includes('00123'), false); assert.equal(input.listenerCount('data'), 0);
  const signal = new AbortController(); const cancelled = readHiddenCode({input, output, signal: signal.signal});
  input.write('5678'); signal.abort(); await assert.rejects(cancelled, reason('login_cancelled'));
  assert.equal(input.isRaw, false); assert.equal(input.listenerCount('data'), 0); assert.equal(output.text().includes('5678'), false);
});
