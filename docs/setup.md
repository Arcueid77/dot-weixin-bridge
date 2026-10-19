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

本版本固定使用腾讯的 `https://ilinkai.weixin.qq.com`，不接受自定义 API 地址或来自消息的目标地址。其他网关签发的 token 不能默认兼容。群聊不在本版本范围内。

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

原 dot 订阅事件后，再将真实 callback 的准确域名加入 `CALLBACK_HOSTS`。域名之间用逗号分隔，不填 URL、不使用通配符。callback 必须来自原 dot 的订阅流程。

单独运行：

```sh
node --env-file=/etc/dot-bridge/private/weixin.env scripts/run-live.js --confirm-live
```

长期运行请从[总仓库](https://github.com/Arcueid77/dot-bridge)生成并安装 systemd 服务，将 `weixin` 加入聚合路由器的 live 渠道列表。官方 Tunnel 的一个 target 仍指向聚合路由器，使用聚合 key；不要为每个 IM 再开一套 Tunnel。原 dot 刷新工具目录后，应能看到 `get_weixin_message`、`reply_to_weixin` 和 `get_weixin_reply_status`，并订阅 `weixin.message.created`。

## 日常使用

服务启动后，从绑定的本人微信私聊发一条文字。dot 收到事件后读取消息，再调用回复工具。先确认回复回到原私聊，之后再尝试多条不同消息和网关转写语音。

轮询游标、消息和原私聊回复上下文保存在共享组件管理的加密数据库中。普通服务重启会继续使用这些状态；更新时保留数据库与存储 key，并先停止旧消费者。停止轮询时不会把尚未入库的一批消息标记为已读取。

| 现象 | 处理方式 |
| --- | --- |
| 状态提示需要重新登录 | iLink 登录已失效或 token 被拒绝；先恢复官方登录，再手动更新私有凭据文件并重启 |
| 私聊无消息 | 核对本人绑定、bot 账号和 iLink 登录是否一致；再查原 dot 的事件订阅是否仍有效 |
| 语音只有“收到语音” | 网关未提供转写，本版本不会下载音频做语音识别 |
| 长回答无法发送 | 请 dot 将回答控制在 3800 字符以内 |
| 回复状态为 `uncertain` | 平台是否已发送尚不明确；先检查原私聊，不要自动重发 |

不会自动重试发送结果不明的回复，也不会切换到其他聊天或主动推送。iLink 会话失效后需要人工重新登录；事件订阅的续订按原 dot 与总仓库的现有流程处理。
