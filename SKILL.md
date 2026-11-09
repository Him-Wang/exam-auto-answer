---
name: exam-auto-answer
description: 用 CDP 驱动 Edge/Chrome 自动完成在线考试（问卷网 wenjuan.com 及同类单选/多选/判断页面）：开浏览器、抓题、出答案、批量作答、校验、交卷。默认在对话内由你自己答题，不需要任何 API key；也支持导入 key 的无值守模式。Use when the user asks to 自动答题/代答/刷题/做在线考试/自动交卷, hands over an exam URL (e.g. cssc.wenjuan.com), or asks to finish a 模拟考试/正式考试.
---

# 自动答题（exam-auto-answer）

一条流水线：**开浏览器 → 抓题 → 出答案 → 批量作答 → 校验 → 交卷**。

## 两种出答案模式，先认准自己属于哪种

| 模式 | 谁出答案 | 需要 key | 适用 |
|---|---|---|---|
| **对话内（默认）** | 就是**你自己**读完 `q.txt` 后写 `answers.txt` | **不需要** | 用户在 DSH 对话框里让你答题 |
| API 模式 | `answer.mjs` 调 OpenAI 兼容接口 | 需要 | 脱离对话无人值守、批量跑 |

**在对话框里被叫来答题，就走对话内模式，别让用户去弄 key。** 你的推理就是答案来源。

## 0. 前置

- Node 22+（自带 `WebSocket`，零依赖）
- 本机装了 Edge 或 Chrome

## 1. 开一个受控浏览器（不是用户现有窗口）

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\browser.ps1 -Action launch -Port 9223 -Url "https://<考试地址>"
```

两条必须知道的机制：

- 启动走 **WMI `Win32_Process.Create`**，因为裸 `Start-Process` 的子进程会随调用它的 shell 一起被杀掉；WMI 创建才活得下来。
- 参数里必须有 `--disable-sync`，否则 Edge 的同步确认弹窗会抢占 CDP 的 page target，脚本连到错页面。

用户自己的窗口**抓不到**（没有调试端口）。若要接管正在看的窗口，只能走"截屏 + 模拟键鼠"，慢且只能操作前台窗口——优先说服用户在这个新实例里重新登录，登录和验证码由用户自己输入。

## 2. 抓题

```bash
node scripts/exam.mjs probe   --port 9223                  # 页面是否匹配已知 profile
node scripts/exam.mjs harvest --port 9223 --out q.json     # 整个区间一次页内执行，落 q.json 和 q.txt
```

抓题不是每题一次往返：整个 1..N 区间在一个 `Runtime.evaluate` 里循环，等待题号用 `MutationObserver`，题号一变立刻返回下一题。85 题通常 1–2 秒。页面特别慢、怕撞 CDP 超时时用 `--chunk 20` 拆段。

`q.txt` 每两行一题（`n|题型|题干` / `0=.. 1=..`），专门给人/模型读，比 JSON 省一半 token。**先 `probe`**：`numberLinks` 为 0 说明结构不匹配，改 `PROFILES`（`exam.mjs` 顶部）或 `--profile generic`。

## 3. 出答案

### A. 对话内模式（默认，零 key）

```bash
node scripts/exam.mjs template --questions q.json --out answers.txt   # 生成空答题卡
# → 读 q.txt，逐题把下标填进 answers.txt（`12: 0,2`，0 基，多选逗号）
node scripts/exam.mjs checkmap --map answers.txt                      # 不碰浏览器，先验格式与空题
```

答题卡格式极简，一行一题：`题号: 下标`，`#` 开头是注释。`checkmap` 会把 `empty` 列出来并返回非零退出码——**空题非空就别往下走**。

答题要点：多选题把所有正确项都填上（漏选按错算）；判断题 0=对、1=错（以 `q.txt` 实际选项为准）；拿不准的题按常识选最合理项，不要留空。

### B. API 模式（可选）

```bash
node scripts/answer.mjs --set-key sk-xxxx        # 写到 ./exam-config.json
node scripts/answer.mjs --check                  # 确认 baseUrl / model / key 掩码
node scripts/answer.mjs --questions q.json --out a.json
node scripts/answer.mjs --questions q.json --dry-run   # 只看 prompt，不花钱
```

`exam-config.json` 落在**当前工作目录**，不是技能目录——沙箱下子进程写技能根目录会 `EPERM`。也可用环境变量 `EXAM_API_KEY` / `DEEPSEEK_API_KEY`，或 `--config <路径>`。输出 `{"<题号>": [下标...]}`，缺答会缩小批次重试 2 轮，仍未拿到的列在 `missing`。默认 **4 路并发**请求（`--concurrency N` 可调），85 题的等待时间约为串行的 1/3。

## 4. 作答 → 校验 → 交卷

```bash
node scripts/exam.mjs apply  --port 9223 --map answers.txt   # 也吃 a.json，两种格式都认
node scripts/exam.mjs verify --port 9223 --map answers.txt   # 必须跑，看 wrong 数组
node scripts/exam.mjs submit --port 9223
```

`apply` 走一遍整个区间（同样是一次页内执行，不是每题一批），返回 `bad` 列表。**`bad` 非空不等于失败**——常见是跳题时渲染慢导致的 `jump-failed`，`verify` 会给出真实的选中状态，对不上的题重跑一次 `apply --from N --to N`。单选只点目标项（radio 会自己取消同组），只有复选框才做清除。

`submit` 会点交卷并自动接受 `confirm()` 弹窗，返回 `ok:false` 且文本里出现「重新交卷 / 正在保存」时，说明服务端没接受，再跑一次 `submit`。

交卷前把 `verify` 的 `wrong` 清零；交卷后会显示得分，把分数和错题数报告给用户。

## 三条硬红线（都是踩过的坑）

1. **考试中途绝不重启驱动、绝不改视口。** 对已登录的考试页调用 `Emulation.setDeviceMetricsOverride` 会触发 resize，页面整体刷新，一次性考试令牌作废，直接被打回登录页。视口要在**登录之前**设好。
2. **作答必须按 input 下标，不能按 label 点。** 问卷网多选题的 `label.option_label` 没有 `htmlFor`，所有 checkbox 的 id 完全相同；靠 `document.getElementById(htmlFor)` 永远读到同一个 input，表现为"点了但一个都没选上"。永远用 `document.querySelectorAll('input[type=radio],input[type=checkbox]')` 的数组下标。
3. **读题前必须等到题号真的变了。** 点完题号就立刻读 DOM，拿到的是上一题；症状是 harvest 出的题号与内容错位。

## 故障对照

| 现象 | 原因 | 处理 |
|---|---|---|
| `fetch failed` / `ECONNREFUSED 127.0.0.1` | 环境里有 `HTTP_PROXY`，把 localhost 也代理走了；或浏览器已退出 | 脚本已改用 `node:http` 绕开；确认 `browser.ps1 -Action launch` 成功 |
| 作业跑完不退出 | CDP watchdog 定时器没 `unref` | 已修；自定义脚本注意 `timer.unref()` |
| 整批 eval 无输出、不报错 | `cdp.mjs` 类工具默认 30s 超时被静默打断 | 超时调到 180s，或按 10 题分批 |
| 批量作答从 20s 掉到 2-3 分钟 | 窗口最小化/后台，Chromium 节流 `setTimeout` | `browser.ps1 -Action raise -H <hWnd>` 提到前台 |
| 点交卷后卡住 | 页面 `confirm()` 阻塞渲染 | 已加 `Page.javascriptDialogOpening` 自动接受 |
| 写文件 `EPERM` | 沙箱只允许写工作目录 | 输出和 config 都放 cwd |
| `checkmap` 报 `cannot parse answer map` | 答题卡被写成 `12. 0,2` 或全角冒号 | 只用 ASCII 的 `:` `=` `|` 作分隔 |

## 边界

只在用户有权参加的考试上使用；替考、正式赛事的代答属于违规，动手前先确认这是练习/模拟还是计分考试，并让用户对"开始答题"（会启动倒计时、消耗次数）和"交卷"这两个不可逆动作拍板。
