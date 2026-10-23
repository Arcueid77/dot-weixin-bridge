# dot-weixin-bridge

把本人微信 iLink 私聊接到原来的 ChatGPT dot，并把 dot 的回答发回原私聊。与飞书、QQ 一样，通过官方 Secure MCP Tunnel 连接；共享运行服务由 `dot-bridge-core` 提供，总仓库统一安装和管理。

需要先有可用的 iLink 登录凭据。微信 iLink 与企业微信是两个独立渠道，账号可用性取决于微信当前提供的入口及该账号的登录结果。

可以收取文字、图片、语音和文件。dot 按需读取图片、语音和文件原件，每个附件最多 8 MiB；语音有网关转写时会同时保留。视频目前提供类型信息。只处理明确绑定的本人私聊。

回复可选择一条文字（最多 3800 字符），或一张图片／一个文件。附件回复不附带文字说明，语音气泡发送暂不支持。常见 SILK 语音会在本机转成 WAV（最长 2 分钟）；能否播放或转写取决于共享语音组件与 dot 的支持情况。

[配置与运行](docs/setup.md) · [统一安装入口](https://github.com/Arcueid77/dot-bridge) · [开发说明](docs/development.md)
