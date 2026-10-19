# dot-weixin-bridge

把本人微信 iLink 私聊接到原来的 ChatGPT dot，并把 dot 的文字回答发回原私聊。与飞书、QQ 一样，通过官方 Secure MCP Tunnel 连接；共享运行服务由 `dot-bridge-core` 提供，总仓库统一安装和管理。

需要先有可用的 iLink 登录凭据。微信 iLink 与企业微信是两个独立渠道，账号可用性取决于微信当前提供的入口及该账号的登录结果。

当前支持收取文字、网关附带的语音转写，以及图片、语音、视频和文件的类型信息。图片和音频原文件不会下载或交给 dot；没有网关转写的语音，dot 只能知道收到了一条语音。回复为文字，单次最多 3800 字符。只处理明确绑定的本人私聊。

[配置与运行](docs/setup.md) · [统一安装入口](https://github.com/Arcueid77/dot-bridge) · [开发说明](docs/development.md)
