# Provider implementation

`src/provider.js` implements the independent provider contract from `dot-bridge-core`. Shared authentication, MCP, callback validation, encrypted state and final-reply lifecycle remain in core.

Protocol sources reviewed on 2026-10-19:

- [Tencent API implementation](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/src/api/api.ts)
- [Tencent wire types](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/src/api/types.ts)
- [cc-connect iLink client](https://github.com/chenhg5/cc-connect/blob/2dec7173bdd44ec598c3c7e5c7ff00407acfdedf/platform/weixin/client.go)

The implementation independently uses the documented upstream wire fields: `getupdates`, `sendmessage`, token headers, `get_updates_buf` and per-message `context_token`. It does not copy either framework or load their configuration. `bot_agent` identifies DotBridge. No login helper, CDN client, AES media decoder, typing-status or proactive-send API is included.

Only complete user messages from the configured private owner are accepted. Bot/unfinished/group events are filtered; a present recipient must match the configured bot. Message IDs and sequence numbers are parsed from JSON source text before Number rounding can occur. A stable hashed composite ID is passed to core, which owns durable deduplication. Polling cursor persistence follows successful awaited ingestion of the entire batch. HTTP 401/403 or iLink session error -14 stops polling pending operator login.

Each reply is one bounded POST to the original private peer, carrying the original stored context and a stable hashed `client_id`. This field is not treated as a server-side exactly-once guarantee. No mutation is automatically retried. A 3800-character bound avoids partial multi-request reply delivery. Responses are capped at 2 MiB; requests reject redirects and retain the HTTPS hostname's normal TLS checks.

Synthetic tests cover delayed/failed ingestion, cursor survival, uint64 identity, owner/account/group filtering, metadata and transcript mapping, expired authentication, stable client ID, safe reply routing, uncertain sends and stop cancellation. They do not verify a real iLink account or a real dot subscription. Run `npm run check` and `npm test` with Node 24.15 or later in the 24.x line.
