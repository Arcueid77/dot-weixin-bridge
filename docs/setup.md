# 连接微信 iLink

桥接运行在持续开机的服务器或电脑上，通过 iLink 长轮询收消息，不需要给微信开放公网入站端口。MCP 服务默认只监听 `127.0.0.1:8792`；通过总仓库的聚合路由器加入已有的单一 Secure MCP Tunnel。

## 准备账号

先在微信提供的 iLink 入口完成本人登录，确认账号有权限使用该入口。腾讯的 [openclaw-weixin 插件](https://github.com/Tencent/openclaw-weixin)提供微信扫码登录流程；已有可用登录结果时，可以由您手动取出并交接给本桥。DotBridge 不会搜索其他应用的凭据目录，也不会自动登录、新建账号或复制密钥。

当前仓库没有扫码登录向导，需要提供已有的 `botToken` 和对应的 `botId`。如果只持有普通微信登录信息、企业微信应用凭据或网页 cookie，不能直接用于本渠道。不要把凭据发到聊天或提交到 Git。

将以下字段写入受保护的 JSON 文件，例如 `/etc/dot-bridge/private/weixin.credentials.json`：

| 字段 | 填什么 |
| --- | --- |
| `ownerId` | 您本人的 iLink 用户 ID |
| `conversationId` | 与 `ownerId` 相同，限定本人私聊 |
| `botId` | 登录结果中的 `ilink_bot_id` |
| `botToken` | 该登录会话的现有 Bearer token |
| `routeTag` | 可选；只有登录服务明确提供时才填写 |

本版本固定使用腾讯的 `https://ilinkai.weixin.qq.com`，附件使用腾讯 `novac2c.cdn.weixin.qq.com` 的 `/c2c/download` 与 `/c2c/upload`。不接受自定义 API 地址或消息中任意网址，下载不会携带 bot token。其他网关签发的 token 不能默认兼容。群聊不在本版本范围内。

本人绑定要以官方登录和本人私聊的真实账号信息为准。不要把第一个给机器人发消息的人自动设成 owner；也不要复制其他应用目录里的凭据来猜测绑定。

## 配置服务

使用 Node.js `>=24.15 <25`，安装总仓库固定的组件版本；单独使用此仓库时执行 `npm ci --omit=dev --ignore-scripts --no-audit --no-fund`。私有目录应为 `0700`、文件为 `0600`，归最终运行用户所有。Windows 通过共享组件的私有文件 ACL 检查。

在 `/etc/dot-bridge/private/weixin.env` 中设置以下项目。示例只展示路径，实际 key 和身份保存在私有文件中：

```dotenv
AUTH_MODE=tunnel-service
BRIDGE_MODE=tunnel
TUNNEL_SERVICE_OPERATION=live
TUNNEL_SERVICE_OWNER_ID=tunnel-owner:dot-bridge
HOST=127.0.0.1
PORT=8792
WEIXIN_TRANSPORT=long-polling
WEIXIN_CREDENTIALS_FILE=/etc/dot-bridge/private/weixin.credentials.json
TUNNEL_SERVICE_KEY_FILE=/etc/dot-bridge/private/weixin.service-key
STORAGE_KEY_FILE=/etc/dot-bridge/private/weixin.storage-key
DATABASE_PATH=/var/lib/dot-bridge/weixin/bridge.sqlite
BRIDGE_LOCK_DIRECTORY=/var/lib/dot-bridge/locks
CALLBACK_TRANSPORT_MODE=standard
```

运行用户必须拥有数据库目录和锁目录。`weixin.service-key` 是此后端独立的 MCP 服务 key，不能与聚合路由器或其他渠道共用。`weixin.storage-key` 是存储加密 key；迁移原数据库时必须保持原值。由您按现有凭据的使用范围交接这些文件，程序不会自动生成替代密钥。

callback 必须由原 dot 的订阅流程真实生成。如果首次订阅提示回调域名尚未批准，取得错误中的准确 hostname，由您确认后写入 `CALLBACK_HOSTS` 并重启本渠道，再让原 dot 尝试一次。域名之间用逗号分隔，不填完整 URL、不使用通配符；配置名是 `CALLBACK_HOSTS`，不是 `MCP_CALLBACK_ALLOWED_HOSTS`。不要复制其他 dot 的回调地址或签名密钥。

单独运行：

```sh
node --env-file=/etc/dot-bridge/private/weixin.env scripts/run-live.js --confirm-live
```

长期运行请从[总仓库](https://github.com/Arcueid77/dot-bridge)生成并安装 systemd 服务，将 `weixin` 加入聚合路由器的 live 渠道列表。官方 Tunnel 的一个 target 仍指向聚合路由器，使用聚合 key；不要为每个 IM 再开一套 Tunnel。升级到带媒体支持的共享组件后，原 dot 刷新工具目录，应能看到 `get_weixin_message`、`get_weixin_attachment`、回复工具和回复状态工具，并订阅 `weixin.message.created`，限定 `conversation=owner`。

## 日常使用

服务启动后，从绑定的本人微信私聊发一条文字。dot 收到事件后读取消息，再调用回复工具。先确认回复回到原私聊，之后再发送一张图片、一段短语音、一个小文件。读取附件使用消息里的附件序号，不需要给 dot 提供 CDN 网址或解密密钥。

每个附件最多 8 MiB。图片支持 JPEG、PNG、GIF、WebP；文件按原字节读取。常见微信 SILK 语音会由本机隔离的解码器转为 WAV，最长 2 分钟；其他已识别的音频保留原编码。网关提供的语音转写只是参考内容。转写服务未配置、编码不受支持或语音太长时，dot 应说明当前无法读取语音内容，并请您转成文字，不能把“收到附件”当成已经听懂。

dot 可以回复文字，也可以单独回复一张图片或一个文件。为避免一条回答被拆成部分成功、部分失败，图片／文件回复不附带文字。需要返回音频文件时按“文件”发送，不将它宣称为微信语音气泡；当前没有语音气泡发送能力。

轮询游标、消息和原私聊回复上下文保存在共享组件管理的加密数据库中。普通服务重启会继续使用这些状态；更新时保留数据库与存储 key，并先停止旧消费者。停止轮询时不会把尚未入库的一批消息标记为已读取。

| 现象 | 处理方式 |
| --- | --- |
| 状态提示需要重新登录 | iLink 登录已失效或 token 被拒绝；先恢复官方登录，再手动更新私有凭据文件并重启 |
| 私聊无消息 | 核对本人绑定、bot 账号和 iLink 登录是否一致；再查原 dot 的事件订阅是否仍有效 |
| 桥已收到消息但 dot 不答 | 核对原 dot 的订阅是否启用；工具能调用、网关在线都不能代替事件订阅 |
| 订阅只报通用错误 | 保留一次尝试的时间和脱敏错误；查询 `events/subscribe` 是否到达以及失败阶段，先不要反复创建 |
| 语音只有“收到语音” | 请 dot 读取语音附件；若原编码无法处理，检查共享组件的语音解码与转写支持，或改发文字 |
| 附件无法读取 | 检查是否超过 8 MiB、原件是否已过期；旧版本仅保存类型的历史消息需要重新发送附件 |
| 长回答无法发送 | 请 dot 将回答控制在 3800 字符以内 |
| 回复状态为 `uncertain` | 平台是否已发送尚不明确；先检查原私聊，不要自动重发 |

不会自动重试发送结果不明的回复，也不会切换到其他聊天或主动推送。iLink 会话失效后需要人工重新登录；事件订阅的续订按原 dot 与总仓库的现有流程处理。
