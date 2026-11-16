# Weixin iLink for DotBridge

[简体中文](README.md) · [English](README.en.md)

Connect the explicitly bound owner's private Weixin iLink conversation to the existing ChatGPT dot through the official Secure MCP Tunnel. Shared authentication, encrypted state and routing come from `dot-bridge-core`; this repository owns the provider protocol.

Use the [unified distribution](https://github.com/Arcueid77/dot-bridge) to install only selected channels. Node.js >=24.15 and <25 is required. Preserve an existing working binding, storage key and database during upgrades. Credentials stay in protected files owned by the runtime user: directory 0700 and files 0600, or matching private Windows ACLs.

## Messaging and media

Text, images, audio and files can be read and replied to. Each attachment is limited to 5 MiB. Use the source-attachment reply tool to return a received attachment by index, without copying Base64 through the model. Replies return to the original authorized conversation.

A complete answer is bounded to 20,000 characters. Above 3800 native text characters, the default sends a complete `answer.txt` file. Pending is not delivered; unknown outcomes remain uncertain and are never automatically repeated.

Text attachments include bounded UTF-8/UTF-16 excerpts. Shared protected Linux processing can also extract PDF and Office text. Truncation is explicit and original bytes remain available. Optional local Whisper provides reference transcription; raw audio and transcripts remain separate. Native voice replies use existing SILK or PCM16 mono WAV, up to two minutes; WAV converts locally to SILK. Media has no extra caption. Other recognized audio can be returned as a file.

## Setup

Complete the platform's official application/login and protected owner binding, then configure this channel in the unified distribution. Follow the [iLink login/setup guide](docs/setup.en.md) and [unified guide](https://github.com/Arcueid77/dot-bridge/blob/main/docs/new-channels.en.md).

Refresh the existing dot Bridge Tunnel tool directory. Reuse or renew the existing message event task; create one only when none exists. A real subscription supplies the callback and signing material. Allow only its verified exact callback hostname; keep MCP on loopback and retain standard HTTPS, DNS/IP, TLS and redirect checks.

## Feedback, context and owner commands

Set `DOT_BRIDGE_INTERACTION_POLICY_FILE` in the private environment file to a JSON policy owned by the runtime user. Linux directories use 0700 and files 0600; Windows uses private ACLs. Start with owner DMs and an empty group list:

```json
{
  "version": 1,
  "feedback": {"enabled": true, "reaction": false, "typing": true, "streaming": false, "lease_seconds": 60},
  "context": {"max_messages": 20, "max_chars": 12000},
  "replies": {"long_text": "file"},
  "management": {"enabled": true},
  "groups": []
}
```

Official typing follows actual processing. Reading a message or explicitly beginning work starts its bounded lease; terminal outcomes clear feedback. `get_weixin_context` reads retained history and quotes in the bound owner conversation.

Owner DMs accept `/help`, `/status`, `/queue`, `/subscription`, and `/cancel [reference]`. Cancellation affects unsent bridge replies; inflight and uncertain outcomes remain for review. The original dot/platform renews the real subscription.

`get_weixin_reply_status` reports final delivery: `none` before enqueue, `pending` after enqueue, `processing` during a final write, and `sent` after platform acknowledgement. Feedback has a separate lease. Processing still needs one final answer; uncertain delivery is never automatically repeated.

Weixin uses the official typing ticket. `get_weixin_message` or `begin_weixin_reply` starts genuine feedback; `reply_to_weixin` completes the answer. Long replies retain the complete-file strategy. Keep `groups` empty.


## Owner reminders

Explicit `DOT_BRIDGE_OUTBOUND=owner-text` enables owner notifications and fixed reminders, up to 2,000 characters. Independent iLink requests omit the inbound context token. Verify actual account acceptance before enabling; explicit rejection pauses the intent and unknown outcomes remain uncertain. See [outbound details](docs/outbound.md#english) and the [shared guide](https://github.com/Arcueid77/dot-bridge/blob/main/docs/scheduled-messages.en.md).

## Choices, uploads and reminder management

Numbered text choices let the user answer with a selection. A dot environment with programmatic file access can upload generated media in bounded encrypted chunks, verify its size and SHA-256, then submit the source-bound final reply. Files are limited to 5 MiB and this provider's supported media types and formats.

Literal reminders support weekdays, fixed intervals, pause, resume and delivery history. Check `check_weixin_outbound` before use and supply the saved reminder ID and current revision. Resuming skips old paused occurrences.


## Tasks, consecutive messages and speech

Task tools return a source-bound reference, passive deadline and remaining seconds. The original dot can save one complete text result. The paired owner can use `/tasks` and `/result reference` in the original DM. Source retention applies, and ambiguous delivery stays uncertain.

The protected interaction policy accepts `queue`, for example `{"mode":"batch","window_ms":750,"max_messages":5}`. Modes are `independent`, `serial` and `batch`, defaulting to independent. A batch retains every source and replies through the last source as its anchor. Attachments, quotes and work already started are handled separately, with the existing conversation/member isolation.

Linux operators can install eSpeak NG and the protected audio runtime, then set `DOT_BRIDGE_SPEECH_SYNTHESIS=local-espeak` and `DOT_BRIDGE_SPEECH_VOICE=zh`. The original dot uses `check_weixin_speech` and `reply_weixin_speech`, limited to 2000 characters and 120 seconds. The full text is also retained in the task record.

An explicitly rejected one-time proactive send can be retried after owner confirmation using `retry_weixin_outbound`, its original ID and current revision. The per-channel proactive switch still applies. Recurring reminders keep their edit/resume flow. Hosted-dot stop, reset and approvals use the original platform controls.

## Session diagnostics

The `session` field of `check_weixin_outbound` reports login need, observed owner input context, the actual last independent-send outcome and its sanitized numeric code. Missing historical evidence is unverified. Independent sends follow the real account eligibility and configured switch, without borrowing a passive reply context token. Known rejection and uncertain outcomes remain distinct.

MP4/WebM videos can be read from their authenticated source media reference and explicitly returned using file mode. Video MIME is derived from the decoded bytes.
