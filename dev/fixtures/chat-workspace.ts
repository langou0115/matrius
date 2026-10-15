import type { Conversation } from '../../src/features/chat/chat-state';
import type { WorkspaceData } from '../../src/features/workspace/workspace-repository.web';

// Explicit development preview only. Never imported by the production branch.
const threads: { title: string; pinned?: boolean; turns: string[] }[] = [
  {
    title: '把想法整理成一份产品计划', pinned: true,
    turns: [
      '我想做一个轻量的阅读笔记工具，应该从哪里开始？',
      '先从一个最小的使用场景开始：读到值得留下的内容时，能迅速记录，再在需要的时候找回来。\n\n第一版可以只做三件事：\n1. 保存一段摘录，并记录来源。\n2. 写下一两句自己的想法。\n3. 按关键词找回笔记。\n\n暂时不用急着做知识图谱。先让记录这件事足够轻松，再观察哪些笔记会被重新打开。',
      '如果只有两周时间，你会怎么安排？',
      '可以按一周跑通、一周打磨来安排。\n\n**第一周：完成闭环**\n做出笔记列表、编辑和搜索，让一条笔记能够被创建、修改、找到和删除。\n\n**第二周：改善手感**\n打磨输入焦点、键盘快捷键、长内容排版和空状态。最后找几位真实读者试用，看看他们最容易卡在哪一步。\n\n验收标准可以很简单：从读到一段话，到留下自己的笔记，不超过半分钟。',
    ],
  },
  {
    title: 'React 状态更新与组件渲染', pinned: true,
    turns: [
      '为什么修改 ref 不会让 React 组件重新渲染？',
      '因为 ref 是一个可以跨渲染保存的普通容器。修改它的 `current` 属性，不会通知 React 调度新的渲染。\n\nstate 的作用不同：调用更新函数时，React 会记录下一份状态，并安排组件重新执行。\n\n可以这样区分：\n• 需要反映在界面上的值，用 state。\n• 定时器句柄、DOM 引用、上一次请求的标识等，用 ref。',
      '给我一个简单的计数器例子。',
      '下面的计数使用 state，按钮点击后会更新界面：\n\n```tsx\nfunction Counter() {\n  const [count, setCount] = useState(0);\n\n  return (\n    <button onClick={() => setCount(value => value + 1)}>\n      已点击 {count} 次\n    </button>\n  );\n}\n```\n\n这里使用函数形式的更新，可以基于最新状态计算下一次计数。',
    ],
  },
  {
    title: '周末两天，给自己留一点空白',
    turns: [
      '帮我安排一个不赶路的周末，不需要具体城市推荐。',
      '周六留给外面，周日留给自己。\n\n**周六**\n睡到自然醒，找一家步行可达的地方吃早饭。下午选一条熟悉但平时没空慢慢走的路，带上耳机或一本书。晚上留空，不赶第二场。\n\n**周日**\n上午收拾一个小角落，时间控制在半小时。下午做一顿简单的饭，把下一周需要的东西准备好。剩下的时间，允许自己什么都不完成。',
    ],
  },
  {
    title: '设计一个同时兼顾中文、英文与超长内容的聊天侧栏标题，用来观察单行省略和菜单预留空间',
    turns: [
      '这是一条很长的会话标题，用来看看侧栏是否会挤压右侧的操作按钮。',
      '标题应该保持单行，超出的部分使用省略号。操作按钮的位置需要提前预留，即使鼠标移入后才显示，也不应该让文字发生跳动。\n\n你可以切换窗口宽度，或者给这段对话重命名，观察不同长度下的显示效果。',
    ],
  },
  {
    title: '把这段介绍改得更自然',
    turns: [
      '帮我润色这句话：本产品致力于为广大用户提供高效便捷的个人信息记录与管理体验。',
      '可以改成：\n\n把值得记住的事留下来，需要的时候轻松找到。\n\n如果希望保留一点功能介绍，也可以写成：\n\n随手记录想法、整理资料，在需要时快速找回。',
      '第二个版本不错，再短一点。',
      '随手记录，轻松找回。',
    ],
  },
  {
    title: '浏览器里的数据会保存在哪里？',
    turns: [
      'Web 版关闭页面后，对话还会保留吗？',
      '已成功保存的对话会留在当前浏览器的站点存储中。下次使用相同的浏览器、相同的网站地址打开，就可以继续查看。\n\n清除该网站的数据会删除这些记录。不同浏览器、不同设备之间也不会自动共享，跨设备使用需要另外接入同步。',
    ],
  },
  {
    title: '长对话：从一个想法聊到可以执行的步骤',
    turns: [
      '我想每周写一点东西，但总觉得没有主题。',
      '不用先找一个很大的主题，可以从最近的一次具体经历开始。比如一次你改了主意的讨论、一件花了很久才弄明白的小事，或者一个与预期不同的结果。\n\n先写“发生了什么”，再写“我原来怎么想”，最后写“现在我会怎么做”。',
      '如果写着写着开始跑题呢？',
      '先把最想说的那句话写在文档顶部。每写完一段，就看它是否在帮助读者理解这句话。\n\n暂时用不上的段落可以移到旁边，不必立刻删掉。这样更容易继续写，也能避免为了保住某个喜欢的句子而拉散整篇文章。',
      '能不能给我一个简单的大纲？',
      '可以用四段：\n\n1. **一个具体场景**：让读者知道你遇到了什么。\n2. **原来的判断**：交代当时为什么这样想。\n3. **变化的原因**：用事实说明你的看法在哪里发生了改变。\n4. **下一次的做法**：留下一个可以执行的小结。\n\n每一段只承担一件事，不需要平均分配篇幅。',
      '我希望读起来像聊天，而不是工作汇报。',
      '那就从动作和细节写起，少用抽象的结论。\n\n比如，把“沟通效率得到了提升”改成“这次我们十分钟就确定了方案，上次花了一个下午”。具体变化会替你解释结果。\n\n写完后可以大声读一遍。读到需要停下来重新理解的地方，通常就是可以拆短、换词，或者补一个例子的地方。',
      '好，帮我总结一下今天的步骤。',
      '今天只做三件事就够了：\n\n• 选一个这周真实发生的小场景。\n• 按四段大纲写完第一稿，暂时不纠结句子。\n• 大声读一遍，把不像自己会说的话改掉。\n\n第一稿写到三四百字就可以停。比起一次写得很完整，先让“写完一篇”变成一件容易发生的事。',
    ],
  },
  { title: 'A small idea, a clearer next step', turns: ['How can I make a vague task easier to start?', 'Choose a first step you can finish in fifteen minutes. Describe the action with a verb, decide what “done” looks like, and leave the larger plan for after that first step.'] },
  { title: '今天的三个小想法', turns: ['记录三个想法：整理书桌、写一封信、做一顿晚饭。', '已经有一个很好的开始。选其中最容易动手的一件，给它留出一点完整的时间。'] },
  { title: '界面留白与阅读节奏', turns: ['长文本怎样排版更容易读？', '先控制行宽，再用段落间距建立节奏。\n\n一段只讲一个意思；段落变长时，先考虑拆分内容。留白应该帮助读者识别结构，而不是把每句话都分散到很远。'] },
];

export function createDemoWorkspace(): WorkspaceData {
  const now = Date.now();
  const conversations: Conversation[] = threads.map<Conversation>((thread, index) => ({
    id: `dev-preview-${index + 1}`,
    title: thread.title,
    pinned: thread.pinned ?? false,
    updatedAt: now - index * 3_600_000,
    messages: thread.turns.map((content, turn) => ({ id: `dev-preview-${index + 1}-${turn + 1}`, role: turn % 2 === 0 ? 'user' : 'assistant', content })),
  }));
  return { schemaVersion: 1, chat: { conversations, activeId: conversations[0].id, sidebarOpen: true }, appearance: { themeId: 'twitter', mode: 'system' } };
}
