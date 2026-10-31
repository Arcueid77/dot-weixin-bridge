import {createDecipheriv} from 'node:crypto';
import {MAX_MEDIA_BYTES} from '@dot-bridge/core/channels/media.js';
import {validatePcmWav} from '@dot-bridge/core/audio/silk.js';

export {MAX_MEDIA_BYTES};
export const CDN_ORIGIN = 'https://novac2c.cdn.weixin.qq.com';
const bounded = (value, max = 8192) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/u.test(value);
const unavailable = () => new Error('Weixin attachment is unavailable.');

export function safeMediaName(value) {
  if (typeof value !== 'string') return undefined;
  const name = value.split(/[\\/]/u).pop().replace(/[\x00-\x1f\x7f]/gu, '_').slice(0, 255).toWellFormed();
  return name && !['.', '..'].includes(name) ? name : 'attachment';
}

export function cdnUrl({fullUrl, query, fileKey}, operation) {
  if (!['download', 'upload'].includes(operation)) throw unavailable();
  let url;
  if (fullUrl !== undefined) {
    if (!bounded(fullUrl, 16384)) throw unavailable();
    try { url = new URL(fullUrl); } catch { throw unavailable(); }
    if (url.origin !== CDN_ORIGIN || url.username || url.password || url.hash || url.pathname !== `/c2c/${operation}`) throw unavailable();
  } else {
    if (!bounded(query)) throw unavailable();
    url = new URL(`${CDN_ORIGIN}/c2c/${operation}`);
    url.searchParams.set('encrypted_query_param', query);
    if (operation === 'upload') {
      if (!/^[a-f0-9]{32}$/u.test(fileKey ?? '')) throw unavailable();
      url.searchParams.set('filekey', fileKey);
    }
  }
  return url.href;
}

function keyHex(item, kind) {
  if (kind === 'image' && item.aeskey !== undefined) {
    if (!/^[a-fA-F0-9]{32}$/u.test(item.aeskey)) throw unavailable();
    return item.aeskey.toLowerCase();
  }
  const encoded = item.media?.aes_key;
  if (encoded === undefined && kind === 'image') return null;
  if (!bounded(encoded, 64) || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) throw unavailable();
  const decoded = Buffer.from(encoded, 'base64');
  try {
    if (decoded.toString('base64') !== encoded) throw unavailable();
    if (decoded.length === 16) return decoded.toString('hex');
    if (decoded.length === 32 && /^[a-fA-F0-9]{32}$/u.test(decoded.toString('ascii'))) return decoded.toString('ascii').toLowerCase();
    throw unavailable();
  } finally { decoded.fill(0); }
}

// The key and CDN locator belong only in encrypted private message context.
export function mediaReference(item, kind) {
  if (!['image', 'audio', 'file'].includes(kind)) return null;
  const source = item[{image: 'image_item', audio: 'voice_item', file: 'file_item'}[kind]];
  if (!source?.media || typeof source.media !== 'object') return null;
  try {
    const url = cdnUrl({fullUrl: source.media.full_url, query: source.media.encrypt_query_param}, 'download');
    const ref = {kind, url, key: keyHex(source, kind)};
    if (kind === 'file' && typeof source.len === 'string' && /^\d{1,16}$/u.test(source.len)) {
      const size = Number(source.len);
      if (!Number.isSafeInteger(size)) return null;
      ref.size = size;
    }
    if (kind === 'file' && /^[a-fA-F0-9]{32}$/u.test(source.md5 ?? '')) ref.md5 = source.md5.toLowerCase();
    if (kind === 'audio' && Number.isInteger(source.encode_type)) ref.encoding = source.encode_type;
    return ref;
  } catch { return null; }
}

export function imageMime(data) {
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (data.length >= 3 && data[0] === 255 && data[1] === 216 && data[2] === 255) return 'image/jpeg';
  if (['GIF87a', 'GIF89a'].includes(data.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (data.length >= 12 && data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return undefined;
}

export function attachmentMime(data, ref, name = '') {
  if (ref.kind === 'image') {
    const type = imageMime(data);
    if (!type) throw unavailable();
    return type;
  }
  if (ref.kind === 'audio') {
    const offset = data.subarray(0, 6).toString('ascii') === '#!AMR\n' ? 6 : 0;
    if (data.subarray(offset, offset + 10).toString('ascii').includes('#!SILK_V3')) return 'audio/silk';
    if (data.subarray(0, 5).toString('ascii') === '#!AMR') return 'audio/amr';
    if (data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WAVE') return 'audio/wav';
    if (data.subarray(0, 4).toString('ascii') === 'OggS') return 'audio/ogg';
    if (data.subarray(0, 3).toString('ascii') === 'ID3' || (data[0] === 255 && (data[1] & 224) === 224)) return 'audio/mpeg';
    if (data.subarray(4, 8).toString('ascii') === 'ftyp') return 'audio/mp4';
    // iLink's voice encoding enum is not a MIME declaration: unknown bytes stay a file.
    return 'application/octet-stream';
  }
  return {pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', json: 'application/json',
    csv: 'text/csv', zip: 'application/zip'}[name.split('.').pop()?.toLowerCase()] ?? 'application/octet-stream';
}

export function decryptMedia(ciphertext, key) {
  if (key === null) return Buffer.from(ciphertext);
  if (!/^[a-f0-9]{32}$/u.test(key ?? '')) throw unavailable();
  const rawKey = Buffer.from(key, 'hex');
  let first;
  try {
    const decipher = createDecipheriv('aes-128-ecb', rawKey, null);
    first = decipher.update(ciphertext);
    return Buffer.concat([first, decipher.final()]);
  } catch { throw unavailable(); }
  finally { rawKey.fill(0); first?.fill(0); }
}

export function validateMediaReply({media, text}) {
  if (text !== undefined && (typeof text !== 'string' || text.length > 0)) {
    throw new Error('Weixin media replies support one attachment without a text caption.');
  }
  if (!media || !['image', 'audio', 'file'].includes(media.type) || !Buffer.isBuffer(media.data) ||
      media.data.length < 1 || media.data.length > MAX_MEDIA_BYTES || !bounded(media.name, 255) || /\p{Surrogate}/u.test(media.name) ||
      /[\\/]/u.test(media.name) || ['.', '..'].includes(media.name) ||
      typeof media.mimeType !== 'string' || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/iu.test(media.mimeType) ||
      (media.type === 'image' && imageMime(media.data) !== media.mimeType)) {
    throw new Error('Weixin media reply requires a supported attachment of at most 5 MiB.');
  }
  if (media.type === 'audio') {
    if (media.mimeType === 'audio/wav') {
      validatePcmWav(media.data);
    } else if (media.mimeType !== 'audio/silk' || !media.data.subarray(0, 16).includes(Buffer.from('#!SILK_V3'))) {
      throw new Error('Weixin native voice requires SILK or PCM16 mono WAV, at most two minutes. Send other audio as a file.');
    }
  }
}
