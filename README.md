# exam-auto-answer

让 AI 帮你做完一份在线考试：开一个受控浏览器 → 抓题 → 出答案 → 批量作答 → 校验 → 交卷。

零依赖（Node 22+ 自带 `WebSocket`），通过 CDP 驱动真实的 Edge/Chrome，不是 Selenium 那一套。

**在 Claude Code / DSH / Cursor 这类对话环境里用，不需要任何 API key** —— 答题的就是对话里的模型自己。只有想脱离对话无人值守跑，才需要导入一个 OpenAI 兼容的 key。

## 它解决的三个具体问题

在线考试页面（问卷网 `wenjuan.com` 系）有三个坑，靠肉眼和手点是躲不过去的：

1. **多选题的 `label` 没有 `htmlFor`，且所有 checkbox 的 `id` 相同。** 靠 `getElementById` 永远读到同一个 input，表现为"点了但一个都没选上"。只能按 `querySelectorAll('input[type=radio],input[type=checkbox]')` 的数组下标操作。
2. **点完题号立刻读 DOM，拿到的还是上一题。** 必须轮询等到题号真的变了，否则整批题目和答案错位。
3. **对已登录的考试页改视口尺寸会触发页面刷新，一次性考试令牌作废**，直接被打回登录页。视口必须在登录之前设好。

## 快速开始

```powershell
# 1. 开受控浏览器（WMI 脱离父进程，否则会被 shell 一起杀掉）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\browser.ps1 -Action launch -Port 9223 -Url "https://<考试地址>"

# 2. 抓题（先 probe 确认页面结构匹配）
node scripts/exam.mjs probe   --port 9223
node scripts/exam.mjs harvest --port 9223 --out q.json

# 3. 生成空答题卡，交给模型填（对话内模式）
node scripts/exam.mjs template --questions q.json --out answers.txt
node scripts/exam.mjs checkmap --map answers.txt     # 只验格式，不碰浏览器

# 4. 作答 → 校验 → 交卷
node scripts/exam.mjs apply  --port 9223 --map answers.txt
node scripts/exam.mjs verify --port 9223 --map answers.txt
node scripts/exam.mjs submit --port 9223
```

答题卡就是一行一题，`题号: 下标`，下标 0 基，多选用逗号：

```
# 题号: 选项下标（0 基；多选用逗号，如 12: 0,2）
1: 1
2: 0,2
3: 0
```

`apply` 也直接吃 `{"12": [0,2]}` 形式的 JSON。

## 可选：API 模式（无人值守）

```bash
node scripts/answer.mjs --set-key sk-xxxx              # 写到 ./exam-config.json
node scripts/answer.mjs --questions q.json --out a.json
node scripts/exam.mjs apply --port 9223 --map a.json
```

任何 OpenAI 兼容端点都行（DeepSeek / OpenAI / 本地 vLLM）：

```bash
node scripts/answer.mjs --set-key sk-xxx --base-url https://api.deepseek.com/v1 --model deepseek-chat
```

key 解析优先级：`--api-key` > `EXAM_API_KEY` > `DEEPSEEK_API_KEY` > `OPENAI_API_KEY` > `exam-config.json`。

## 自测

`demo/exam-demo.html` 是一个和问卷网同构的本地页面（多选题故意没有 `htmlFor`、input id 故意重复），改完代码先拿它跑一遍：

```bash
node scripts/exam.mjs harvest --port 9223 --out q.json    # 页面指向 demo 文件
```

## 文件

| 文件 | 作用 |
|---|---|
| `SKILL.md` | 完整流程、三条红线、故障对照表（给模型读的操作手册） |
| `scripts/exam.mjs` | `status / probe / harvest / template / checkmap / apply / verify / submit` |
| `scripts/answer.mjs` | 可选：调 OpenAI 兼容接口出答案 |
| `scripts/browser.ps1` | `launch / list / raise / kill` 受控浏览器 |
| `demo/exam-demo.html` | 同构自测页 |

## 已知限制

- 只覆盖 `wenjuan.com` 系页面结构；换站点要在 `exam.mjs` 顶部的 `PROFILES` 里加选择器，或用 `--profile generic`。
- 用户自己已经打开的窗口抓不到（没有调试端口），只能在新实例里重新登录。
- 交卷这类不可逆动作不会自动反复重试，`submit` 失败会把服务端原文打出来，由人决定。

## 边界

只在你**有权参加**的考试上使用。替考、正式赛事的代答属于违规，也可能被判定成绩无效。代码不替你承担这个决定。
