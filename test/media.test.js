import test from 'node:test';
import assert from 'node:assert/strict';
import {createCipheriv, createDecipheriv, createHash} from 'node:crypto';
import {createProvider} from '../src/provider.js';
import {channel} from '../src/channel.js';
import {MAX_MEDIA_BYTES, cdnUrl, validateMediaReply, decryptMedia} from '../src/media.js';
import {encode} from 'silk-wasm';

const credentials = {ownerId: 'fixture@im.wechat', conversationId: 'fixture@im.wechat', botId: 'fixture@im.bot', botToken: 'fixture-token'};
const key = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const response = value => new Response(JSON.stringify(value));
const encrypt = data => { const cipher = createCipheriv('aes-128-ecb', key, null); return Buffer.concat([cipher.update(data), cipher.final()]); };
const media = extra => ({encrypt_query_param: 'fixture-query+/=', aes_key: key.toString('base64'), ...extra});
const raw = items => ({message_id: '42', seq: '7', from_user_id: credentials.ownerId, to_user_id: credentials.botId,
  message_type: 1, message_state: 2, context_token: 'fixture-context', create_time_ms: Date.now(), item_list: items});
const abortable = signal => new Promise((resolve, reject) => {
  if (signal.aborted) reject(new Error('aborted'));
  else signal.addEventListener('abort', () => reject(new Error('aborted')), {once: true});
});
async function fixture(items, serve = async () => new Response(encrypt(png))) {
  const values = new Map();
  const calls = []; let polls = 0; let resolve;
  const incoming = new Promise(done => { resolve = done; });
  const provider = createProvider({credentials,
    state: {get: name => values.get(name), set: (name, value) => values.set(name, value)},
    onMessage: async message => resolve(message), fetch: async (url, options) => {
      if (url.endsWith('/getupdates')) {
        if (polls++) return abortable(options.signal);
        return response({ret: 0, msgs: [raw(items)], get_updates_buf: 'cursor'});
      }
      calls.push({url, options}); return serve(url, options);
    }});
  await provider.start();
  return {provider, message: await incoming, calls};
}

test('encrypted image, SILK and file are read by the aligned private locator only', async () => {
  const silk = Buffer.from((await encode(Buffer.alloc(4800), 24000)).data);
  const file = Buffer.from('fixture document');
  const items = [
    {type: 5, video_item: {media: media()}},
    {type: 2, image_item: {aeskey: key.toString('hex'), media: media({aes_key: undefined})}},
    {type: 3, voice_item: {media: media({aes_key: Buffer.from(key.toString('hex')).toString('base64')}), encode_type: 6}},
    {type: 4, file_item: {media: media(), file_name: 'fixture.pdf', len: String(file.length), md5: createHash('md5').update(file).digest('hex')}},
  ];
  const buffers = [png, silk, file]; let index = 0;
  const {provider, message, calls} = await fixture(items, async () => new Response(encrypt(buffers[index++])));
  try {
    assert.equal(calls.length, 0);
    assert.equal(JSON.stringify(message.attachments).includes('query'), false);
    assert.equal(JSON.stringify(message.attachments).includes(key.toString('hex')), false);
    await assert.rejects(provider.readAttachment({message, attachmentIndex: 0}), /unavailable/u);
    for (const [offset, mimeType] of ['image/png', 'audio/wav', 'application/pdf'].entries()) {
      const result = await provider.readAttachment({message, attachmentIndex: offset + 1});
      if (offset === 1) {
        assert.equal(result.data.toString('ascii', 0, 4), 'RIFF');
        assert.equal(result.data.toString('ascii', 8, 12), 'WAVE');
        assert.equal(result.data.readUInt32LE(24), 24000);
        assert.ok(result.data.length > 44);
      } else assert.deepEqual(result.data, buffers[offset]);
      assert.equal(result.mimeType, mimeType);
    }
    assert.ok(calls.every(({url, options}) => url.startsWith('https://novac2c.cdn.weixin.qq.com/c2c/download?') &&
      options.redirect === 'error' && options.credentials === 'omit' && options.headers === undefined));
  } finally { await provider.stop(); }
});

test('corrupt SILK remains unavailable rather than claiming raw SILK is playable WAV', async () => {
  const {provider, message} = await fixture([{type: 3, voice_item: {media: media(), text: 'reference transcript'}}],
    async () => new Response(encrypt(Buffer.from('\x02#!SILK_V3\nnot a valid stream'))));
  try {
    assert.equal(message.text, 'reference transcript');
    await assert.rejects(provider.readAttachment({message, attachmentIndex: 0}), {message: 'Weixin attachment is unavailable.'});
  } finally { await provider.stop(); }
});

test('file display names match the shared safe basename contract even for legacy stored paths', async () => {
  const {provider, message} = await fixture([{type: 4, file_item: {media: media(), file_name: 'C:\\private\\report.pdf'}}],
    async () => new Response(encrypt(Buffer.from('%PDF-fixture'))));
  try {
    assert.equal(message.attachments[0].name, 'report.pdf');
    assert.equal((await provider.readAttachment({message, attachmentIndex: 0})).name, 'report.pdf');
    message.attachments[0].name = 'x'.repeat(254) + '🌏';
    const name = (await provider.readAttachment({message, attachmentIndex: 0})).name;
    assert.equal(name.length, 255); assert.equal(/\p{Surrogate}/u.test(name), false);
  } finally { await provider.stop(); }
});

test('untrusted full URLs, malformed keys and unsupported sources retain metadata but cannot download', async () => {
  const badUrls = ['http://novac2c.cdn.weixin.qq.com/c2c/download?x=y', 'https://127.0.0.1/c2c/download',
    'https://novac2c.cdn.weixin.qq.com.attacker.test/c2c/download', 'https://user:password@novac2c.cdn.weixin.qq.com/c2c/download',
    'https://novac2c.cdn.weixin.qq.com:8443/c2c/download', 'https://novac2c.cdn.weixin.qq.com/c2c/upload'];
  const items = badUrls.map(full_url => ({type: 2, image_item: {media: media({full_url})}}));
  items.push({type: 3, voice_item: {media: media({aes_key: 'malformed'})}});
  const {provider, message, calls} = await fixture(items);
  try {
    assert.equal(message.attachments.length, items.length);
    assert.deepEqual(message.replyContext.mediaRefs, items.map(() => null));
    for (let attachmentIndex = 0; attachmentIndex < items.length; attachmentIndex++) await assert.rejects(provider.readAttachment({message, attachmentIndex}));
    assert.equal(calls.length, 0);
  } finally { await provider.stop(); }
});

test('owner, index, metadata type and persisted locator policy are checked again before downloading', async () => {
  const {provider, message, calls} = await fixture([{type: 2, image_item: {media: media()}}]);
  try {
    for (const changed of [{...message, senderId: 'other'}, {...message, conversationId: 'other'},
      {...message, attachments: [{kind: 'audio'}]}, {...message, replyContext: {...message.replyContext,
        mediaRefs: [{...message.replyContext.mediaRefs[0], url: 'https://attacker.test/c2c/download'}]}}]) {
      await assert.rejects(provider.readAttachment({message: changed, attachmentIndex: 0}));
    }
    for (const attachmentIndex of [-1, 0.5, '0', 1, 10]) await assert.rejects(provider.readAttachment({message, attachmentIndex}));
    assert.equal(calls.length, 0);
  } finally { await provider.stop(); }
});

test('small unencrypted official images remain supported and private metadata stays bounded', async () => {
  const longQuery = 'a'.repeat(7900);
  const items = Array.from({length: 10}, () => ({type: 2, image_item: {media: {encrypt_query_param: longQuery}}}));
  const {provider, message} = await fixture(items, async () => new Response(png));
  try {
    assert.equal(message.attachments.length, 10);
    assert.ok(JSON.stringify(message.replyContext).length < 65536);
    assert.ok(message.replyContext.mediaRefs.includes(null));
    assert.deepEqual((await provider.readAttachment({message, attachmentIndex: 0})).data, png);
  } finally { await provider.stop(); }
});

test('padding, size and digest failures never return corrupt file bytes', async () => {
  assert.throws(() => decryptMedia(Buffer.alloc(16), key.toString('hex')), /unavailable/u);
  for (const [source, serve] of [
    [{media: media(), len: '14'}, async () => new Response(encrypt(Buffer.from('length mismatch')))],
    [{media: media(), md5: '0'.repeat(32)}, async () => new Response(encrypt(Buffer.from('md5 mismatch')))],
    [{media: media()}, async () => new Response(Buffer.alloc(16), {headers: {'content-length': String(MAX_MEDIA_BYTES + 17)}})],
    [{media: media()}, async () => new Response(Buffer.alloc(MAX_MEDIA_BYTES + 17))],
    [{media: media(), len: String(MAX_MEDIA_BYTES + 1)}, async () => assert.fail('oversize is known before download')],
  ]) {
    const {provider, message} = await fixture([{type: 4, file_item: source}], serve);
    try { await assert.rejects(provider.readAttachment({message, attachmentIndex: 0}), /unavailable/u); }
    finally { await provider.stop(); }
  }
});

test('download errors are sanitized and stopping aborts in-flight media reads', async () => {
  const {provider, message} = await fixture([{type: 2, image_item: {media: media()}}], async (url, options) => abortable(options.signal));
  const read = assert.rejects(provider.readAttachment({message, attachmentIndex: 0}), {message: 'Weixin attachment is unavailable.'});
  await provider.stop(); await read;
  const failing = await fixture([{type: 2, image_item: {media: media()}}], async () => { throw new Error('private CDN locator and key'); });
  try { await assert.rejects(failing.provider.readAttachment({message: failing.message, attachmentIndex: 0}), {message: 'Weixin attachment is unavailable.'}); }
  finally { await failing.provider.stop(); }
});

test('long answers become one complete encrypted UTF-8 file in the original private context', async () => {
  let upload, plain, sent;
  const {provider, message, calls} = await fixture([{type: 1, text_item: {text: 'fixture'}}], async (url, options) => {
    if (url.endsWith('/getuploadurl')) { upload = JSON.parse(options.body); return response({upload_param: 'fixture-upload'}); }
    if (url.includes('/c2c/upload')) {
      const decipher = createDecipheriv('aes-128-ecb', Buffer.from(upload.aeskey, 'hex'), null);
      plain = Buffer.concat([decipher.update(options.body), decipher.final()]);
      return new Response('', {headers: {'x-encrypted-param': 'fixture-download'}});
    }
    sent = JSON.parse(options.body).msg; return response({ret: 0, message_id: 'fixture-sent'});
  });
  try {
    const text = '汉'.repeat(19998) + '🌏';
    await provider.sendReply({message, text, idempotencyKey: 'long'});
    assert.equal(plain.toString('utf8'), text);
    assert.equal(sent.item_list.length, 1);
    assert.equal(sent.item_list[0].type, 4);
    assert.equal(sent.item_list[0].file_item.file_name, 'answer.txt');
    assert.equal(sent.context_token, message.replyContext.contextToken);
    assert.equal(calls.length, 3);
    await assert.rejects(provider.sendReply({message, text: 'x\uD800', idempotencyKey: 'invalid'}));
    await assert.rejects(provider.sendReply({message, text: 'x'.repeat(20001), idempotencyKey: 'large'}));
    assert.equal(calls.length, 3);
  } finally { await provider.stop(); }
});

test('image and file replies use encrypted official upload then exactly one original-context message', async () => {
  for (const type of ['image', 'file']) {
    let upload; let sent; let plaintext;
    const {provider, message, calls} = await fixture([{type: 1, text_item: {text: 'fixture'}}], async (url, options) => {
      if (url.endsWith('/getuploadurl')) { upload = JSON.parse(options.body); return response({upload_param: 'fixture-upload'}); }
      if (url.includes('/c2c/upload')) {
        const decipher = createDecipheriv('aes-128-ecb', Buffer.from(upload.aeskey, 'hex'), null);
        plaintext = Buffer.concat([decipher.update(options.body), decipher.final()]);
        assert.equal(options.headers.Authorization, undefined);
        assert.equal(options.redirect, 'error');
        return new Response('', {headers: {'x-encrypted-param': 'fixture-download'}});
      }
      if (url.endsWith('/sendmessage')) { sent = JSON.parse(options.body).msg; return response({ret: 0, message_id: 'fixture-sent'}); }
      assert.fail('unexpected network request');
    });
    try {
      const data = type === 'image' ? png : Buffer.from('file payload');
      assert.deepEqual(await provider.sendMediaReply({message, media: {type, data, mimeType: type === 'image' ? 'image/png' : 'text/plain', name: 'fixture.txt'}, idempotencyKey: 'stable'}), {providerMessageId: 'fixture-sent'});
      assert.deepEqual(plaintext, data);
      assert.equal(upload.media_type, type === 'image' ? 1 : 3);
      assert.equal(upload.rawsize, data.length); assert.equal(upload.filesize, Math.ceil((data.length + 1) / 16) * 16);
      assert.equal(upload.rawfilemd5, createHash('md5').update(data).digest('hex'));
      assert.equal(calls.length, 3); assert.equal(sent.item_list.length, 1);
      assert.equal(sent.context_token, message.replyContext.contextToken); assert.equal(sent.to_user_id, credentials.ownerId);
      const content = type === 'image' ? sent.item_list[0].image_item : sent.item_list[0].file_item;
      assert.equal(Buffer.from(content.media.aes_key, 'base64').toString(), upload.aeskey);
      assert.equal(content.media.encrypt_query_param, 'fixture-download');
      assert.match(sent.client_id, /^dot-[a-f0-9]{32}$/u);
    } finally { await provider.stop(); }
  }
});

test('uncertain long-answer file delivery never retries or sends the answer as another text message', async () => {
  let sends = 0, uploads = 0;
  const {provider, message} = await fixture([{type: 1, text_item: {text: 'fixture'}}], async (url, options) => {
    if (url.endsWith('/getuploadurl')) return response({upload_param: 'fixture-upload'});
    if (url.includes('/c2c/upload')) { uploads++; return new Response('', {headers: {'x-encrypted-param': 'fixture-download'}}); }
    sends++;
    assert.equal(JSON.parse(options.body).msg.item_list[0].type, 4);
    throw new Error('private uncertain result');
  });
  try {
    await assert.rejects(provider.sendReply({message, text: '汉'.repeat(3801), idempotencyKey: 'long'}));
    assert.equal(uploads, 1); assert.equal(sends, 1);
  } finally { await provider.stop(); }
});

test('unsupported media/captions and wrong peers fail before uploads; no silent voice-as-file substitution', async () => {
  assert.deepEqual(channel.media, {read: ['image', 'audio', 'file'], reply: ['image', 'audio', 'file']});
  assert.equal(channel.maxMediaReplyText, 0);
  const {provider, message, calls} = await fixture([{type: 1, text_item: {text: 'fixture'}}]);
  const valid = {message, media: {type: 'image', data: png, mimeType: 'image/png', name: 'fixture.png'}, idempotencyKey: 'key'};
  try {
    for (const input of [{...valid, text: 'caption'}, {...valid, media: {...valid.media, type: 'audio'}},
      {...valid, media: {...valid.media, data: Buffer.alloc(MAX_MEDIA_BYTES + 1)}},
      {...valid, media: {...valid.media, mimeType: 'image/jpeg'}}, {...valid, media: {...valid.media, name: '../secret.png'}},
      {...valid, message: {...message, senderId: 'other'}}, {...valid, idempotencyKey: ''}]) await assert.rejects(provider.sendMediaReply(input));
    assert.throws(() => validateMediaReply({...valid, text: 'caption'}), /without a text caption/u);
    assert.equal(calls.length, 0);
  } finally { await provider.stop(); }
});

test('hostile upload targets, missing upload headers and uncertain sends are never retried', async () => {
  for (const stage of ['target', 'header', 'upload', 'send']) {
    let sends = 0; let uploads = 0;
    const {provider, message} = await fixture([{type: 1, text_item: {text: 'fixture'}}], async (url) => {
      if (url.endsWith('/getuploadurl')) return response(stage === 'target' ? {upload_full_url: 'https://attacker.test/c2c/upload', upload_param: 'fallback-must-not-be-used'} : {upload_param: 'fixture-upload'});
      if (url.includes('/c2c/upload')) {
        uploads++;
        if (stage === 'upload') throw new Error('private upload location');
        return new Response('', {headers: stage === 'header' ? {} : {'x-encrypted-param': 'fixture-download'}});
      }
      if (url.endsWith('/sendmessage')) { sends++; throw new Error('private user and token'); }
      assert.fail('untrusted upload origin');
    });
    try {
      await assert.rejects(provider.sendMediaReply({message, media: {type: 'image', data: png, mimeType: 'image/png', name: 'fixture.png'}, idempotencyKey: 'key'}), {message: 'Weixin provider request failed.'});
      assert.equal(uploads, stage === 'target' ? 0 : 1); assert.equal(sends, stage === 'send' ? 1 : 0);
    } finally { await provider.stop(); }
  }
  assert.throws(() => cdnUrl({fullUrl: 'https://novac2c.cdn.weixin.qq.com/c2c/download#private'}, 'download'));
});

test('revocation during upload setup or the CDN upload prevents the next mutation and final send', async () => {
  for (const revokedAt of ['before', 'upload-url', 'upload']) {
    let authorized = revokedAt !== 'before';
    const {provider, message, calls} = await fixture([{type: 1, text_item: {text: 'fixture'}}], async (url) => {
      if (url.endsWith('/getuploadurl')) {
        if (revokedAt === 'upload-url') authorized = false;
        return response({upload_param: 'fixture-upload'});
      }
      if (url.includes('/c2c/upload')) {
        authorized = false;
        return new Response('', {headers: {'x-encrypted-param': 'fixture-download'}});
      }
      assert.fail('a final message must not be sent after revocation');
    });
    try {
      await assert.rejects(provider.sendMediaReply({message, media: {type: 'image', data: png, mimeType: 'image/png', name: 'fixture.png'},
        idempotencyKey: 'fixture-key', authorize: () => { if (!authorized) throw new Error('revoked'); }}));
      assert.equal(calls.length, {before: 0, 'upload-url': 1, upload: 2}[revokedAt]);
    } finally { await provider.stop(); }
  }
});

test('a mistakenly async authorization callback never permits upload or sends', async () => {
  const {provider, message, calls} = await fixture([{type: 1, text_item: {text: 'fixture'}}]);
  try {
    await assert.rejects(provider.sendMediaReply({message, media: {type: 'image', data: png, mimeType: 'image/png', name: 'fixture.png'},
      idempotencyKey: 'fixture-key', authorize: async () => { throw new Error('revoked'); }}), /must be synchronous/u);
    await assert.rejects(provider.sendReply({message, text: 'fixture', idempotencyKey: 'fixture-key', authorize: async () => {}}), /must be synchronous/u);
    assert.equal(calls.length, 0);
  } finally { await provider.stop(); }
});
