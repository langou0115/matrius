import type { Conversation } from '../../src/features/chat/chat-state';
import type { WorkspaceData } from '../../src/features/workspace/workspace-repository.web';

// Inspired by OpenStudio's software-test seed: bulk multi-turn threads plus
// focused Markdown, math and 50-round cases. Loaded only by the dev preview.
type Thread = { id: string; title: string; pinned?: boolean; turns: string[] };

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

const specialThreads: Thread[] = [
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

export function createDemoWorkspace(): WorkspaceData {
  const now = Date.now();
  const threads = [...specialThreads, ...Array.from({ length: 100 }, (_, index) => createBulkThread(index))];
  const conversations: Conversation[] = threads.map((thread, index) => ({
    id: thread.id,
    title: thread.title,
    pinned: thread.pinned ?? false,
    updatedAt: now - index * 3_600_000,
    messages: thread.turns.map((content, turn) => ({ id: `${thread.id}-${turn + 1}`, role: turn % 2 === 0 ? 'user' : 'assistant', content })),
  }));
  return { schemaVersion: 1, chat: { conversations, activeId: conversations[0].id, sidebarOpen: true }, appearance: { themeId: 'twitter', mode: 'system' } };
}
