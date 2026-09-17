# 协议与安全模型

## 威胁模型

relay 所在的 Azure 服务器上还跑着其他 Node 应用，都用同一个 `leo` 用户、免密 sudo。所以默认 relay **可能被攻破**，设计目标是：

| relay 被攻破后能做到 | 不能做到 |
|---|---|
| 看到连接元数据（时间、包大小、会话数） | 读到终端内容（输入和输出都是密文） |
| 让服务中断 | 自己打开 shell、注入命令、重放或篡改帧 |
| 替换网页代码，等主人下次登录时劫持 | 在主人没有登录时做任何事 |

最后一行是 Web 应用固有的限制：网页代码由服务器下发，没有办法固定版本。

## 身份：三个秘密

- **设备令牌**（Mac ↔ relay）：`agent/setup.js` 生成，relay 只存它的 SHA-256。证明"这个 WebSocket 来自那台 Mac"。
- **通行密钥**（主人 ↔ Mac）：私钥在 iPhone 的 iCloud 钥匙串里；公钥存在 Mac 的 `credentials.json`，同时同步一份给 relay 用来做外层登录。
- **票据**（手机 ↔ Mac）：面容 ID 验证成功后由 Mac 签发，32 字节密钥。手机把它导入成**不可导出**的 WebCrypto HKDF 密钥存进 IndexedDB，Mac 存在 `tickets.json`。每次建立连接都要用它，是否仍然有效由 `agent/tickets.js` 的 `ticketStillValid()` 决定。

## 配对（在 Mac 前面，一次）

1. Mac 生成配对秘密 S（32 字节，10 分钟，只能用一次），二维码内容是 `https://term…/pair#<S>`。`#` 后面的片段浏览器不会发给服务器，relay 只知道 `pid = SHA256("rt1 pair id" ‖ S)[:16]`。
2. 手机生成临时 ECDH 密钥 eP，经 relay 请求选项；Mac 生成 eA、随机数 nA，`challenge = SHA256("rt1 pair" ‖ pid ‖ eP ‖ eA ‖ nA)`。
3. 手机用面容 ID 创建通行密钥，并计算 `proof = HMAC(HKDF(S), SHA256(clientDataJSON) ‖ SHA256(attestationObject))`。
4. Mac 校验 proof（证明对方看到了二维码），用 SimpleWebAuthn 校验注册（来源、RP ID、challenge、要求用户验证），保存公钥。
5. Mac 签发票据，用 `HKDF(ECDH(eA, eP), salt=S, info="rt1 seal" ‖ challenge)` 派生的 AES-GCM 密钥封装后返回；relay 同时给浏览器设置 Cookie。

relay 在配对时换掉任何一个公钥，challenge 或 proof 就会对不上。

## 登录（Cookie 或票据过期时，一次面容 ID）

1. 手机发来临时公钥 eP；relay 生成 nR，并向 Mac 要一组 {hid, eA, nA}。
2. `challenge = SHA256("rt1 login" ‖ nR ‖ eP ‖ 1 ‖ hid ‖ eA ‖ nA)`，Mac 离线时是 `… ‖ 0`。
3. 手机用面容 ID 签名。**relay** 用缓存的公钥验证后设置 Cookie；**Mac** 用自己保存的公钥、按自己记住的 eA/nA 重算 challenge 再验证一遍，通过后签发票据（封装密钥由 `ECDH(eA, eP)` 派生）。

通行密钥的签名覆盖了双方的 ECDH 公钥，relay 没法做中间人。

## 每条 WebSocket 连接（静默，靠票据）

```
手机 → Mac   hello   { tid, eP', nP, m = HMAC(HKDF(K,"rt1 hello mac"), tid ‖ eP' ‖ nP) }
Mac          校验 m 和票据策略；T = SHA256("rt1 hello" ‖ tid ‖ eP' ‖ nP ‖ eA' ‖ nA)
             psk = HKDF(K, info="rt1 psk" ‖ T)
             keys = HKDF(ECDH(eA', eP'), salt=psk, info="rt1 keys" ‖ T) → 手机→Mac | Mac→手机 | 确认
Mac → 手机   welcome { eA', nA, HMAC(确认密钥, "rt1 welcome" ‖ T) }
```

- 每条连接都有前向保密（新的 ECDH），也绑定了票据（psk 作为 salt）。
- 手机先核对 welcome 里的 MAC，才信任这条通道，所以 relay 冒充不了 Mac。
- 帧用 AES-256-GCM 加密，IV 是（方向，64 位序号），不随帧传输。丢帧、重放、乱序、伪造都会导致解密失败，连接随即关闭。
- relay 转发 hello 的副本只会得到另一条它无法使用的通道。

## 帧

外层（relay 能看到）：`0x00` 握手 JSON（hello / welcome / reject）或 `0x01` 密文。
内层（仅两端可见）：`0x01` 控制 JSON、`0x02` 输出、`0x03` 输入、`0x04` 屏幕快照；数据帧带 4 字节通道号。

## 流量控制与恢复

- 手机在 xterm **解析完**后才确认收到的字节数。发给某个手机、还没被确认的输出超过 512 KB 时，Mac 停止发送，等确认追上后发一份新的屏幕快照（serialize addon），跳过积压。
- 快照在无头 xterm 的写入队列里插一个空写入作为标记：标记之前的输出都在快照里，之后的先排队、紧跟在快照后面发出，既不丢也不重复。
- PTY 输出快过无头 xterm 的解析速度时暂停读取 PTY，让程序自己阻塞在 write 上，避免 xterm 缓冲超过 50 MB 时直接抛异常。

## 关闭码

relay 关闭手机 WebSocket 时，`4401` 表示需要面容 ID（票据未知或过期、已锁定、设备被移除、已退出登录）；其他码表示可以直接重连。
