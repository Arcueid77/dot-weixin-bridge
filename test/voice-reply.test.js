import test from 'node:test';
import assert from 'node:assert/strict';
import {createDecipheriv} from 'node:crypto';
import {encode} from 'silk-wasm';
import {createProvider} from '../src/provider.js';
import {validateMediaReply} from '../src/media.js';

const credentials = {ownerId: 'fixture-owner', conversationId: 'fixture-owner', botId: 'fixture-bot', botToken: 'fixture-token'};
function pcmWav(milliseconds = 100) {
  const pcmSize = milliseconds * 24 * 2;
  const wav = Buffer.alloc(44 + pcmSize);
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(pcmSize, 40);
  return wav;
}
const response = body => new Response(JSON.stringify(body));
const waitForAbort = signal => new Promise((resolve, reject) => {
  if (signal.aborted) reject(new Error('aborted'));
  else signal.addEventListener('abort', () => reject(new Error('aborted')), {once: true});
});
function fixture() {
  const calls = [];
  let upload, sent, plain;
  const provider = createProvider({credentials, state: {get() {}, set() {}}, onMessage: async () => {},
    fetch: async (url, options) => {
      if (url.endsWith('/getupdates')) return waitForAbort(options.signal);
      calls.push(url);
      if (url.endsWith('/getuploadurl')) { upload = JSON.parse(options.body); return response({upload_param: 'fixture-param'}); }
      if (url.includes('/c2c/upload')) {
        const decipher = createDecipheriv('aes-128-ecb', Buffer.from(upload.aeskey, 'hex'), null);
        plain = Buffer.concat([decipher.update(options.body), decipher.final()]);
        assert.equal(options.headers.Authorization, undefined);
        return new Response('', {headers: {'x-encrypted-param': 'fixture-download'}});
      }
      if (url.endsWith('/sendmessage')) { sent = JSON.parse(options.body).msg; return response({ret: 0, message_id: 'fixture-sent'}); }
      assert.fail('unexpected endpoint');
    }});
  const message = {senderId: credentials.ownerId, conversationId: credentials.conversationId, replyContext: {contextToken: 'fixture-context'}};
  return {provider, message, calls, state: () => ({upload, sent, plain})};
}

test('PCM WAV and SILK use the native VOICE upload and one voice item in the original private context', async () => {
  const wav = pcmWav();
  const silk = Buffer.from((await encode(wav.subarray(44), 24000)).data);
  for (const [data, mimeType] of [[wav, 'audio/wav'], [silk, 'audio/silk'], [Buffer.concat([Buffer.from('#!AMR\n'), silk]), 'audio/silk']]) {
    const {provider, message, calls, state} = fixture();
    await provider.start();
    try {
      assert.deepEqual(await provider.sendMediaReply({message, media: {type: 'audio', data, mimeType, name: 'voice'},
        idempotencyKey: 'fixture-key'}), {providerMessageId: 'fixture-sent'});
      const {upload, sent, plain} = state();
      assert.equal(upload.media_type, 4);
      assert.ok(plain.subarray(0, 16).includes(Buffer.from('#!SILK_V3')));
      assert.notEqual(plain.toString('ascii', 0, 6), '#!AMR\n');
      assert.equal(upload.rawsize, plain.length);
      assert.equal(sent.to_user_id, credentials.ownerId);
      assert.equal(sent.context_token, message.replyContext.contextToken);
      assert.equal(sent.item_list.length, 1);
      const item = sent.item_list[0];
      assert.equal(item.type, 3);
      assert.equal(item.voice_item.encode_type, 6);
      assert.equal(item.voice_item.bits_per_sample, 16);
      assert.equal(item.voice_item.sample_rate, 24000);
      assert.equal(item.voice_item.playtime, 100);
      assert.equal(item.voice_item.media.encrypt_query_param, 'fixture-download');
      assert.equal(item.file_item, undefined);
      assert.equal(calls.length, 3);
      assert.ok(data.some(byte => byte !== 0), 'caller-owned bytes remain intact');
    } finally { await provider.stop(); }
  }
});

test('malformed voice, unsupported codecs and excessive duration never upload or silently become files', async () => {
  const {provider, message, calls} = fixture();
  await provider.start();
  try {
    const corrupt = Buffer.from('\x02#!SILK_V3\ncorrupt');
    await assert.rejects(provider.sendMediaReply({message, media: {type: 'audio', data: corrupt, mimeType: 'audio/silk', name: 'voice.silk'}, idempotencyKey: 'key'}));
    for (const [data, mimeType] of [[Buffer.from('ID3fixture'), 'audio/mpeg'], [pcmWav(120020), 'audio/wav']]) {
      assert.throws(() => validateMediaReply({media: {type: 'audio', data, mimeType, name: 'voice'}}));
    }
    assert.equal(calls.length, 0);
  } finally { await provider.stop(); }
});

test('voice still requires same-owner binding and synchronous live authorization', async () => {
  const {provider, message, calls} = fixture();
  const media = {type: 'audio', data: pcmWav(), mimeType: 'audio/wav', name: 'voice.wav'};
  await provider.start();
  try {
    await assert.rejects(provider.sendMediaReply({message: {...message, senderId: 'other'}, media, idempotencyKey: 'key'}));
    await assert.rejects(provider.sendMediaReply({message, media, idempotencyKey: 'key', authorize: () => { throw new Error('revoked'); }}));
    await assert.rejects(provider.sendMediaReply({message, media, idempotencyKey: 'key', authorize: async () => {}}));
    assert.equal(calls.length, 0);
  } finally { await provider.stop(); }
});
