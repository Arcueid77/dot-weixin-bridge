# dot-weixin-bridge

[English](README.en.md)

把本人微信 iLink 私聊接到原来的 ChatGPT dot，并把 dot 的回答发回原私聊。与飞书、QQ 一样，通过官方 Secure MCP Tunnel 连接；共享运行服务由 `dot-bridge-core` 提供，总仓库统一安装和管理。

运行扫码接入命令，用本人微信确认后，程序会保存登录凭据和本人绑定。微信 iLink 与企业微信是两个独立渠道，账号可用性取决于微信当前提供的入口及该账号的登录结果。

可以收取文字、图片、语音和文件。dot 按需读取图片、语音和文件原件，每个附件最多 5 MiB；语音有网关转写时会同时保留。视频目前提供类型信息。只处理明确绑定的本人私聊。

回复可选择文字、图片、原生语音或文件。文字回答最多 20,000 字符；超过一条文字的 3,800 字符时，会把完整回答作为一份 `answer.txt` 文件回复，不截断或分成多次发送。附件回复不附带说明文字。

原生语音接受已有的 SILK 或 PCM16 单声道 WAV，最长 2 分钟；WAV 在本机转成 SILK，其他音频可作为文件发送。收到的常见 SILK 语音会在本机转成 WAV；解码后的内容也受 5 MiB 限制。桥不会把文字合成为语音，能否播放或转写仍取决于共享语音组件与 dot 的支持情况。

[配置与运行](docs/setup.md) · [统一安装入口](https://github.com/Arcueid77/dot-bridge) · [开发说明](docs/development.md)

可以让 dot 把收到的图片、语音或文件直接发回原私聊，例如“把这张图发回来”。桥会按附件编号读取，不需要来回传递很长的编码文本。仍需符合本渠道的格式和大小限制；无法作为语音发送的已识别音频，可以明确选择作为文件回复。

TXT、Markdown、JSON、CSV 等文本附件会提供可读的文字摘录，支持 UTF-8 和带标记的 UTF-16；过长时明确标记为截断，原文件仍可读取。PDF／Office 摘录复用受保护的 Linux 处理环境；原文件继续保留。

运行主机可使用持续开机的 Linux 或 Windows 电脑，Linux 支持 systemd。macOS 尚未验证，欢迎试用并反馈。

## 定时消息

支持已绑定本人私聊的主动文字和固定提醒，默认关闭。管理员批准后在私有环境文件中设置 `DOT_BRIDGE_OUTBOUND=owner-text`，重启本渠道与新版聚合器，并刷新原 dot 的工具目录。提醒保存在原加密数据库中，每条最多 2,000 字符，支持一次、每天、每周。

独立发送只用现有微信登录凭据，不读取或复用入站会话令牌。首次启用要用本人账号确认实际接收结果；平台明确拒绝时记录为 `rejected` 并暂停该安排，网络结果不明时记录为 `uncertain`，两者都不自动重发。现有收消息和回复订阅继续沿用。[实现与平台验证说明 / English](docs/outbound.md)。

详见[定时消息使用指南](https://github.com/Arcueid77/dot-bridge/blob/main/docs/scheduled-messages.md)。

## 处理提示、上下文与聊天内管理

在私有环境文件里设置 `DOT_BRIDGE_INTERACTION_POLICY_FILE`，指向运行用户持有的 JSON 文件。Linux 目录 `0700`、文件 `0600`；Windows 使用私有 ACL。先以本人私聊配置开始：

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

微信通过官方 typing 显示实际处理；原 dot 读取消息或明确开始后启动有时限的提示。完成、取消、失败或到期后清理提示。`get_weixin_context` 提供同一会话、话题和成员范围内的保留历史及引用。

本人私聊可使用 `/help`、`/status`、`/queue`、`/subscription`、`/cancel [编号]`。取消作用于尚未发送的桥接回复；发送中和结果不明的记录保留核对。订阅由原 dot／平台按真实有效期续订。

`get_weixin_reply_status` 查询最终投递：`none` 表示尚未排队，`pending` 表示已排队，`processing` 表示最终消息正在写出，`sent` 表示平台确认。处理提示有独立的租约；开始处理后仍需提交本次最终回答。`uncertain` 保持人工核对，不自动补发。

微信使用官方 typing ticket。`get_weixin_message` 或 `begin_weixin_reply` 触发真实处理提示，最终以 `reply_to_weixin` 完成；长回答保留完整文件策略。`groups` 保持空数组。

## 选项、文件和提醒管理

支持用编号文字回复一组选项，直接回复编号即可继续对话。生成的图片、音频或文件可由具备程序文件读取能力的原 dot 分块上传，经大小与 SHA-256 校验后作为原消息的最终回复。单文件上限 5 MiB，仍需满足本渠道支持的媒体类型与格式。

固定文字提醒支持工作日、固定间隔、暂停、恢复和发送历史。先核对 `check_weixin_outbound` 的开关，再按提醒编号与当前版本操作。暂停期间的旧时间点在恢复时跳过。
