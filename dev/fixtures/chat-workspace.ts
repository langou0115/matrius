import type { MessageFile } from '../../src/core/agent/types';
import type { Conversation } from '../../src/features/chat/chat-state';
import type { WorkspaceData } from '../../src/features/workspace/workspace-repository.web';

// Inspired by OpenStudio's software-test seed: bulk multi-turn threads plus
// focused Markdown, math and 50-round cases. Loaded only by the dev preview.
type Turn = string | { content: string; files?: MessageFile[] };
type Thread = { id: string; title: string; pinned?: boolean; turns: Turn[] };

const markdownReply = [
  '# Markdown 综合格式测试',
  '正文同时包含 **粗体**、*斜体*、***粗斜体***、~~删除线~~、`inlineCode()` 和 [示例链接](https://example.com)。',
  '## 二级标题\n### 三级标题\n#### 四级标题\n##### 五级标题\n###### 六级标题',
  '> 一级引用：观察引用缩进。\n>\n> > 二级引用：观察嵌套层级。',
  '- 无序列表\n  - 嵌套项目\n- [x] 已完成任务\n- [ ] 未完成任务\n\n1. 第一项\n2. 第二项\n   1. 嵌套有序项',
  '| 类型 | 示例 | 说明 |\n| :--- | :---: | ---: |\n| 中文 | 你好 | 15 |\n| English | Hello | 200 |\n| 行内代码 | `const value = 1` | 1024 |',
  '```typescript\ntype Reply = { content: string; done: boolean };\nconst reply: Reply = { content: "你好，Matrius", done: true };\nconsole.log(reply.content);\n```',
  '---',
  '脚注示例[^note]。\n\n[^note]: 这是一段脚注说明。',
  '结尾段落：检查从第一段连续选择到这里时，正文与代码是否保持完整。',
].join('\n\n');

const mathReply = String.raw`# 数学公式与货币边界

行内数字 $3.14159$，质能方程 $E = mc^2$，分数 $\frac{1}{2}$，上下标 $x_i^2$。

$$
\int_0^1 x^2\,dx = \frac{1}{3}, \qquad
\sum_{n=1}^{\infty}\frac{1}{n^2} = \frac{\pi^2}{6}
$$

$$
\lim_{x\to 0}\frac{\sin x}{x}=1, \qquad \sqrt[3]{x^3+y^3}
$$

$$
\begin{bmatrix}1 & 0 \\ 0 & 1\end{bmatrix}
\begin{bmatrix}x \\ y\end{bmatrix}
=\begin{bmatrix}x \\ y\end{bmatrix}
$$

$$
f(x)=\begin{cases}x^2, & x\ge 0 \\ -x^2, & x<0\end{cases}
$$

$$
\begin{aligned}
(a+b)^2 &= a^2+2ab+b^2 \\
(a-b)^2 &= a^2-2ab+b^2
\end{aligned}
$$

紧跟正文、开头的定界符不在行首的块，同样应当渲染：$$
\iint_D xy\,dxdy = \int_0^1 x\left[\frac{1}{2}y^2\right]_{x^2}^x dx = \frac{1}{24}
$$

货币金额：$20、$1,000、USD $5.00 / 1M tokens，不应被误当作公式。`;

// Raw text is what keeps `\,` and `\\` intact all the way to the renderer, but it cannot hold a
// backtick: `` \` `` stays a backslash and a backtick, so the fence below never opened and the
// LaTeX meant to sit inside a code block leaked out as text instead. Interpolating the fence is
// the one escape hatch a raw string has.
const FENCE = '```';

// Models that were never told to delimit math paste the environment bare. Kept as a fixture because
// markdown silently eats the backslashes on the way to the screen, so the failure is easy to miss.
const bareLatexReply = String.raw`#### 【示例 1：直角坐标系】
**题目：** 计算二重积分，其中区域由抛物线围成。

**解题步骤：**

3. **列式并计算：**
\begin{aligned}
\iint_D xy \, dxdy &= \int_0^1 dx \int_{x^2}^x xy \, dy \\
&= \int_0^1 x \left[ \frac{1}{2}y^2 \right]_{x^2}^x dx \\
&= \frac{1}{2} \left[ \frac{x^4}{4} - \frac{x^6}{6} \right]_0^1 = \frac{1}{2} \left( \frac{1}{4} - \frac{1}{6} \right) = \frac{1}{24}
\end{aligned}

#### 【示例 2：极坐标系】
**题目：** 计算 $\iint_D (x^2 + y^2) \, dxdy$，其中 $D$ 是圆域 $x^2 + y^2 \le 4$。

- 识别特征：区域是圆，被积函数有 $x^2 + y^2$，果断选用极坐标。
- 矩阵写法：$\begin{bmatrix}1 & 0 \\ 0 & 1\end{bmatrix}$

代码里的 LaTeX 应当保持原样：

${FENCE}tex
\begin{aligned}
x &= 1
\end{aligned}
${FENCE}`;

// A model that opens `$$` and only closes it much later. remark-math hands the whole stretch to
// KaTeX, which fails, and the reader gets every heading and formula in it as red error text.
const strayDelimiterReply = String.raw`1. **求交点：** 联立方程：

$$
\begin{cases} y = x \\ y = x^2 \end{cases} \implies x^2 - x = 0 \implies x = 0,\, x = 1

交点为 $(0, 0)$ 和 $(1, 1)$。

2. **选择积分次序并限定：**
该区域既是 $X$-型也是 $Y$-型。选用 $X$-型（先积 $y$，后积 $x$）：
$$

3. **转化为累次积分并计算：**

$$\iint_D xy \, dxdy = \int_0^1 dx \int_{x^2}^x xy \, dy$$

先对 $y$ 积分，再对 $x$ 积分即可。`;

const codeReply = [
  '下面用不同语言观察代码块的留白、连续代码块和横向滚动。',
  '```tsx\nexport function Greeting({ name }: { name: string }) {\n  return <p>你好，{name} 👋</p>;\n}\n```',
  '```python\ndef summarize(items):\n    return {"total": len(items), "labels": [item["title"] for item in items]}\n\nprint(summarize([{"title": "中文标题"}]))\n```',
  '```sql\nSELECT conversation_id, COUNT(*) AS message_count\nFROM messages\nGROUP BY conversation_id\nORDER BY message_count DESC;\n```',
  '```json\n{"title":"渲染测试","enabled":true,"items":[1,2,3],"nested":{"text":"中文与 English"}}\n```',
  '```bash\nprintf \'%s\\n\' "hello world"\n```',
  '```\n没有语言标签的纯文本代码块。\n保留空格：    A    B    C\n\t制表符缩进\n```',
  '```text\n' + 'const extremelyLongValue = "' + 'long_token_without_spaces_'.repeat(30) + '";\n```',
  '代码之后的普通正文与 **加粗文字**、`行内代码` 应继续沿正文宽度排版。',
].join('\n\n');

const longParagraph = '在长文本阅读过程中，段落宽度、换行位置和行距会共同影响阅读体验。这里保留连续的中文描述，同时穿插 English words、数字 1234567890 和标点（括号）、逗号，观察不同字体之间的基线是否一致。回复内容应始终留在消息区域内，切换会话和展开侧栏后仍然能够完整阅读。';
const topics = [
  '中文段落与阅读节奏', '中英文混排与标点', '粗体与行内代码', '多语言代码块',
  '表格与长单元格', '列表与引用嵌套', '公式与货币边界', '长链接与连续字符',
  '短回复与多轮追问', '长标题与侧栏切换',
];
const followUps = [
  '先给我一个清晰的整体说明。', '换一种表达方式，再补充具体例子。',
  '把刚才的内容分成步骤，保留关键细节。', '给一个包含代码或数据的版本。',
  '再加入边界条件，解释可能出现的情况。', '把回答展开成更长的说明。',
  '检查中英文、数字和标点混排。', '最后总结一下，并保留可以直接复制的内容。',
];

function createBulkThread(index: number, rounds = 8): Thread {
  const sequence = String(index + 1).padStart(3, '0');
  const topic = topics[index % topics.length];
  return {
    id: `dev-chat-${sequence}`,
    title: `对话 ${sequence}：${topic}${index % 5 === 0 ? '｜用于检查超长标题省略、菜单预留位置，以及收起再展开侧栏之后的阅读布局' : ''}`,
    pinned: index % 20 === 0,
    turns: Array.from({ length: rounds }, (_, turn) => {
      const marker = `会话 ${sequence} · 第 ${turn + 1} 轮`;
      const example = [markdownReply, mathReply, codeReply][(index + turn) % 3];
      return [
        `${marker}：我们继续讨论“${topic}”。${followUps[turn % followUps.length]}\n\n${longParagraph}`,
        `**${marker}**\n\n围绕“${topic}”，这轮回答先说明目标，再给出具体内容，最后留下可观察的结果。\n\n${longParagraph}\n\n${turn % 3 === 0 ? example : longParagraph.repeat(turn % 2 + 1)}\n\n本轮结束标记：${sequence}-${turn + 1}。下一轮继续时请保留上下文。`,
      ];
    }).flat(),
  };
}

// Ten saved files in one reply: checks the collapsed generated-files card, its scrolling
// list and the created/modified tags. Revisions above 1 stand in for edits because the
// preview never records the tool operation.
const generatedFiles: MessageFile[] = [
  { id: 'dev-file-01', filename: '武汉未来7天天气.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', size: 18_432, revision: 1 },
  { id: 'dev-file-02', filename: '第44周周报.docx', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', size: 24_576, revision: 1 },
  { id: 'dev-file-03', filename: '产品发布会.pptx', contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', size: 1_286_144, revision: 2 },
  { id: 'dev-file-04', filename: '2026年度预算.pdf', contentType: 'application/pdf', size: 356_352, revision: 1 },
  { id: 'dev-file-05', filename: '数据字典.csv', contentType: 'text/csv', size: 8_192, revision: 1 },
  { id: 'dev-file-06', filename: '接口说明.md', contentType: 'text/markdown', size: 12_288, revision: 2 },
  { id: 'dev-file-07', filename: '用户画像分析.docx', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', size: 65_536, revision: 1 },
  { id: 'dev-file-08', filename: '销售趋势图.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', size: 47_104, revision: 2 },
  { id: 'dev-file-09', filename: '会议纪要.docx', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', size: 20_480, revision: 1 },
  { id: 'dev-file-10', filename: '部署清单.txt', contentType: 'text/plain', size: 1_536, revision: 1 },
];

const specialThreads: Thread[] = [
  {
    id: 'dev-render-files', title: '生成文件专项｜一次回复保存 10 个文件', pinned: true,
    turns: [
      '把这次调研整理成一个资料包，按主题生成文件并保存到资料库。',
      {
        content: '已整理完毕，10 个文件都已保存到资料库。展开下面的列表可以逐个下载，也可以一次下载全部。',
        files: generatedFiles,
      },
    ],
  },
  {
    id: 'dev-render-markdown', title: 'Markdown 综合格式｜标题、列表、引用、表格与脚注', pinned: true,
    turns: ['请给我一份集中展示 AI 回复常见 Markdown 格式的样例。', markdownReply],
  },
  {
    id: 'dev-render-code', title: '代码专项｜多语言、连续代码块与超长行', pinned: true,
    turns: ['展示多种代码块，包含中文、空行、缩进和超长行。', codeReply],
  },
  {
    id: 'dev-render-math', title: '公式专项｜分数、积分、矩阵与货币', pinned: true,
    turns: [
      '请检查公式 $E = mc^2$ 与货币 $20 混在用户消息里的显示。', mathReply,
      '代码里的美元符号应该原样保留，给我一些对照。',
      '金额 **$5.00 / 1M tokens** 与 **$30.00 / 1M tokens**。\n\n`$x^2$` 与 `\\frac{a}{b}` 是行内代码。\n\n```text\n$E = mc^2$\n\\frac{1}{2}\nprice = "$20"\n```\n\n正文公式仍写作 $x^2 + y^2 = z^2$。',
    ],
  },
  {
    id: 'dev-render-bare-latex', title: '公式专项｜模型漏写定界符（裸 LaTeX 兜底）',
    turns: ['为什么这里的公式渲染成了一堆反斜杠？', bareLatexReply],
  },
  {
    id: 'dev-render-stray-delimiter', title: '公式专项｜错位的 $$ 定界符跨了一大段正文',
    turns: ['这一段为什么整块都是红色的？', strayDelimiterReply],
  },
  {
    ...createBulkThread(100, 50), id: 'dev-render-50-rounds',
    title: '50 轮长对话｜100 条消息与滚动压力测试', pinned: true,
  },
  {
    id: 'dev-render-long-reply', title: '超长单条回复｜40 个连续段落',
    turns: ['请给我一条足够长的回复，用来检查滚动与连续选区。',
      Array.from({ length: 40 }, (_, index) => `**第 ${index + 1} 段**\n\n${longParagraph.repeat(3)}`).join('\n\n')],
  },
  {
    id: 'dev-render-mixed', title: '多语言与 Unicode｜English、日本語、emoji、RTL',
    turns: [
      '帮我检查中文 English 日本語 한국어 العربية 的混合显示。🙂 👩🏽‍💻 👨‍👩‍👧‍👦',
      '中文与 English words 混排：React 19、TypeScript、API v2.0。\n\n日本語：これはチャット表示のテストです。\n\n한국어: 대화 메시지 렌더링 테스트입니다.\n\nالعربية: هذا نص لاختبار عرض المحادثة.\n\nEmoji：🙂 🚀 👩🏽‍💻 👨‍👩‍👧‍👦 🇨🇳\n\n组合字符：café / café；全角：ＡＢＣ１２３；中文标点：“你好”，《测试》……',
    ],
  },
  {
    id: 'dev-render-overflow', title: '边界内容｜长链接、连续字符与 HTML 原文',
    turns: [
      '检查长字符串与不可信文本是否影响布局。',
      '长链接：\nhttps://example.com/' + 'very-long-path/'.repeat(35) + '\n\n连续英文：\n' + 'LongWordWithoutAnySpaces'.repeat(50) + '\n\nHTML 原文应按文字显示：\n<script>alert("fixture")</script>\n<img src=x onerror="alert(1)">\n\n[不安全链接样例](javascript:alert(1))\n\n结束位置：这段文字仍应出现在消息正文内。',
    ],
  },
  {
    id: 'dev-render-short', title: '短回复与多轮追问｜气泡高度和消息间距',
    turns: ['你好', '你好！', '可以简短回复吗？', '可以。', '1 + 1 等于多少？', '**2**。', '给我一个变量名。', '`messageContent`', '谢谢 👋', '不客气。'],
  },
  {
    id: 'dev-render-partial', title: '未完成内容｜截断的代码块、粗体与公式',
    turns: [
      '看看回答被截断时的文字显示。', '这是一段尚未结束的 **粗体内容',
      '接下来是截断的公式。', '推导进行到这里：$$\\frac{x^2 + 1}{',
      '接下来是尚未闭合的代码块。', '已经收到的代码：\n\n```typescript\nfunction pendingReply() {\n  const message = "生成尚未结束";',
    ],
  },
];

const memoryCore = [
  '# 概览',
  '你是一位偏工程实践的全栈开发者，主要方向是 AI 应用、Agent 平台与嵌入式系统。你习惯先把问题拆成可验证的小步骤，再逐步实现和验证；比起一次性写完，更看重中间结果可运行、可回退。',
  '你目前关注把模型、工具和真实工作流连接起来：从对话界面、工具调用、记忆与用户画像，到文件处理、数据分析和部署。你希望助手既能给出结论，也能说明取舍和风险。',
  '# 教育与技术背景',
  '你有电子信息工程背景，熟悉 C/C++、Python、TypeScript、嵌入式 Linux、Qt、ROS、Docker、网络编程与音视频处理。你做过网络摄像头、RTMP 推流、图像采集和硬件联调类项目，能读懂数据手册和底层日志。',
  '你在前端方面使用 React、Expo Web 与 Next.js，后端使用 FastAPI、SQLite 和 REST；对 SSE、流式响应、中断恢复、上下文压缩和工具调用循环有实际排障经验。',
  '# 职业方向与工作',
  '你倾向于 AI Agent 工程师方向，关注 Agent Runtime、工具协议、记忆系统、评测与可观测性。你希望工作内容包括真实的业务落地，而不只是模型 API 调用。',
  '你习惯把任务按优先级拆成 P0/P1/P2，先保证主链路可用，再补体验和边界情况。遇到不确定需求时，你希望助手先指出关键假设和风险，而不是直接给出大段代码。',
  '# 项目与协作偏好',
  '你正在维护一个自部署 AI 对话应用，前端是 Expo Web，后端是 FastAPI，数据以服务端为唯一事实源。你重视本地开发可复现、迁移可回滚、错误提示可操作。',
  '你偏好小步提交、先验证再扩展；修改代码前先读现有实现和文档，避免凭记忆写 API。你不喜欢过度抽象，只有在重复出现或边界清晰时才引入新模块。',
  '# 沟通与回答偏好',
  '回答时优先使用中文，技术名词可以保留英文。先给结论，再给理由和步骤；涉及取舍时说明代价。代码要能直接运行，避免省略关键导入和错误处理。',
  '不确定时明确说明不确定点，不要编造版本号、接口字段或测试结果。需要操作文件或执行命令时，先确认路径和影响范围。',
].join('\n\n');

const memoryTopics = [
  '回答先给结论，再展开原因和具体步骤，避免先铺陈背景。',
  '涉及代码时给出可运行的完整片段，并标出需要替换的配置。',
  '优先使用项目现有依赖和约定，不随意引入新的状态管理或网络库。',
  '修改前先阅读相关文件和文档，确认现有契约后再动手。',
  '遇到错误先定位根因，不用静默重试掩盖问题。',
  '对不确定的 API、版本和行为明确标注，不把推测写成事实。',
  '重要改动补充最小回归测试，并说明未覆盖的范围。',
  '长任务拆成可验证的小步，每一步都能运行和回滚。',
  '解释架构时先画数据流，再说明模块职责和边界。',
  '写文档时保持简洁，记录决策原因而不只是操作步骤。',
  '优先保证主链路可用，再处理边缘体验。',
  '处理用户数据时注意隐私，不记录密码、密钥和令牌。',
  '网络请求失败时给出可操作的提示，保留用户已输入内容。',
  '设计接口时考虑幂等、超时、取消和冲突重试。',
  '前端交互保持安静，避免不必要的动画和弹窗。',
  '移动端优先保证可点击区域和键盘可用性。',
  '日志只记录定位所需的信息，不输出正文和凭据。',
  '性能问题先用数据确认瓶颈，再决定是否优化。',
  '部署前在本机验证，不能把未验证的行为写成已验证。',
  '代码评审关注正确性、边界和可维护性，不纠结个人风格。',
];

// The production summary is capped at 4,000 characters; keep the preview at the same size so
// wrapping, scrolling and the dialog layout are exercised with realistic content.
const demoMemorySummary = [
  memoryCore,
  '# 长期偏好',
  ...Array.from({ length: 120 }, (_, index) => {
    const first = memoryTopics[index % memoryTopics.length];
    const second = memoryTopics[(index * 7 + 3) % memoryTopics.length];
    return `- ${first}${index % 2 === 0 ? second : ''}`;
  }),
].join('\n').slice(0, 4_000);

export function createDemoWorkspace(): WorkspaceData {
  const now = Date.now();
  const threads = [...specialThreads, ...Array.from({ length: 100 }, (_, index) => createBulkThread(index))];
  const conversations: Conversation[] = threads.map((thread, index) => ({
    id: thread.id,
    title: thread.title,
    pinned: thread.pinned ?? false,
    updatedAt: now - index * 3_600_000,
    messages: thread.turns.map((turn, index) => {
      const content = typeof turn === 'string' ? turn : turn.content;
      const files = typeof turn === 'string' ? undefined : turn.files;
      return {
        id: `${thread.id}-${index + 1}`,
        role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
        content,
        ...(files?.length ? { files, fileIds: files.map((file) => file.id) } : {}),
      };
    }),
  }));
  return { schemaVersion: 1, chat: { conversations, activeId: conversations[0].id, sidebarOpen: true }, appearance: { themeId: 'twitter', mode: 'system' }, memory: { enabled: true, summary: demoMemorySummary, updatedAt: Date.now() } };
}
