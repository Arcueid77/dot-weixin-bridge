import test from 'node:test';
import assert from 'node:assert/strict';
import {createProvider} from '../src/provider.js';

const credentials = {ownerId: 'owner@im.wechat', conversationId: 'owner@im.wechat', botId: 'bot@im.bot', botToken: 'synthetic-token', routeTag: 'synthetic-route'};
const response = value => new Response(JSON.stringify(value), {status: 200});
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return {promise, resolve}; }
function stateFixture(cursor = '') {
  const values = new Map([['cursor', cursor]]);
  return {get: key => values.get(key), set: (key, value) => values.set(key, value), delete: key => values.delete(key)};
}
const event = overrides => ({message_id: '18446744073709551613', seq: '12', from_user_id: credentials.ownerId,
  to_user_id: credentials.botId, message_type: 1, message_state: 2, context_token: 'private-context', create_time_ms: Date.now(),
  item_list: [{type: 1, text_item: {text: 'fixture text'}}], ...overrides});
function waitForAbort(signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error('fixture-aborted'));
    signal.addEventListener('abort', () => reject(new Error('fixture-aborted')), {once: true});
  });
}

test('does not advance the persisted cursor before durable ingestion finishes', async () => {
  const delivered = deferred(); const release = deferred(); const saved = deferred();
  const state = stateFixture('previous'); const messages = []; let calls = 0;
  const originalSet = state.set; state.set = (key, value) => { originalSet(key, value); saved.resolve(); };
  const provider = createProvider({credentials, state, onMessage: async message => {
    messages.push(message); delivered.resolve(); await release.promise;
  }, fetch: async (url, options) => {
    assert.equal(url, 'https://ilinkai.weixin.qq.com/ilink/bot/getupdates');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.AuthorizationType, 'ilink_bot_token');
    assert.equal(options.headers.Authorization, 'Bearer synthetic-token');
    assert.equal(options.headers.SKRouteTag, 'synthetic-route');
    if (++calls > 1) return waitForAbort(options.signal);
    assert.equal(JSON.parse(options.body).get_updates_buf, 'previous');
    return response({ret: 0, msgs: [event()], get_updates_buf: 'next'});
  }});
  await provider.start(); await delivered.promise;
  assert.equal(state.get('cursor'), 'previous');
  release.resolve(); await saved.promise;
  assert.equal(state.get('cursor'), 'next');
  assert.equal(messages[0].senderId, credentials.ownerId);
  assert.equal(messages[0].conversationId, credentials.ownerId);
  assert.equal(messages[0].replyContext.contextToken, 'private-context');
  assert.equal(provider.status().connected, true);
  await provider.stop(); assert.equal(provider.status().connected, false);
});

test('ingestion failure retains old cursor and stop cancels its recovery wait', async () => {
  const failed = deferred(); const state = stateFixture('keep');
  const provider = createProvider({credentials, state, onMessage: async () => { failed.resolve(); throw new Error('private fixture'); },
    fetch: async () => response({ret: 0, msgs: [event()], get_updates_buf: 'do-not-save'})});
  await provider.start(); await failed.promise; await provider.stop();
  assert.equal(state.get('cursor'), 'keep');
});

test('bot, group, wrong peer/account, unfinished and missing context messages are excluded', async () => {
  const saved = deferred(); const state = stateFixture(); const messages = [];
  state.set = () => saved.resolve();
  const invalid = [event({message_type: 2}), event({group_id: 'group@chatroom'}), event({from_user_id: 'other'}),
    event({to_user_id: 'otherbot'}), event({message_state: 1}), event({context_token: ''})];
  const provider = createProvider({credentials, state, onMessage: async message => messages.push(message),
    fetch: async () => response({ret: 0, msgs: invalid, get_updates_buf: 'done'})});
  await provider.start(); await saved.promise; await provider.stop(); assert.deepEqual(messages, []);
});

test('voice transcripts are text and media stays metadata without downloading any URL', async () => {
  const got = deferred(); const messages = [];
  const provider = createProvider({credentials, state: stateFixture(), onMessage: async message => { messages.push(message); got.resolve(); },
    fetch: async () => response({ret: 0, msgs: [event({item_list: [
      {type: 3, voice_item: {text: 'gateway transcript', media: {url: 'https://invalid.example/private'}}},
      {type: 4, file_item: {file_name: 'report.pdf', media: {url: 'http://127.0.0.1/private'}}},
    ]})], get_updates_buf: 'done'})});
  await provider.start(); await got.promise; await provider.stop();
  assert.equal(messages[0].text, 'gateway transcript');
  assert.deepEqual(messages[0].attachments, [{kind: 'audio'}, {kind: 'file', name: 'report.pdf'}]);
  assert.equal(JSON.stringify(messages).includes('invalid.example'), false);
});

test('uint64 numeric IDs stay distinct without Number rounding', async () => {
  const done = deferred(); const messages = [];
  const first = JSON.stringify(event()).replace('"18446744073709551613"', '18446744073709551613');
  const second = JSON.stringify(event({message_id: '18446744073709551614'})).replace('"18446744073709551614"', '18446744073709551614');
  const provider = createProvider({credentials, state: stateFixture(), onMessage: async message => {
    messages.push(message); if (messages.length === 2) done.resolve();
  }, fetch: async () => new Response(`{"ret":0,"msgs":[${first},${second}],"get_updates_buf":"next"}`)});
  await provider.start(); await done.promise; await provider.stop();
  assert.notEqual(messages[0].id, messages[1].id);
});

test('expired or denied login stops polling and exposes only bounded status', async () => {
  for (const denied of [response({ret: -1, errcode: -14, errmsg: 'private details'}), new Response('private details', {status: 401})]) {
    const called = deferred(); let calls = 0;
    const provider = createProvider({credentials, state: stateFixture(), onMessage: async () => assert.fail('not authorized'),
      fetch: async () => { calls++; called.resolve(); return denied; }});
    await provider.start(); await called.promise;
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(provider.status(), {connected: false, needsLogin: true});
    assert.equal(calls, 1); await provider.stop();
  }
});

test('reply goes once to the stored owner with stable client ID and original context', async () => {
  let sent; let sends = 0;
  const provider = createProvider({credentials, state: stateFixture(), onMessage: async () => {}, fetch: async (url, options) => {
    if (url.endsWith('/getupdates')) return waitForAbort(options.signal);
    sends++; sent = {url, options}; return response({ret: 0, message_id: 'reply-id'});
  }});
  await provider.start();
  const result = await provider.sendReply({message: {senderId: credentials.ownerId, conversationId: credentials.ownerId,
    replyContext: {contextToken: 'original-context'}}, text: 'reply text', idempotencyKey: 'stable-key'});
  assert.equal(sends, 1); assert.equal(result.providerMessageId, 'reply-id');
  assert.equal(sent.url, 'https://ilinkai.weixin.qq.com/ilink/bot/sendmessage');
  const body = JSON.parse(sent.options.body);
  assert.equal(body.msg.to_user_id, credentials.ownerId); assert.equal(body.msg.context_token, 'original-context');
  assert.deepEqual(body.msg.item_list, [{type: 1, text_item: {text: 'reply text'}}]);
  assert.match(body.msg.client_id, /^dot-[a-f0-9]{32}$/u);
  await provider.stop();
});

test('send errors are sanitized and never retried', async () => {
  let sends = 0;
  const provider = createProvider({credentials, state: stateFixture(), onMessage: async () => {}, fetch: async (url, options) => {
    if (url.endsWith('/getupdates')) return waitForAbort(options.signal);
    sends++; throw new Error('Bearer private-fixture');
  }});
  await provider.start();
  await assert.rejects(provider.sendReply({message: {senderId: credentials.ownerId, conversationId: credentials.ownerId,
    replyContext: {contextToken: 'ctx'}}, text: 'reply', idempotencyKey: 'key'}), {message: 'Weixin provider request failed.'});
  assert.equal(sends, 1); await provider.stop();
});

test('refuses group configuration, wrong recipients and oversized replies without a send', async () => {
  assert.throws(() => createProvider({credentials: {...credentials, ownerId: 'group@chatroom', conversationId: 'group@chatroom'}}));
  let sends = 0;
  const provider = createProvider({credentials, state: stateFixture(), onMessage: async () => {}, fetch: async (url, options) => {
    if (url.endsWith('/getupdates')) return waitForAbort(options.signal); sends++; return response({ret: 0});
  }});
  await provider.start();
  await assert.rejects(provider.sendReply({message: {senderId: 'other', conversationId: 'other', replyContext: {contextToken: 'ctx'}}, text: 'test', idempotencyKey: 'key'}));
  await assert.rejects(provider.sendReply({message: {senderId: credentials.ownerId, conversationId: credentials.ownerId,
    replyContext: {contextToken: 'ctx'}}, text: 'x'.repeat(3801), idempotencyKey: 'key'}));
  assert.equal(sends, 0); await provider.stop();
});
