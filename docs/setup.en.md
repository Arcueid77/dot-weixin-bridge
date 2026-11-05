# Connect Weixin iLink

[中文](setup.md) · [English](setup.en.md)

Run the bridge on a continuously available host. iLink uses outbound long polling, with MCP on loopback and one aggregate target in the existing official Secure MCP Tunnel. Use Node.js >=24.15 and <25.

## Official login and owner binding

Stop the previous consumer. Use the final runtime account and prepare a private directory; the destination credentials file must not exist. Linux uses 0700 directories and 0600 files, while Windows uses private ACLs.

From the unified installation:

```sh
node node_modules/dot-weixin-bridge/scripts/login.js \
  --credentials-file /var/lib/dot-bridge/private/weixin/credentials.json \
  --confirm-private-storage --confirm-stopped
```

From this repository use `scripts/login.js` instead. In PowerShell put the command on one line and use private Windows paths.

Scan and approve the temporary QR code with the intended owner's Weixin account. Enter any phone verification number in the same hidden-input terminal. The flow lasts at most five minutes and clears its temporary display. Keep QR/login material out of recordings and logs.

Official login evidence supplies the owner binding. Existing credentials are preserved; upgrades reuse them. The private JSON contains `ownerId`, matching `conversationId`, `botId`, `botToken`, and optional `routeTag` when returned by the login service.

The adapter uses the fixed Tencent `ilinkai.weixin.qq.com` API and `novac2c.cdn.weixin.qq.com` media paths. `unsupported_login_region` needs a reviewed supported-region solution. This adapter handles the bound private conversation.

| Result | Next step |
| --- | --- |
| `login_expired` | Run a fresh login flow |
| `verification_invalid` / `verification_blocked` | Check the phone value or wait for the platform restriction; attempts are bounded |
| `already_bound` | Keep the original file and locate the existing service |
| `private_destination_unavailable` | Check the destination, owner and private permissions |
| `owner_evidence_missing` | Login supplied insufficient owner evidence; no binding was saved |
| `login_request_failed` | Check HTTPS egress to the fixed official service |

## Configure the backend

Install this repository's lockfile with `npm ci --omit=dev --ignore-scripts --no-audit --no-fund`, or use the unified installation. Example private environment:

```dotenv
AUTH_MODE=tunnel-service
BRIDGE_MODE=tunnel
TUNNEL_SERVICE_OPERATION=live
TUNNEL_SERVICE_OWNER_ID=tunnel-owner:dot-bridge
HOST=127.0.0.1
PORT=8803
WEIXIN_TRANSPORT=long-polling
WEIXIN_CREDENTIALS_FILE=/var/lib/dot-bridge/private/weixin/credentials.json
TUNNEL_SERVICE_KEY_FILE=/var/lib/dot-bridge/private/weixin/service-key
STORAGE_KEY_FILE=/var/lib/dot-bridge/private/weixin/storage-key
DATABASE_PATH=/var/lib/dot-bridge/weixin/bridge.sqlite
BRIDGE_LOCK_DIRECTORY=/var/lib/dot-bridge/locks
CALLBACK_TRANSPORT_MODE=standard
```

Port 8803 is an explicit combination example; an omitted `PORT` uses the component's built-in 8792. Select an available port. The runtime user owns database/lock directories. Each backend/router has an independent service key. Preserve the original storage key with its database.

```sh
node --env-file=/var/lib/dot-bridge/private/weixin.env scripts/run-live.js --confirm-live
```

Use the unified entry to install persistent services and the aggregate router. Refresh the original plugin and reuse/renew `weixin.message.created` with `conversation=owner`. Its real subscription supplies the callback and signing material. Approve the exact returned hostname in `CALLBACK_HOSTS`; the LINE/platform webhook setting is unrelated to this callback.

## Use and maintain

Send one normal owner message and verify one original-DM reply. Then exercise supported media. Each attachment is at most 5 MiB; private CDN references and decryption data stay on the backend. Common SILK voice decodes locally to WAV within two minutes. Native voice replies accept SILK or PCM16 mono WAV; WAV converts locally to SILK. Other recognized audio can be returned as a file.

Complete answers are at most 20,000 characters. Above 3,800 native characters, the whole answer is delivered as `answer.txt`. One source selects one final text or media reply; media has no extra caption. The [README policy](../README.en.md#feedback-context-and-owner-commands) enables official typing, retained context and owner maintenance commands. Keep its group list empty.

Check owner binding, iLink login, gateway state and the original dot's subscription separately. If login expires, stop the old instance, obtain a new approved private login file, verify the same owner and switch under the existing migration procedure. Keep the database/storage key. Subscription renewal belongs to the original dot/platform. Unknown replies are reviewed without automatic replay; logs contain no raw events, credentials or full callback URLs.

Independent owner notifications are separately opt-in. See [outbound behavior](outbound.md#english) and the [shared reminder guide](https://github.com/Arcueid77/dot-bridge/blob/main/docs/scheduled-messages.en.md).
