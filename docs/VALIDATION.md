# 本地开发版 0.1.0 验收记录

这是旧身份 `local.doudizhu` 的历史测试记录，不是公开身份 `io.dbx.doudizhu` 0.1.0 的 CI 发布记录；公开包以 GitHub tag 对应的工作流结果为准。

日期：2026-10-16。环境：Windows x64、Go 1.26.8、Node.js 22.12、Chrome 156。测试使用隔离的临时玩家身份和浏览器配置，没有修改 DBX 主程序或用户现有浏览器会话。

## 自动化验收结果

| 项目 | 结果与证据 |
|---|---|
| 构建与前端测试 | Vue/TypeScript 与 Vite 生产构建通过；卡牌编码、排序测试通过。 |
| Go 规则与并发 | `go test -race ./...`、`go vet ./...` 通过。规则包覆盖率 **94.8%**，包含 36 局完整随机对局、2,000 次手牌排列检查，以及春天、余额不足、整数尾差、重复结算与非法出牌边界。见 `test-results/backend-final.json`。 |
| 三个独立进程连续联机 | 三个真实 Go 进程通过 TLS 与 JSONL 完成三局连续对战、私有手牌隔离、幂等动作、越权拒绝、礼物同步、豆数守恒、离开重入账本与房主关房。见 `test-results/stdio-integration.json`。 |
| 大厅实际界面 | DOM 表单创建 100,000 豆密码房，第二客户端通过 mDNS 搜索，错误密码不占座，正确密码入座，第三客户端经 IP 表单入座；第四客户端看到满员且不能加入。邀请地址可选择、复制。6 项通过，见 `test-results/lobby/report.json`。 |
| 1366×768 / 150% 缩放 | 完整一局 **54 手**；宿主 **18 次**出牌／不出均由实际界面按钮发起并逐次匹配后端历史；另两端为独立 Go 客户端。结算后重开恢复同一局和账本。 |
| 1920×1080 / 150% 缩放 | 完整 **40 手**对局，确认 **14 次**宿主界面操作，结算守恒与重开恢复通过。 |
| 选择与互动 | 点选一张、拖选三张、双击空白取消通过。倒茶、送花、点赞、番茄、鸡蛋和快捷语各自在三端收到同一 ID、同一目标、相同参数且只收到一次。角色区域不同时间帧的像素哈希变化；低动效设置保存、重开保留。见 `test-results/browser/report.json`。 |
| 禁用 WebGL | 实际进入简化 DOM 牌桌并完成 **13 手**对局，含 **5 次**宿主界面操作，结算与重开恢复通过。没有把 Pixi 的 Canvas 自动降级计作 DOM 验收。 |
| 官方 DBX 沙箱 | 官方 `@dbx-app/plugin-cli` 宿主的真实不透明源 srcdoc iframe 中，CSP、Blob 图片／字体、用户手势 AudioContext、Go 事件、Pixi WebGL2、关闭重开恢复共 6 项通过。`connect-src 'none'` 保持原样，没有放宽宿主安全设置。见 `test-results/dbx-host/report.json`。 |
| 断线与事件恢复 | Go 集成测试覆盖断线重连、旧连接失效、身份与 token 绑定、旧修订号事件／响应不能回退快照、事件缺失后的完整快照恢复。 |
| 房主突然终止 | 直接杀死进行中牌局的房主进程，不调用离房接口。两端实际等待约 60 秒重连期限后收到关房事件，快照清空，不进行结算，并能立即创建新房间。6 项通过，见 `test-results/host-crash-acceptance.json`。 |
| 不依赖互联网 | 浏览器测试拦截非本地网络请求，两种正常牌桌与 DOM 牌桌均未发出外网请求。图像、字体随包提供；音乐和音效本地合成。 |

浏览器主流程汇总在 `test-results/browser/report.json`。复测不使用电脑桌面坐标控制；宿主操作通过真实可见按钮发起，没有用 RPC 代替失败的宿主点击。

## 性能采样

官方 DBX 开发宿主、独立 headless Chrome、Intel Arc / ANGLE Direct3D 11，未强制软件渲染。热身 1 秒后分别采样 5 秒：

| 模式 | 默认帧缓冲绘制节奏 | JS 堆采样峰值 |
|---|---:|---:|
| 普通 | 58.69 次/秒 | 约 36.9 MiB |
| 低动效 | 29.46 次/秒 | 约 18.3 MiB |

指标来自 WebGL 默认 framebuffer 的 color-clear 计数，是渲染频率近似值，不是屏幕合成器实际呈现帧数。rAF 约 120 Hz，未将其冒充渲染 FPS。完整 GPU、JS 堆与 Chromium 工作集见 `test-results/dbx-host/performance-report.json`；整个隔离 Chrome 进程树包含浏览器、GPU、官方宿主页面，不等同于插件独立内存占用。

## 安装包与可复测命令

`scripts/verify-package.ps1` 校验 `.dbxp` SHA-256、大小、路径、资源完整性，检查未混入身份文件／开发目录，然后解压安装包，直接运行**包内**可执行文件完成三进程、三局验收。最终结果在 `test-results/package-verification.json`，包哈希也见同目录 `.artifact.json`。

```powershell
pnpm run build
pnpm test
pnpm run test:integration
cd backend
go test -race ./...
go vet ./...
cd ..
# 界面测试先启动：pnpm dev --port 5192
pnpm run test:browser
node scripts/lobby-acceptance.mjs
node scripts/host-crash-acceptance.mjs
# 官方宿主先启动：pnpm exec dbx-plugin dev --path . --port 5190
node scripts/dbx-host-acceptance.mjs
node scripts/dbx-render-performance.mjs
pnpm run package
pwsh -File scripts/verify-package.ps1
pwsh -File scripts/export-source.ps1
```

测试支持 `DBX_GO`、`DBX_CHROME` 指定工具路径。浏览器默认连接 `127.0.0.1:5192`，官方宿主默认连接 `127.0.0.1:5190`。150% 缩放以浏览器 deviceScaleFactor=1.5 执行。

## 交付证据与现场边界

`dist/validation/` 提供验收 JSON、实际大厅／牌桌／结算／兼容模式截图、完整成功录屏和短片。截图来自运行中的程序，美术源图不计作游戏截图。

以下项目缺少现场条件，**未计为通过**：

- 三台物理电脑、真实路由器、防火墙和无线 AP 环境的跨机局域网验证。目前三端均为同一台电脑上的独立 Go 进程；mDNS、多本机网卡及真实 TLS 已验证。
- 已安装的 DBX 桌面 WebView 内人工听音、实体显示器／操作系统 DPI 切换和长期运行。当前官方沙箱、声音启动和硬件 GPU 结果来自隔离 Chromium 开发宿主。
- 物理断开互联网后的跨机对战。已通过浏览器禁止外网请求的隔离验证。角色语音依赖系统已有的离线中文声音，未安装时保持静音。

现场复验可按 README 安装到三台电脑后，完成两局、断网重连、关房、全部礼物和输光重置投票。开发包未发布商店，不提供房主迁移。
