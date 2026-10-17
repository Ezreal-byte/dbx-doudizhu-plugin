# 田园斗地主 · DBX 局域网插件

独立插件 `io.dbx.doudizhu`，公开首版 **0.1.0**，支持 Windows x64 和 macOS 15.4+（Apple Silicon / Intel）。供同一本地局域网中的三位玩家联机斗地主，Go 后端负责房间与规则，Vue 3 + TypeScript + PixiJS 8 实现界面。源码不修改 DBX 主程序。

**没有公网在线运营服务、在线账号、互联网匹配、充值、支付、内购、提现或兑换功能。** 欢乐豆只是房间内的免费计分数字，没有货币价值。游戏内不请求外部素材、遥测或在线语音服务；图像、字体和声音随包提供。详细网络与数据范围见 [PRIVACY.md](docs/PRIVACY.md)。

![五名动态角色](docs/screenshots/characters.png)

[下载公开版本](https://github.com/Ezreal-byte/dbx-doudizhu-plugin/releases) · [源码许可](LICENSE) · [第三方来源](THIRD_PARTY_NOTICES.md)

## 安装与联机

1. 使用 DBX 0.6.44 或更高版本。此最低版本来自 Manifest 的 `engines.dbx: ">=0.6.44"`；`engines.host_api: "^1.0"` 声明插件使用 Host API 1.x，当前 DBX 0.6.44 宿主提供 Host API 1.5.0。
2. 商店审核签名后，可在 DBX 插件中心安装。GitHub Release 的 `.dbxp` 是未签名候选包，开发验证时在「插件中心 → 设置 → 第三方与开发者选项」开启「允许安装未签名开发包」，按平台选择下表对应文件。测试结束后可关闭该选项；它不会放宽商店签名校验。
3. 安装后打开「田园斗地主」工作台，在设置中选昵称、阿禾／小满／福伯／青竹／长安五种形象及音量。三位玩家请使用相同公开版本，LAN 协议为 2。此前本地测试包名为 `local.doudizhu`，其 0.1.0／0.2.0 是内部开发编号；公开包是独立身份，不会覆盖该包或自动迁移其偏好。请结束旧房间后再使用公开版建房。
4. 房主点击「创建房间」，选择公开或密码房、每人初始欢乐豆。默认 10,000，支持 1,000～1,000,000。
5. 另外两台电脑连接同一局域网，在大厅刷新搜索后加入。密码房可被搜索，加入时需密码。三人全部准备后自动开局。
6. 搜索不到时使用「直连好友」，输入房主的 `IP:端口`。多网卡电脑应分享双方可达的局域网地址；可在房间地址列表中选择。
7. 点击手牌或拖过多张牌选牌，双击牌桌空白取消。提示会轮换合法组合；点击对方角色可倒茶、送花、点赞、扔番茄／鸡蛋或发送固定快捷语。键盘 H 提示、P 不出、空格出牌；输入框与弹窗内不会误触牌局快捷键。

| 电脑 | 0.1.0 安装包 |
| --- | --- |
| Windows x64 | `io.dbx.doudizhu-0.1.0-windows-x64.dbxp` |
| Mac Apple Silicon（M 系列） | `io.dbx.doudizhu-0.1.0-darwin-arm64.dbxp` |
| Mac Intel | `io.dbx.doudizhu-0.1.0-darwin-x64.dbxp` |

Mac 版要求 macOS 15.4 及以上，以支持内置 OGG 音乐和语音的系统 WebKit 解码。首次联机如遇本地网络或防火墙提示，请为实际使用的局域网允许 DBX/插件接收入站连接。房间使用系统分配的 TCP 端口，发现使用 mDNS UDP 5353。无需连接互联网；无线 AP 的客户端隔离或多播限制可能阻止自动发现，手动地址仍要求两机 TCP 可达。

## 牌局与会话

- 三名真人，54 张牌，叫 1／2／3 分，全不叫重新发牌，每人可选加倍。叫分 15 秒，加倍 10 秒，出牌 20 秒。
- 底分 100 豆，双方加倍、炸弹／王炸、春天纳入结算。输家最多支付自身余额，按应付比例分配，整数尾差按座次处理，总豆数守恒。
- 欢乐豆在房间内跨局累计，同一身份离开再加入不会补发。有人输光后须三人同意重置，才恢复建房时初始数。
- 断线保留座位并托管，重连恢复当前快照。跟牌超时不出，领出超时出最小单牌。非房主中途离开由托管打完当前局，结算后释放座位。
- 关闭工作台不会离开房间，再打开会恢复会话。房主离房、退出 DBX 或后端终止会结束房间，未完成牌局不结算，没有房主迁移。
- 互动免费，服务端每人 3 秒冷却。角色语音随包离线播放，叫分、加倍、报牌及不出通过实际牌局事件触发，重连不补播旧台词。音乐与音效为原创；设置中可导入自己的 MP3／WAV／OGG／M4A（最大 4 MiB），保存在本机插件数据目录，不发送给牌友。具体来源与限制见 [AUDIO_SOURCES.md](docs/AUDIO_SOURCES.md)。

完整飞机翅膀、四带二和结算规则见 [RULES.md](backend/internal/game/RULES.md)。协议、身份、TLS 和生命周期见 [后端说明](backend/README.md) 及 [接口约定](docs/CONTRACT.md)。

## 构建与测试

需要 Node.js 22.12+、pnpm 10、Go 1.22+。如 Go 不在 PATH 中，可将 `DBX_GO` 设置为 Go 可执行文件的完整路径。脚本也会识别当前工作区的 Go 工具链。

```powershell
pnpm install --frozen-lockfile
pnpm run build
pnpm test
pnpm run test:integration
cd backend
go test -race ./...
go vet ./...
cd ..
pnpm run package
```

`-race` 在 Windows 需要可用的 C 编译器。`test:integration` 启动隔离身份的真实 Go 进程，以 TLS 完成对局；临时测试数据位于操作系统临时目录。该测试不会安装插件或修改 DBX 数据。

Mac 上使用 `DBX_PLUGIN_TARGET=darwin-arm64 pnpm run package`（Apple Silicon）或 `DBX_PLUGIN_TARGET=darwin-x64 pnpm run package`（Intel）。DBX CLI 要求在对应架构的电脑上原生打包。补发 0.1.0 的工作流 `macos-release.yml` 从原始 tag 检出应用，直接调用其锁定的 CLI，使用当前提交的验证脚本验收；应用源码和 tag 均保持不变。

只看大厅前端：`pnpm dev`。连接真实 Go 的官方开发环境：`pnpm exec dbx-plugin dev --path . --port 5190`（Go 须在 PATH）。官方开发环境是开发验证工具，不能替代桌面 DBX 的 CSP 和声音验收。

## 交付状态

当前为首个公开发行版 **0.1.0**，保留最终本地体验版的全部功能：正确的左右臂与肩肘绑定、连续背景、五名动态角色、360 段离线语音、牌桌反馈、偏好设置和音乐导入。tag CI 在 Windows 上执行前端测试、Go race／vet、包内三独立进程连续三局验证，再将同一批已验证产物上传 Release。

macOS 补充发布分别在 Apple Silicon 和 Intel runner 上执行同等测试，并用系统 WKWebView 解码内置音乐和语音。三个平台的 UI 与媒体文件逐一对比；Release 中的 `build-provenance-darwin-*.json` 记录应用源码、构建工具提交与验证结果。Mac 桌面 DBX 的完整界面和 Windows/Mac 三台实体电脑混合联机仍需现场验收。

本地开发期间的画面、声音、沙箱和完整对局验证分别保留在 [开发版 0.2 验收](docs/VALIDATION-0.2.md) 与 [开发版 0.1 验收](docs/VALIDATION.md)，这些是历史证据，不冒充公开 tag 的 CI 结果。三台物理电脑、真实路由器／防火墙的现场验证未覆盖。

原创图源与音频说明见 [ASSETS.md](docs/ASSETS.md)。第三方依赖许可证随包放在 `assets/licenses/`，来源见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。没有使用欢乐斗地主或 ddz-next 的代码、人物、图包或音频。
