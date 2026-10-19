import {createHash, randomBytes} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';

const ORIGIN = 'https://ilinkai.weixin.qq.com';
const MAX_RESPONSE = 2 * 1024 * 1024;
const BASE_INFO = Object.freeze({channel_version: 'dot-weixin-bridge/0.1.0', bot_agent: 'DotBridge/0.1.0'});
const bounded = (value, max = 512) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/u.test(value);
const failure = () => new Error('Weixin provider request failed.');

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
  for (const item of raw.item_list.slice(0, 100)) {
    if (item?.type === 1 && typeof item.text_item?.text === 'string') texts.push(item.text_item.text);
    if (item?.type === 3 && typeof item.voice_item?.text === 'string') texts.push(item.voice_item.text);
    const kind = {2: 'image', 3: 'audio', 4: 'file', 5: 'video'}[item?.type];
    if (kind && attachments.length < 10) {
      const attachment = {kind};
      if (kind === 'file' && bounded(item.file_item?.file_name, 256)) attachment.name = item.file_item.file_name;
      attachments.push(attachment);
    }
  }
  const text = texts.join('\n');
  if (text.length > 20000 || (!text.trim() && !attachments.length)) return null;
  const message = {
    id: createHash('sha256').update(JSON.stringify([credentials.botId, raw.from_user_id, ...identity])).digest('hex'),
    senderId: raw.from_user_id,
    conversationId: raw.from_user_id,
    text,
    replyContext: {contextToken},
    attachments,
  };
  if (Number.isSafeInteger(raw.create_time_ms) && raw.create_time_ms > 0) message.timestamp = raw.create_time_ms;
  return message;
}

export function createProvider({credentials, state, onMessage, signal, fetch = globalThis.fetch}) {
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

  return {
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
    async sendReply({message, text, idempotencyKey}) {
      if (!started || lifetime.aborted || needsLogin || !message || message.senderId !== credentials.ownerId ||
          message.conversationId !== credentials.conversationId || !bounded(message.replyContext?.contextToken, 16384) ||
          typeof text !== 'string' || !text.trim() || Array.from(text).length > 3800 || !bounded(idempotencyKey, 512)) {
        throw new Error('Weixin reply is unavailable or exceeds 3800 characters.');
      }
      const clientId = `dot-${createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 32)}`;
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
}
