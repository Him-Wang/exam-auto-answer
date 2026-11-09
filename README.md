# exam-auto-answer

让 AI 帮你做完一份在线考试：开一个受控浏览器 → 抓题 → 出答案 → 批量作答 → 校验 → 交卷。

零依赖（Node 22+ 自带 `WebSocket`），通过 CDP 驱动真实的 Edge/Chrome，不是 Selenium 那一套。

**在 Claude Code / DSH / Cursor 这类对话环境里用，不需要任何 API key** —— 答题的就是对话里的模型自己。只有想脱离对话无人值守跑，才需要导入一个 OpenAI 兼容的 key。

## 这是什么：一个 skill，不是软件（但仓库里另外附了一个软件版）

**默认形态是 skill（技能包）**：一份写给 AI 读的操作手册 + 配套脚本。没有安装包、没有窗口、没有常驻进程，也不需要任何 API key —— 答题的是对话里的模型。

仓库里**另外**提供一个 **Electron 软件版**（`app/` 目录，成品在 [Releases](../../releases)）：那才是一个能双击运行的独立程序，带界面，需要 API key。两者共用同一套 `scripts/`，软件版只是外壳，逻辑没有第二份。

| | skill（本仓库） | 软件 |
|---|---|---|
| 本质 | 一份写给 AI 读的操作手册 + 配套脚本 | 一个能独立运行的程序 |
| 谁在"思考" | 加载了这份手册的模型 | 程序内部写死的逻辑 |
| 入口 | 由 AI 助手在对话里自动触发（说"自动答题"或贴考试网址） | 双击图标 / 敲命令 / 开网页 |
| 本仓库的证据 | `SKILL.md` 就是技能本体 | 无 |

具体怎么分工：

- **`SKILL.md` 是本体。** 它规定"先 `probe`、再 `harvest`、自己填答题卡、`apply`、`verify`、最后才 `submit`"这个顺序，也记录了三个必须绕开的坑。**只有当模型读了它**，下面这堆脚本才会被串成一串有意义的动作。
- **`scripts/*.mjs` 是手，不是脑。** 它们是很普通的 Node CLI，你手动敲 `node scripts/exam.mjs harvest --port 9223` 也照样抓题；但没人告诉它该选哪个选项时，它自己什么也不会做。
- **`answer.mjs` 让它变成"半个软件"。** 配上 key 之后可以无人值守自己跑完，但仍然是个没有界面的命令行程序——只是把"脑"外包给了模型 API。

想把它变成真正的软件（双击启动、有界面、看得见进度），本仓库已经套好了 Electron 外壳：见下面的「软件版」。

## 两种形态对照

| | skill 版 | 软件版 |
|---|---|---|
| 获取 | 本仓库源码 / Releases 里的 `exam-auto-answer-skill-v1.0.0.zip` | Releases 里的 `ExamAutoAnswer-1.0.0-portable.exe` |
| 谁出答案 | 对话里的模型 | 你在界面里填的 API key 所指向的模型 |
| 需要 key | 不需要 | 需要 |
| 形态 | 目录里的 SKILL.md + 脚本 | 双击运行的单文件程序 |
| 适合 | 在 DSH / Claude Code 里说一句话就开跑 | 不想装 CLI、想要可见进度和按钮 |

## 它解决的三个具体问题

在线考试页面（问卷网 `wenjuan.com` 系）有三个坑，靠肉眼和手点是躲不过去的：

1. **多选题的 `label` 没有 `htmlFor`，且所有 checkbox 的 `id` 相同。** 靠 `getElementById` 永远读到同一个 input，表现为"点了但一个都没选上"。只能按 `querySelectorAll('input[type=radio],input[type=checkbox]')` 的数组下标操作。
2. **点完题号立刻读 DOM，拿到的还是上一题。** 必须轮询等到题号真的变了，否则整批题目和答案错位。
3. **对已登录的考试页改视口尺寸会触发页面刷新，一次性考试令牌作废**，直接被打回登录页。视口必须在登录之前设好。

## 安装（作为 skill）

整个目录丢进你所用 AI 助手的技能目录即可，`SKILL.md` 必须在目录顶层：

```bash
# DeepSeek Harness
git clone https://github.com/Him-Wang/exam-auto-answer.git ~/.dsh/skills/exam-auto-answer

# Claude Code
git clone https://github.com/Him-Wang/exam-auto-answer.git ~/.claude/skills/exam-auto-answer
```

然后直接对助手说"帮我做这个考试：`https://...`"。它会自己读 `SKILL.md`、开浏览器、抓题、答题。

也可以纯手动当命令行工具用，见下面的快速开始——但那样"答题"这一步得你自己填。

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

## 软件版（Electron，需要 API key）

到 [Releases](../../releases) 下载 `ExamAutoAnswer-1.0.0-portable.exe`，双击即用，不需要装 Node、不需要命令行。

流程：填端口和考试地址 → `1·启动浏览器` → 登录（验证码自己输）→ `2·抓题` → `3·出答案` → `4·写入` → `5·校验` → `6·交卷`（会二次确认）。也有「一键跑完」，但**不含交卷**。

- 第一步先点「保存配置」把 key 写进去，再点「检查配置」确认 baseUrl / 模型 / 掩码。
- 工作目录在 `%APPDATA%\ExamAutoAnswer\work`，点「打开工作目录」直达，里面有 `questions.json` / `answers.json` / `exam-config.json`。
- 交卷不可撤销，所以按钮是红的，并且会弹确认框告诉你已写入多少题。

自己构建：

```bash
cd app
npm install
npm run dist      # → dist/ExamAutoAnswer-1.0.0-portable.exe
```

`app/` 只有 `main.js` / `preload.js` / `index.html` 三个文件，壳只负责 spawn 进程和转发输出，所有逻辑仍在 `scripts/` 里，没有第二份实现。

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
