# 来源与依赖

本项目的 [MIT LICENSE](LICENSE) 保持不变；第三方依赖分别遵循其自己的许可证。

- [`silk-wasm@3.7.1`](https://github.com/idranme/silk-wasm) 是固定版本的本地语音解码依赖，npm 包 metadata 为 MIT，版权与许可证见 [licenses/silk-wasm-MIT.txt](licenses/silk-wasm-MIT.txt)。版本和完整性记录在 `package-lock.json`。它在共享组件的隔离 worker 中把 SILK 解码为 WAV，不调用外部转写服务。
- [`qrcode-terminal@0.12.0`](https://github.com/gtanner/qrcode-terminal) 仅在当前终端绘制官方登录返回的二维码，不上传二维码内容。其 Apache-2.0 许可证与内含 QRCode 实现的声明保留在 [licenses/qrcode-terminal-LICENSE.txt](licenses/qrcode-terminal-LICENSE.txt)。
- 共享运行与语音 worker 来自固定 `@dot-bridge/core` 发行包，来源版本与完整性见 `vendor/core-release.json`；本仓库不维护另一份共享实现。
- 腾讯 [openclaw-weixin](https://github.com/Tencent/openclaw-weixin/tree/874637a0dbc24050f72d1385add4fc6170a2d726) 仅用作 iLink 登录协议、CDN 加解密和图片／文件发送格式的依据，没有导入其框架、登录状态或配置。具体来源见 [开发说明](docs/development.md)。

分发含依赖的安装包或镜像时，应保留随各依赖提供的声明。
