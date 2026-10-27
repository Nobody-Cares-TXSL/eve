# Slice Gate 记录

> 判定标准：`CLAUDE.md`「Understanding Gate」——执行链、异常分支、测试证据三件事说清。
> 一个 Slice 一份，完成即追加，不回头改旧条目。

---

## T0 — TypeScript 骨架与 SDK 接入（2026-10-28）

对应 AC：`docs/AC-TS.md` AC-T0.1～T0.6。四问在开工时已回答（见会话记录，摘要在下）。

### 1. 执行链

```
pnpm test
  → node --test "test/**/*.test.ts"（Node 24 原生 type-stripping 加载 .ts）
  → normalize.test.ts：构造 RawMessageLike（plain object，非 SDK 实例）
      → normalizeInboundMessage(raw, selfUids)
      → 断言 InboundMessage 各字段（会话键、ID 字符串化、null 缺省、non_text、序号回退链）
  → adapter-port.test.ts：MockPlatformPort implements PlatformPort
      → subscribe → pushMessage/pushStatus → 断言 sink 收到、readHistory 会话隔离
  → sdk-public-api.test.ts：import('douyin-im')
      → 断言 createClient/configureLogger/getLogger 为 function
      → createClient({dataDir: 临时目录}) 可构造即弃（不 login、不发信、不联网）
```

**关键设计**：core 与 normalize 只依赖结构类型（`RawMessageLike`），src/ 中
**零** `import 'douyin-im'`（实测 grep 只命中测试冒烟）——依赖倒置从 T0 生效。

### 2. 异常分支（归一化的拒绝路径）

| 分支 | 行为 | 测试 |
|---|---|---|
| threadId 与 conversationShortId 都缺 | `{ok:false}`，**不猜归属** | 「两者都缺 → 拒绝」 |
| senderUid 缺 | `{ok:false}`，方向不可判 | 「缺少 senderUid → 拒绝」 |
| serverMessageId 缺 | 归 `null`（归档走 no_id_mode），不造假 ID | 「可选 ID 缺失 → null」 |
| text 空/缺 | `kind:'non_text'`，正文空串不伪造 | 「无文本事件归为 non_text」 |
| 19 位 ID | 字符串全程保留；反向断言 `String(Number(id)) !== id` | 「19 位 ID 字符串保留」 |
| selfUids 只含主 UID | imUid 的自发回显判 false → 测试固化「imUid 也要进集合」（SDK message.ts:78 双 ID 判归属） | 「imUid 也要进 selfUids」 |

### 3. 测试证据（2026-10-28 实际输出）

| 检查 | 结果 |
|---|---|
| `pnpm install --frozen-lockfile` | ✅（douyin-im@1.1.0，integrity 与验证版同发布） |
| `pnpm typecheck` | ✅ exit 0 |
| `pnpm test` | ✅ **17 pass / 0 fail**（normalize 11 + port 4 + SDK 冒烟 2） |
| 无代理环境变量跑测试 | ✅ 17 pass（全 mock，无网络） |
| `git check-ignore` 六类敏感路径 | ✅ 全部命中（node_modules/state/data/二维码/sqlite/verify-out） |
| `rg 'douyin-im' app/src` import | ✅ 零命中（仅测试冒烟 import） |
| `rg 'sendMsg' app/src app/test` | ✅ 零命中（只读边界） |
| `import.meta.resolve('douyin-im')` | ✅ 解析至 `app/node_modules/.pnpm/douyin-im@1.1.0/...`（不依赖本地目录） |
| R-01 结论 | **npm 固定版本路径成立**，不触发 git/vendoring 降级 |

### 4. 过程中修正的问题（如实记录）

1. **会话键用错字段**：初版 normalize 用 `conversationShortId`；查 SDK 源码后确认
   权威键是 `threadId`（`0:1:uidA:uidB`，`mappers.ts:143`），shortId 可能为空串。已改主用
   threadId、回退 shortId，并补「两者都缺→拒绝」测试。
2. **fromSelf 单 UID 漏判**：SDK 判归属同时看 `imUid` 与 `uid`（`message.ts:78`），
   归一化签名从 `selfUid: string` 改为 `selfUids: ReadonlySet<string>`，测试含对照。
3. **测试文件两次写坏又重写**：`ok.call(null, ...)` 占位、`notEqual(..., 'force-check')`
   恒真断言——均为无意义测试，已全部重写为可失败的真实断言。
4. **`node --test test/`（目录带斜杠）被当模块路径**：改为 glob `"test/**/*.test.ts"`。
5. **tsconfig 补 `allowImportingTsExtensions`**；`RawMessageLike` 字段显式 `| undefined`
   以兼容 `exactOptionalPropertyTypes`。
6. **根 `.gitignore` 原本不忽略 `node_modules`**：T0 检查时发现并补（连同 state/data/二维码/sqlite）。

### 5. 遗留（不阻塞 T0，归 T1/T2）

- doctor 的 TS 版具体检查项（AC-T2.x）在 T2 前定义（AC-TS 继承映射表已登记）。
- 真实 `DouyinPlatformPort`（T1）：登录/事件订阅/归一化接线、只读运行验证。
- lint 强制「`platform/` 之外禁 import douyin-im」——当前靠约定 + grep，T2 落检查。

**判定：T0 通过 Understanding Gate。**
