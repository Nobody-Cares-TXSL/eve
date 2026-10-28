# T2 运行时与 CLI Contract

适用：D-014/D-015，T2 阶段 **只读**，不发送消息、不调用 AI。历史 Python 同步循环仅作背景。

## 命令与配置
- cd app && pnpm dac run|status|pause|resume|stop|doctor --json|unblock。
- 配置文件默认 app/data/config.json（Git 忽略），可用 --config 指定。结构为 version=1、selfUid（数字串）、targetUid（数字串）、queueCapacity（1~4096）、pollMs（50~2000）、allowLocalVerification（布尔）。缺少必填项/未知字段均拒绝；不保存账号 UID 或会话凭据到仓库。
- run --mock 为完全离线验收模式；真实 run 需要显式有效配置。doctor 不连接平台，按 D1~D11 稳定输出、汇总计数与安全提示，禁止打印 ID 和敏感值。
- doctor 每项必须是可证伪的检查（D1 Node 版本、D2 SDK 解析、D3 源码无 `.py`、D4 配置、D5 状态目录、D6 配置可读、D7 实例存活、D8 目标账号已配置、D9 凭据目录 0700、D10 源码无 `sendMsg`）。D11（平台风险）无法自动化，固定为人工确认项。检查器扫描源码时必须跳过自身文件。

## 运行与进程状态
- 固定锁路径 state/instance.lock，使用 GNU flock 非阻塞获取，不删除锁文件（不能只检查 PID）。同目录仅允许一个 run；锁失败返回码 4。
- state/runtime.json 原子写（0600）；字段 phase、pid、instanceId、processStart、updatedAt、reason。状态不等于 PID；status 只读，不因死进程覆盖业务状态。
- paused_auth、paused_risk、paused_env、paused_unknown 是持久阻塞态；run 必须拒绝、返回码 3。人工处理后需明确 unblock --reason 才可清除。stale running/paused_manual 可由下一次成功获取锁的 run 恢复为启动前状态；不能据此清除持久阻塞。
- 运行态 heartbeat 与进程 PID/starttime 联合判断存活，过期标 stale，仍保留原状态。
- SIGINT/SIGTERM 正常关闭码 0，SDK logout 已 offline 即使 reject 也为正常停止；未能确认退出且仍 online 的 stop reject 为码 1。SIGKILL 不可清理，下一次 run 只可在拿到锁后进行恢复。

## 控制与队列
- control/requests/<uuid>.json 采用排他新建（0600），含实例 ID、请求 ID、动作、时间；control/acks/<uuid>.json 记录明确结果。控制调用必须等 ack 才能声称已执行；并发请求不共享覆盖同一个文件。stop > pause/resume；过期实例指令不能影响新实例。
- 控制幂等三层：①同进程 `processed` 集合挡重复轮询；②已存在 ack 的请求 id 再次出现时只删除请求文件、不重新执行（防重启或文件重建后的重放）；③`instanceId` 不匹配直接 ack `old_instance` 并拒绝。请求文件名必须与内部 `id` 一致，否则视为伪造并丢弃。
- 文件系统按不可信处理：请求目录中的符号链接不得被读取为指令；状态文件用临时文件 + `rename` 原子替换，绝不写入链接目标；非法 JSON 请求丢弃且不得阻塞后续合法请求。
- SDK 回调仅入有界队列；单消费者按序处理。pause 先拉起执行栅栏并 ack，不再开始消费；排队可保持，队列满立刻进入 paused_env，退出码 3，未来 T4 补收前不得自动恢复。已开始处理的消息不会强行中止；stop 等消费收敛。
- T2 的消费者只统计事件、不打印正文；T3/T4 才负责可靠存档与历史补收，T6 才允许真实发送。

## 退出码与测试
- run：0 正常停止；1 不可恢复运行错误；2 配置/约束错误；3 人工介入阻塞；4 单实例锁冲突。
- 一次性 CLI 的退出码只反映本命令，systemd 只看 run。退出验收直接读取 node/子进程退出码，不用 tee 的退出码；`timeout` 命令的 124 同样不是 node 退出码。
- 故障阻塞（溢出、拒登录）的落盘是异步的：`run` 退出前必须 join 该落盘，否则返回码会读到落盘前的 phase。
- T2 不运行真实抖音联调，以 mock 完成 config/lock/queue/pause/stop/signal/blocked 的可重复自动化验证；真实只读连接只做一次人工回归，不写入自动化测试。
- 测试卫生：子进程用例必须清理 flock 派生的 `--locked` 孙进程；时间敏感断言用轮询，不用固定延迟。
