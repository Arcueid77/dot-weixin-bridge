import {randomBytes} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';

const ORIGIN = 'https://ilinkai.weixin.qq.com';
const MAX_RESPONSE = 32768;
const reasons = new Set(['confirmation_required', 'login_cancelled', 'login_expired', 'login_request_failed',
  'login_response_invalid', 'qr_display_unavailable', 'verification_required', 'verification_invalid',
  'verification_blocked', 'already_bound', 'unsupported_login_region', 'owner_evidence_missing']);
const fail = reason => Object.assign(new Error('Weixin login did not complete.'), {reason});
const printable = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max &&
  !/[\x00-\x20\x7f\uD800-\uDFFF]/u.test(value);
const identity = value => printable(value, 256) && /^[A-Za-z0-9_.:@+-]+$/u.test(value);

function confirmedCredentials(value) {
  if (!identity(value.ilink_user_id) || value.ilink_user_id.endsWith('@chatroom') ||
      value.ilink_user_id === value.ilink_bot_id) throw fail('owner_evidence_missing');
  if (!identity(value.ilink_bot_id) || value.ilink_bot_id.endsWith('@chatroom') ||
      !printable(value.bot_token, 8192) || !/^[\x21-\x7e]+$/u.test(value.bot_token)) throw fail('login_response_invalid');
  if (![ORIGIN, ORIGIN + '/'].includes(value.baseurl)) throw fail('unsupported_login_region');
  return {ownerId: value.ilink_user_id, conversationId: value.ilink_user_id,
    botId: value.ilink_bot_id, botToken: value.bot_token};
}

// Only the fixed official login API can issue the owner evidence. This path
// neither consumes messages nor searches another application's credential store.
export async function loginWithQr({confirmStopped = false, signal, showQr, readVerificationCode,
  onState = () => {}, fetch = globalThis.fetch, clock = Date.now, wait = delay, ttlMs = 300000} = {}) {
  if (confirmStopped !== true) throw fail('confirmation_required');
  if (typeof showQr !== 'function' || !Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > 300000) throw fail('qr_display_unavailable');
  const started = clock();
  if (!Number.isSafeInteger(started)) throw fail('login_response_invalid');
  const expiresAt = started + ttlMs;
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), ttlMs);
  const lifetime = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
  let qrcode, qrContent, verification;
  const check = () => {
    if (signal?.aborted) throw fail('login_cancelled');
    if (deadline.signal.aborted || clock() >= expiresAt) throw fail('login_expired');
  };
  async function request(endpoint, {method = 'GET', body, timeoutMs = 35000} = {}) {
    check();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.max(1, Math.min(timeoutMs, expiresAt - clock())));
    const chunks = []; let reader, bytes;
    try {
      const url = ORIGIN + endpoint;
      const headers = {'iLink-App-Id': 'bot', 'iLink-App-ClientVersion': '512'};
      if (method === 'POST') Object.assign(headers, {'Content-Type': 'application/json',
        AuthorizationType: 'ilink_bot_token', 'X-WECHAT-UIN': Buffer.from(String(randomBytes(4).readUInt32BE())).toString('base64')});
      const response = await fetch(url, {method, headers, ...(body === undefined ? {} : {body: JSON.stringify(body)}),
        redirect: 'error', credentials: 'omit', signal: AbortSignal.any([lifetime, controller.signal])});
      if (response.status !== 200 || response.redirected || (response.url && response.url !== url) || !response.body ||
          Number(response.headers.get('content-length')) > MAX_RESPONSE) throw fail('login_response_invalid');
      reader = response.body.getReader(); let size = 0;
      for (;;) {
        const {done, value} = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_RESPONSE) throw fail('login_response_invalid');
        chunks.push(Buffer.from(value));
      }
      bytes = Buffer.concat(chunks);
      const value = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
      if (!value || typeof value !== 'object' || Array.isArray(value) ||
          (value.ret !== undefined && value.ret !== 0) || (value.errcode !== undefined && value.errcode !== 0)) throw fail('login_response_invalid');
      check();
      return value;
    } catch (error) {
      check();
      // QR status is an official long poll; its request deadline can elapse
      // while the overall five-minute enrollment is still waiting for a scan.
      if (method === 'GET' && controller.signal.aborted) return {status: 'wait'};
      throw fail(reasons.has(error?.reason) ? error.reason : 'login_request_failed');
    } finally {
      clearTimeout(timeout); controller.abort();
      await reader?.cancel().catch(() => {}); reader?.releaseLock();
      bytes?.fill(0); for (const chunk of chunks) chunk.fill(0);
    }
  }
  try {
    check();
    const qr = await request('/ilink/bot/get_bot_qrcode?bot_type=3', {method: 'POST', body: {local_token_list: []}, timeoutMs: 15000});
    qrcode = qr.qrcode; qrContent = qr.qrcode_img_content;
    if (!printable(qrcode, 2048) || !printable(qrContent, 2048)) throw fail('login_response_invalid');
    try { await showQr(qrContent); } catch { throw fail('qr_display_unavailable'); }
    qrContent = undefined;
    let attempts = 0;
    while (true) {
      check();
      const query = new URLSearchParams({qrcode});
      if (verification !== undefined) query.set('verify_code', verification);
      const value = await request('/ilink/bot/get_qrcode_status?' + query);
      switch (value.status) {
        case 'confirmed': {
          const credentials = confirmedCredentials(value);
          check();
          return credentials;
        }
        case 'wait': break;
        case 'scaned': verification = undefined; onState('scanned'); break;
        case 'need_verifycode':
          if (typeof readVerificationCode !== 'function') throw fail('verification_required');
          if (++attempts > 3) throw fail('verification_blocked');
          onState('verification_required');
          verification = await readVerificationCode({signal: lifetime, retry: attempts > 1});
          check();
          if (typeof verification !== 'string' || !/^[0-9]{1,16}$/u.test(verification)) throw fail('verification_invalid');
          continue;
        case 'expired': throw fail('login_expired');
        case 'verify_code_blocked': throw fail('verification_blocked');
        case 'binded_redirect': throw fail('already_bound');
        case 'scaned_but_redirect': throw fail('unsupported_login_region');
        default: throw fail('login_response_invalid');
      }
      await wait(Math.min(1000, Math.max(1, expiresAt - clock())), undefined, {signal: lifetime});
    }
  } catch (error) {
    check();
    throw fail(reasons.has(error?.reason) ? error.reason : 'login_request_failed');
  } finally {
    qrcode = undefined; qrContent = undefined; verification = undefined;
    clearTimeout(timer); deadline.abort();
  }
}
