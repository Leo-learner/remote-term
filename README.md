# remote-term

在 iPhone 上使用这台 Mac 的终端：面容 ID 登录，端到端加密，会话常驻在 Mac 上，断线回来画面原样恢复。

```
手机 PWA ──HTTPS/WSS──▶ nginx(TLS) ──▶ relay (Node, 127.0.0.1:3040)             [Azure]
                                          ▲  只转发密文
                                          │  WSS 出站长连接（设备令牌）
RemoteTerm.app（菜单栏）──spawn──▶ agent (Node) ──node-pty──▶ zsh -l             [Mac]
                                    └ 每个会话一个无头 xterm：断线期间照收输出，重连时发屏幕快照
```

- **Mac 不监听任何端口**：agent 主动连 relay，在任何网络后面都能用。
- **Mac 自己验证身份**：通行密钥的签名由 agent 用本机保存的公钥核对，relay 的登录只是外层的门。服务器被攻破，也打不开 shell。
- **端到端加密**：手机和 Mac 之间每条连接都用 ECDH 协商新的 AES-GCM 密钥，relay 转发的全是密文。细节见 [docs/protocol.md](docs/protocol.md)。
- **公网只暴露中性页面**：登录页和配对页不出现描述用途的词，App 本体登录后才下发，全站 `noindex`。
- 和 [mac-remote](https://github.com/Leo-learner/mac-remote)（Orbit）完全独立：Orbit 承诺"没有执行任意命令的入口"，终端正好相反，所以分开部署、分开登录。

## 目录

| 路径 | 作用 |
|---|---|
| `shared/` | 手机、relay、Mac 三端共用：字节工具、加密通道与握手（WebCrypto）、帧格式 |
| `agent/` | Mac 端：通行密钥与配对、票据、会话（node-pty + 无头 xterm）、手机连接、推送、relay 客户端 |
| `agent/shell/zsh/` | zsh 集成：先加载你自己的 dotfiles，再标记命令开始/结束/目录（OSC 133 / 7） |
| `launcher/` | `RemoteTerm.app` 菜单栏壳：拉起 agent、配对二维码、完全磁盘访问检查、登录时启动 |
| `relay/` | 服务器端：通行密钥登录（外层门）、Cookie 会话、静态资源闸门、WebSocket 转发；`deploy/` 是 nginx 与 systemd 模板 |
| `web/public/` | 公开的登录页、配对页、Service Worker、PWA 清单与图标 |
| `web/app/` | 终端 App（登录后才下发）；`vendor/` 由 `npm run vendor` 从 xterm.js 复制 |
| `docs/design-brief.md` | 给 Claude Design 的设计简报 |
| `test/` | 加密通道、通行密钥、会话、端到端（真实 relay + agent 子进程 + Node 模拟手机）、按键编码 |

## 本机开发

```bash
npm run setup          # 安装 agent / relay / web 依赖，复制 xterm 到 web/app/vendor
npm test               # 全部测试
node scripts/dev.js --pair
```

`scripts/dev.js` 在本机同时跑 relay 和 agent，状态放在 `.dev/`（不提交），打印一次性配对链接。浏览器打开 http://localhost:3040 （通行密钥只允许 localhost 用 http）。Chromium 里可以用 DevTools 的 WebAuthn 面板或 CDP 虚拟认证器代替面容 ID。调试参数：`/app/?renderer=webgl` 改用 WebGL 渲染；在 localhost 上 `window.harbor` 暴露内部对象。

## 部署：term.dkz12345.com

**服务器**（`leo@20.48.14.96`，目录 `/opt/apps/remote-term-relay`，端口 127.0.0.1:3040）：

```bash
npm run vendor
rsync -az --delete --exclude node_modules --exclude data --exclude .env -e "ssh -i <私钥>" relay shared web leo@20.48.14.96:/opt/apps/remote-term-relay/
ssh -i <私钥> leo@20.48.14.96 'cd /opt/apps/remote-term-relay/relay && npm ci --omit=dev && sudo systemctl restart remote-term-relay'
```

首次部署另需：把 `relay/deploy/remote-term-relay.service` 放到 `/etc/systemd/system/` 并 `enable`；把 `relay/deploy/nginx.conf` 放到 `sites-available` 并链接，`nginx -t` 后 reload，再 `certbot --nginx -d term.dkz12345.com`；按 `relay/.env.example` 写 `relay/.env`。

**Mac**：

```bash
node agent/setup.js wss://term.dkz12345.com/agent   # 打印 AGENT_TOKEN_SHA256，填进服务器 relay/.env 后重启服务
bash launcher/build.sh                              # 编译、签名、安装 ~/Applications/RemoteTerm.app
open ~/Applications/RemoteTerm.app
```

然后在 RemoteTerm 窗口里：给它开**完全磁盘访问**（授权后重开一次 App），勾选**登录时自动启动**，点**配对新设备…**，用 iPhone 相机扫码。配对完成后在 Safari 里「添加到主屏幕」，从主屏幕打开再用面容 ID 登录一次（主屏幕 App 和 Safari 的存储是分开的）。

重新配对 Mac（`node agent/setup.js … --force`）后，要把新的 `AGENT_TOKEN_SHA256` 同步到服务器。

## 行为说明

- **会话在 agent 进程里**：暂停、退出或重装 RemoteTerm 会结束所有会话（菜单会先确认）。手机断线、relay 重启都不影响会话。
- **键盘弹起不改终端尺寸**：终端保持完整行数、整体上移露出光标，避免每次弹键盘都让 zsh 重画提示符、让 Claude Code 整屏重绘。
- **慢网络**：手机没跟上的输出超过 512 KB 就停发，追上后发一份最新屏幕，而不是补播积压。
- **撰写栏**：在原生输入框里写整行（中文输入、听写都在本地），多行内容用括号粘贴一次发出；关 Wi-Fi、关机、退出 Clash、`rm -rf ~` 这类命令发送前会确认。这只是提醒，拦不住别名和脚本。
- **推送**：Mac 直接发给 Apple 推送服务，内容用手机的订阅密钥加密。需要从主屏幕打开 App 后在设置里开启。"命令跑完"依赖 zsh 集成，默认只推 ≥30 秒的命令；正在屏幕上看的会话不推。Claude Code 的提醒需要它发 OSC 9 / 777 通知或响铃（Claude Code 设置里的通知渠道）。

## 已知限制

- 键盘回显要经过日本中转，约 250 ms；丢包时会卡顿。撰写栏是主要缓解手段。
- 合盖断电或睡眠后无法远程访问。
- zsh 集成要求 `ZDOTDIR`/`HOME` 是纯 ASCII 路径（zsh 对部分多字节路径处理有缺陷）；不满足时退化为普通 zsh，没有命令完成通知。
- 服务器被攻破时，攻击者可以替换网页代码，等你下次登录时劫持会话；端到端加密防的是被动窃听和未登录时的注入，挡不住这种主动篡改。
