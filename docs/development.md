# Provider implementation

## 当前文档基线 / Current documentation baseline

组件 0.7.1 使用固定 core 0.11.1，版本和源 SHA 以 `package.json`、`vendor/core-release.json` 及锁文件为准。Windows／Linux CI 已运行。2026-11-05 记录：本轮新交互待本人消息，原网关和订阅沿用；该维护部署的独立主动开关维持关闭。

Source documentation follows registered capabilities. Preserve reviewed artifacts and package documentation through the next normal release. Actual account acceptance remains separate.


The 0.6.0 owner-text path uses the existing bound account and fixed `sendmessage`
endpoint without reading inbound state or sending `context_token`. It requires
the common opt-in and synchronous authorization immediately before HTTP. Only an
explicit `ret: 0` is an ACK. Known HTTP/business rejections use core's fixed
`OutboundRejection` categories; malformed/lost ACKs, transport failures, and 5xx
remain uncertain. Outbound HTTP 403 alone does not invalidate the incoming login.
Synthetic fixtures cover owner routing, no source-context fallback, auth revocation,
strict ACKs, rejection classification, cancellation, and no implicit retry.

`src/provider.js` implements the independent provider contract from `dot-bridge-core`. Shared authentication, MCP, callback validation, encrypted state and final-reply lifecycle remain in core.

Protocol sources reviewed on 2026-10-23:

- [Tencent API implementation](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/src/api/api.ts)
- [Tencent wire types](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/src/api/types.ts)
- [Tencent CDN base and account defaults](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/src/auth/accounts.ts)
- [Tencent media decryption and key encodings](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/src/cdn/pic-decrypt.ts)
- [Tencent media upload fields](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/src/cdn/upload.ts)
- [Tencent image/file send format](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/src/messaging/send.ts)
- [Tencent QR login and authenticated scanning-user evidence](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/src/auth/login-qr.ts)
- [Tencent documented login protocol](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/docs/protocol.md)
- [cc-connect iLink client](https://github.com/chenhg5/cc-connect/blob/2dec7173bdd44ec598c3c7e5c7ff00407acfdedf/platform/weixin/client.go)

The implementation independently uses the documented upstream wire fields: `getupdates`, `getuploadurl`, `sendmessage`, token headers, `get_updates_buf` and per-message `context_token`. It does not copy either framework or load their configuration. `bot_agent` identifies DotBridge. No typing-status or proactive-send API is included.

`scripts/login.js` requires explicit private-storage and stopped-consumer confirmations, a TTY and an unused protected destination before any login request. `src/login.js` uses only the fixed `ilinkai.weixin.qq.com` QR endpoints, an empty `local_token_list`, bounded 32 KiB replies, a five-minute overall deadline and normal TLS verification. QR payloads are rendered locally by pinned `qrcode-terminal` in the terminal alternate screen; neither payload URLs nor image files are emitted. Phone verification digits are read without echo and sent only to the same fixed status endpoint. The `confirmed` response must include valid `ilink_user_id`, `ilink_bot_id`, `bot_token` and the supported API base URL. The former is explicitly the scanning user's identity in the official protocol, so no `getupdates` consumer or first-message claim is needed. Other-region redirects, missing owner evidence, existing files and already-bound responses fail closed. Core owns the atomic no-replace private writer; no shared file-security code is duplicated. Status-request timeouts may continue polling inside the same bounded session; login creation and failed requests are not automatically retried.

Only complete user messages from the configured private owner are accepted. Bot/unfinished/group events are filtered; a present recipient must match the configured bot. Message IDs and sequence numbers are parsed from JSON source text before Number rounding can occur. A stable hashed composite ID is passed to core, which owns durable deduplication. Polling cursor persistence follows successful awaited ingestion of the entire batch. HTTP 401/403 or iLink session error -14 stops polling pending operator login.

Each final reply makes one `sendmessage` POST to the original private peer, carrying the original stored context and a stable hashed `client_id`. This field is not treated as a server-side exactly-once guarantee. No mutation is automatically retried. Text input accepts at most 20,000 well-formed UTF-16 characters / 60,000 UTF-8 bytes; above the native 3,800-character bound the complete answer uses one `answer.txt` file reply. Media has no caption. API responses are capped at 2 MiB; requests reject redirects and retain the HTTPS hostname's normal TLS checks.

Native outgoing voice follows Tencent's [published protocol](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/docs/protocol.md) and [VoiceItem definition](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/src/api/types.ts), reviewed on 2026-10-31. Upload reservation uses media_type=4; the final item uses type=3, encode_type=6, PCM16 metadata, 24,000 Hz and a duration derived from decoding the entire SILK stream in the existing isolated worker. Existing SILK is validated, while PCM16 mono WAV uses the shared encoder. Both are bounded to 120 seconds; converted MIME/byte sizes are rechecked. Other audio is not relabeled or silently sent as a file. The codec module remains pinned, and no new model, TTS service or account is created.

`readAttachment({message,attachmentIndex})` returns up to 5 MiB of bytes from the authenticated message's private `replyContext.mediaRefs` array. It rechecks owner, conversation, index, public kind and the fixed official CDN origin/path. Keys support image hex, base64 of 16 raw bytes and base64 of 32 hex characters. AES-128-ECB with PKCS7 is the official wire format, not a new general encryption design. File length/MD5 are checked when supplied; invalid keys, lengths, padding and destinations fail closed. Incoming invalid references retain their public metadata without saving unsafe URLs or making requests. Total private metadata is bounded so a bad attachment cannot stall the polling cursor. Audio MIME is identified from bytes; SILK uses the shared core `audio/silk.js` worker with pinned `silk-wasm@3.7.1` to produce WAV, with a 10-second worker deadline, 120-second audio bound and runtime cancellation. Transcription remains in core. No transient audio files or duplicate decoder implementation are created.

`validateMediaReply` is synchronous and runs before queuing and again before sending. Image/file uploads use bounded in-memory bytes, a temporary per-upload AES key, `getuploadurl`, and one CDN POST; the bot Bearer token is never sent to the CDN. Full URLs must match `https://novac2c.cdn.weixin.qq.com/c2c/upload`; invalid server-provided URLs do not fall back to a second target. Core's synchronous `authorize()` guard is checked before upload setup, CDN upload and final message send, so expiry or revocation during an upload blocks the next mutation. An accidentally async guard is rejected, not ignored. Upload and final-send errors never retry. Image captions, voice-bubble sending, arbitrary URL inputs and video binary handling are deliberately not advertised. Keys are ephemeral protocol material and are not persisted as new account credentials.

Synthetic tests cover delayed/failed ingestion, cursor survival, uint64 identity, owner/account/group filtering, metadata and transcript mapping, all supported media reads, AES key encodings, size/digest/padding limits, upload encryption, hostile URL refusal, safe reply routing, no retry on uncertain sends and stop cancellation. Login fixtures cover all official states, missing and malformed owner evidence, wrong API origins, body limits, hidden verification input, cancellation/expiry, temporary-screen cleanup and real private-file no-replace writes. They do not verify a real iLink account or a real dot subscription. Run `npm run check` and `npm test` with Node 24.15 or later in the 24.x line. Channel media tools require the matching shared-core release; the pinned vendor artifact is updated centrally during coordinated packaging.
