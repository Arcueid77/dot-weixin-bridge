import {createHash, createCipheriv, randomBytes} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {MAX_MEDIA_BYTES, cdnUrl, mediaReference, decryptMedia, attachmentMime, validateMediaReply, safeMediaName} from './media.js';
import {channel} from './channel.js';

const ORIGIN = 'https://ilinkai.weixin.qq.com';
const MAX_RESPONSE = 2 * 1024 * 1024;
const BASE_INFO = Object.freeze({channel_version: 'dot-weixin-bridge/0.3.0', bot_agent: 'DotBridge/0.3.0'});
const bounded = (value, max = 512) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/u.test(value);
const failure = () => new Error('Weixin provider request failed.');

function authorizeSend(authorize) {
  if (authorize === undefined) return;
  if (typeof authorize !== 'function') throw new Error('Weixin send authorization is unavailable.');
  const result = authorize();
  if (result && typeof result.then === 'function') {
    Promise.resolve(result).catch(() => {});
    throw new Error('Weixin send authorization must be synchronous.');
  }
}

// JSON source is used for uint64 IDs: converting through Number corrupts deduplication.
function parseResponse(raw) {
  return JSON.parse(raw, (key, value, context) =>
    ['message_id', 'seq'].includes(key) && typeof value === 'number'
      ? context.source : value);
}

function normalize(raw, credentials) {
  if (!raw || raw.message_type !== 1 || raw.message_state !== 2 || raw.group_id ||
      raw.from_user_id !== credentials.ownerId ||
      (raw.to_user_id && raw.to_user_id !== credentials.botId) || !Array.isArray(raw.item_list)) return null;
  const contextToken = raw.context_token;
  if (!bounded(contextToken, 16384)) return null;
  const identity = [raw.message_id, raw.seq, raw.client_id, raw.create_time_ms]
    .map(value => typeof value === 'string' || Number.isSafeInteger(value) ? String(value) : '');
  if (!identity.some(value => value && value !== '0')) return null;
  const texts = [];
  const attachments = [];
  const mediaRefs = [];
  for (const item of raw.item_list.slice(0, 100)) {
    if (item?.type === 1 && typeof item.text_item?.text === 'string') texts.push(item.text_item.text);
    if (item?.type === 3 && typeof item.voice_item?.text === 'string') texts.push(item.voice_item.text);
    const kind = {2: 'image', 3: 'audio', 4: 'file', 5: 'video'}[item?.type];
    if (kind && attachments.length < 10) {
      const attachment = {kind};
      if (kind === 'file' && bounded(item.file_item?.file_name, 256)) attachment.name = safeMediaName(item.file_item.file_name);
      attachments.push(attachment);
      const ref = mediaReference(item, kind);
      // Keep large batches readable even when some CDN locators exceed the private metadata budget.
      mediaRefs.push(JSON.stringify({contextToken, mediaRefs: [...mediaRefs, ref]}).length <= 60000 ? ref : null);
    }
  }
  const text = texts.join('\n');
  if (text.length > 20000 || (!text.trim() && !attachments.length)) return null;
  const message = {
    id: createHash('sha256').update(JSON.stringify([credentials.botId, raw.from_user_id, ...identity])).digest('hex'),
    senderId: raw.from_user_id,
    conversationId: raw.from_user_id,
    text,
    replyContext: {contextToken, mediaRefs},
    attachments,
  };
  if (Number.isSafeInteger(raw.create_time_ms) && raw.create_time_ms > 0) message.timestamp = raw.create_time_ms;
  return message;
}

export function createProvider({credentials, state, onMessage, signal, fetch = globalThis.fetch, decodeSilk, encodeSilk}) {
  if (!credentials || !bounded(credentials.ownerId) || credentials.ownerId !== credentials.conversationId ||
      credentials.ownerId.endsWith('@chatroom') || !bounded(credentials.botId) ||
      !bounded(credentials.botToken, 8192) ||
      (credentials.routeTag !== undefined && !bounded(credentials.routeTag, 512))) {
    throw new Error('Weixin credentials require a private owner binding, botId and existing botToken.');
  }
  if (!state || typeof onMessage !== 'function') throw new Error('Weixin runtime dependencies are unavailable.');
  const controller = new AbortController();
  const lifetime = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const currentSends = new Set();
  let loop;
  let started = false;
  let connected = false;
  let needsLogin = false;
  let silkDecoder;
  let silkEncoder;

  async function decodeVoice(data) {
    // The pinned codec is resolved by trusted code, never by message/config values.
    silkDecoder ??= decodeSilk ? Promise.resolve(decodeSilk) : import('@dot-bridge/core/audio/silk.js')
      .then(({createSilkDecoder}) => createSilkDecoder(import.meta.resolve('silk-wasm')));
    return (await silkDecoder)(data, {signal: lifetime});
  }

  async function voicePayload(media) {
    let encoded;
    let wav;
    try {
      if (media.mimeType === 'audio/wav') {
        silkEncoder ??= encodeSilk ? Promise.resolve(encodeSilk) : import('@dot-bridge/core/audio/silk.js')
          .then(({createSilkEncoder}) => createSilkEncoder(import.meta.resolve('silk-wasm')));
        encoded = await (await silkEncoder)(media.data, {signal: lifetime});
      } else encoded = Buffer.from(media.data.subarray(media.data.toString('ascii', 0, 6) === '#!AMR\n' ? 6 : 0));
      if (!Buffer.isBuffer(encoded) || !encoded.length || encoded.length > MAX_MEDIA_BYTES) throw failure();
      // Validate an entire encoded stream inside the bounded codec worker. The
      // decoder's PCM length supplies a duration rather than trusting a caller.
      wav = await decodeVoice(encoded);
      const {validatePcmWav} = await import('@dot-bridge/core/audio/silk.js');
      const info = validatePcmWav(wav);
      if (info.sampleRate !== 24000) throw failure();
      return {data: encoded, playtime: Math.ceil(info.length / (info.sampleRate * 2) * 1000)};
    } catch { encoded?.fill(0); throw new Error('Weixin native voice is unavailable or exceeds two minutes.'); }
    finally { wav?.fill(0); }
  }

  async function request(endpoint, payload, timeoutMs) {
    const timer = new AbortController();
    const timeout = setTimeout(() => timer.abort(), timeoutMs);
    try {
      const headers = {
        'Content-Type': 'application/json', AuthorizationType: 'ilink_bot_token',
        Authorization: `Bearer ${credentials.botToken}`,
        'X-WECHAT-UIN': Buffer.from(String(randomBytes(4).readUInt32BE())).toString('base64'),
        'iLink-App-Id': 'bot', 'iLink-App-ClientVersion': '256',
      };
      if (credentials.routeTag) headers.SKRouteTag = credentials.routeTag;
      const response = await fetch(`${ORIGIN}/ilink/bot/${endpoint}`, {
        method: 'POST', headers, body: JSON.stringify({...payload, base_info: BASE_INFO}),
        redirect: 'error', signal: AbortSignal.any([lifetime, timer.signal]),
      });
      if (response.status === 401 || response.status === 403) {
        needsLogin = true;
        connected = false;
      }
      if (!response.ok) throw failure();
      const chunks = [];
      let size = 0;
      for await (const chunk of response.body ?? []) {
        size += chunk.byteLength;
        if (size > MAX_RESPONSE) throw failure();
        chunks.push(Buffer.from(chunk));
      }
      const raw = Buffer.concat(chunks).toString('utf8');
      const value = raw.trim() ? parseResponse(raw) : {};
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure();
      if (value.errcode === -14) { needsLogin = true; connected = false; }
      if ((value.ret !== undefined && value.ret !== 0) || (value.errcode !== undefined && value.errcode !== 0)) throw failure();
      return value;
    } catch {
      throw failure();
    } finally {
      clearTimeout(timeout);
    }
  }

  async function poll() {
    let backoff = 1000;
    while (!lifetime.aborted && !needsLogin) {
      try {
        const stored = state.get('cursor');
        const cursor = typeof stored === 'string' && stored.length <= 65536 ? stored : '';
        const response = await request('getupdates', {get_updates_buf: cursor}, 40000);
        if (lifetime.aborted) break;
        if ((response.msgs !== undefined && (!Array.isArray(response.msgs) || response.msgs.length > 1000)) ||
            (response.msgs === undefined && response.get_updates_buf === undefined) ||
            (response.get_updates_buf !== undefined && (typeof response.get_updates_buf !== 'string' || response.get_updates_buf.length > 65536))) throw failure();
        connected = true;
        for (const raw of response.msgs ?? []) {
          if (lifetime.aborted) break;
          const message = normalize(raw, credentials);
          if (message) await onMessage(message);
        }
        if (lifetime.aborted) break;
        // All messages must reach durable ingestion before the remote cursor advances.
        if (response.get_updates_buf !== undefined) state.set('cursor', response.get_updates_buf);
        backoff = 1000;
        await delay(100, undefined, {signal: lifetime});
      } catch {
        connected = false;
        if (lifetime.aborted || needsLogin) break;
        try { await delay(backoff, undefined, {signal: lifetime}); } catch { break; }
        backoff = Math.min(30000, backoff * 2);
      }
    }
    connected = false;
  }

  function canAccess(message) {
    return started && !lifetime.aborted && !needsLogin && message?.senderId === credentials.ownerId &&
      message.conversationId === credentials.conversationId && bounded(message.replyContext?.contextToken, 16384);
  }

  async function cdnRequest(url, body) {
    const timeout = AbortSignal.timeout(30000);
    try {
      const response = await fetch(url, {method: body ? 'POST' : 'GET', redirect: 'error', credentials: 'omit',
        ...(body ? {body, headers: {'Content-Type': 'application/octet-stream'}} : {}),
        signal: AbortSignal.any([lifetime, timeout])});
      const limit = body ? 65536 : MAX_MEDIA_BYTES + 16;
      if (response.status !== 200 || Number(response.headers.get('content-length')) > limit) {
        await response.body?.cancel();
        throw failure();
      }
      let size = 0;
      const chunks = [];
      try {
        for await (const chunk of response.body ?? []) {
          size += chunk.byteLength;
          if (size > limit) throw failure();
          chunks.push(Buffer.from(chunk));
        }
        return {data: Buffer.concat(chunks), downloadParam: response.headers.get('x-encrypted-param')};
      } finally { for (const chunk of chunks) chunk.fill(0); }
    } catch { throw failure(); }
  }

  async function sendMedia({message, media, idempotencyKey, authorize}) {
    const key = randomBytes(16);
    const fileKey = randomBytes(16).toString('hex');
    let ciphertext;
    let voice;
    try {
      if (media.type === 'audio') voice = await voicePayload(media);
      const data = voice?.data ?? media.data;
      const cipher = createCipheriv('aes-128-ecb', key, null);
      ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);
      authorizeSend(authorize);
      const upload = await request('getuploadurl', {filekey: fileKey, media_type: {image: 1, file: 3, audio: 4}[media.type],
        to_user_id: message.senderId, rawsize: data.length,
        rawfilemd5: createHash('md5').update(data).digest('hex'), filesize: ciphertext.length,
        no_need_thumb: true, aeskey: key.toString('hex')}, 15000);
      const url = cdnUrl({fullUrl: upload.upload_full_url, query: upload.upload_param, fileKey}, 'upload');
      authorizeSend(authorize);
      const uploaded = await cdnRequest(url, ciphertext);
      uploaded.data.fill(0);
      if (!bounded(uploaded.downloadParam, 8192)) throw failure();
      const reference = {encrypt_query_param: uploaded.downloadParam,
        aes_key: Buffer.from(key.toString('hex'), 'ascii').toString('base64'), encrypt_type: 1};
      const item = media.type === 'image'
        ? {type: 2, image_item: {media: reference, mid_size: ciphertext.length}}
        : media.type === 'audio'
        ? {type: 3, voice_item: {media: reference, encode_type: 6, bits_per_sample: 16, sample_rate: 24000, playtime: voice.playtime}}
        : {type: 4, file_item: {media: reference, file_name: media.name, len: String(media.data.length)}};
      const clientId = `dot-${createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 32)}`;
      authorizeSend(authorize);
      const response = await request('sendmessage', {msg: {
        from_user_id: '', to_user_id: message.senderId, client_id: clientId, message_type: 2, message_state: 2,
        item_list: [item], context_token: message.replyContext.contextToken,
      }}, 15000);
      return {providerMessageId: bounded(response.message_id) ? response.message_id : clientId};
    } catch { throw failure(); }
    finally { key.fill(0); ciphertext?.fill(0); voice?.data.fill(0); }
  }

  const provider = {
    async start() {
      if (lifetime.aborted) throw new Error('Weixin provider is stopped.');
      if (started) return;
      started = true;
      loop = poll();
    },
    async stop() {
      controller.abort();
      await Promise.allSettled([loop, ...currentSends]);
      connected = false;
    },
    status() { return {connected: connected && !lifetime.aborted, needsLogin}; },
    validateMediaReply,
    async readAttachment({message, attachmentIndex}) {
      const ref = message?.replyContext?.mediaRefs?.[attachmentIndex];
      const attachment = message?.attachments?.[attachmentIndex];
      if (!canAccess(message) || !Number.isInteger(attachmentIndex) || attachmentIndex < 0 || attachmentIndex >= 10 ||
          !ref || ref.kind !== attachment?.kind || !['image', 'audio', 'file'].includes(ref.kind) ||
          (ref.size !== undefined && (!Number.isSafeInteger(ref.size) || ref.size < 1 || ref.size > MAX_MEDIA_BYTES))) {
        throw new Error('Weixin attachment is unavailable.');
      }
      const work = (async () => {
        let encrypted, data;
        try {
          encrypted = (await cdnRequest(cdnUrl({fullUrl: ref.url}, 'download'))).data;
          data = decryptMedia(encrypted, ref.key);
          if (!data.length || data.length > MAX_MEDIA_BYTES || (ref.size !== undefined && ref.size !== data.length) ||
              (ref.md5 !== undefined && createHash('md5').update(data).digest('hex') !== ref.md5)) throw failure();
          let mimeType = attachmentMime(data, ref, attachment.name);
          if (mimeType === 'audio/silk') {
            const wav = await decodeVoice(data);
            data.fill(0); data = wav; mimeType = 'audio/wav';
            if (data.length > MAX_MEDIA_BYTES) throw failure();
          }
          return {data, mimeType, ...(attachment.name ? {name: safeMediaName(attachment.name)} : {})};
        } catch { data?.fill(0); throw new Error('Weixin attachment is unavailable.'); }
        finally { encrypted?.fill(0); }
      })();
      currentSends.add(work);
      try { return await work; } finally { currentSends.delete(work); }
    },
    async sendMediaReply(input) {
      validateMediaReply(input);
      if (!canAccess(input.message) || !bounded(input.idempotencyKey, 512)) throw new Error('Weixin reply is unavailable.');
      authorizeSend(input.authorize);
      const work = sendMedia(input);
      currentSends.add(work);
      try { return await work; } finally { currentSends.delete(work); }
    },
    async sendReply({message, text, idempotencyKey, authorize}) {
      if (!started || lifetime.aborted || needsLogin || !message || message.senderId !== credentials.ownerId ||
          message.conversationId !== credentials.conversationId || !bounded(message.replyContext?.contextToken, 16384) ||
          typeof text !== 'string' || !text.trim() || !text.isWellFormed() || text.length > channel.maxReplyText ||
          Buffer.byteLength(text) > 60000 || !bounded(idempotencyKey, 512)) {
        throw new Error('Weixin reply is unavailable or exceeds 20,000 characters.');
      }
      if (text.length > channel.nativeMaxReplyText) {
        const data = Buffer.from(text, 'utf8');
        try { return await provider.sendMediaReply({message, media: {type: 'file', data, mimeType: 'text/plain', name: 'answer.txt'}, idempotencyKey, authorize}); }
        finally { data.fill(0); }
      }
      const clientId = `dot-${createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 32)}`;
      authorizeSend(authorize);
      const work = request('sendmessage', {msg: {
        from_user_id: '', to_user_id: message.senderId, client_id: clientId,
        message_type: 2, message_state: 2,
        item_list: [{type: 1, text_item: {text}}], context_token: message.replyContext.contextToken,
      }}, 15000);
      currentSends.add(work);
      try {
        const response = await work;
        return {providerMessageId: bounded(response.message_id) ? response.message_id : clientId};
      } finally { currentSends.delete(work); }
    },
  };
  return provider;
}
