# 本人私聊主动发送与定时提醒

仅向私有配置中已经绑定的本人微信私聊发送文字。管理员启用
`DOT_BRIDGE_OUTBOUND=owner-text` 后，原 dot 可立即发送、保存、查询、修改和取消提醒。
每条最多 2,000 字符；重复提醒需提供时区与结束日期。共享 core 保存在原加密数据库，
使用原存储密钥，并保留重启后的发送与去重状态。

独立请求固定调用 `https://ilinkai.weixin.qq.com/ilink/bot/sendmessage`，收件人来自
已核对的本人绑定，不接受任意收件人或旧消息参数。请求不带 `context_token`，也不从
历史消息或缓存里获取该令牌。现有被动回复仍使用原消息的有效上下文。

[腾讯协议参考](https://github.com/Tencent/openclaw-weixin/blob/main/docs/protocol.md)
说明官方客户端会尝试缺少上下文令牌的发送；具体账号的接收情况需要实测。
只有明确的 `ret: 0` 作为平台确认，聊天界面实际收到仍需单独核对。
明确业务拒绝、HTTP 权限或额度拒绝会保存为 `rejected` 并暂停该安排。
缺少确认、无效响应、服务端错误和发送后的网络异常保存为 `uncertain`，不自动重发。
主动发送的权限拒绝不会使仍有效的普通私聊登录被错误注销。

服务端逻辑清除已结束提醒的正文时保留最小去重记录；SQLite 旧页、WAL、备份和日志
的保留规则分别管理。状态与工具用法见[统一定时消息指南](https://github.com/Arcueid77/dot-bridge/blob/main/docs/scheduled-messages.md)。

## English

Independent text and saved literal reminders target only the already paired owner
private chat. Opt in with `DOT_BRIDGE_OUTBOUND=owner-text`, restart this backend
and a compatible router, and refresh the original dot's tools. The shared core
stores schedules in the original encrypted database with the original storage key.
Messages are limited to 2000 characters. Recurring reminders need an IANA timezone
and end date.

Requests use the fixed official `sendmessage` endpoint and protected owner binding.
They omit `context_token` and never read a cached inbound token. Existing passive
replies retain their original message context. The Tencent protocol reference
above describes the official client's no-context attempt; actual account acceptance
and user-visible receipt require live verification.

Only an explicit `ret: 0` establishes platform acknowledgement. Explicit business,
permission, and quota refusals become `rejected` and pause the intent. Missing ACKs,
invalid responses, server failures, and lost connections become `uncertain`.
Neither is automatically retried, and an outbound-only permission refusal does
not invalidate an otherwise working inbound login.
