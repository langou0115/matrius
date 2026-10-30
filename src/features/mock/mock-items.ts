import type { Href } from 'expo-router';
import type { IconName } from '@/components/web/icon';

// app.json 开启了 experiments.typedRoutes，路由类型是字面量联合而不是 string，
// 直接用 string 会让 <Link href={item.href}> 报类型错误。
type MockHref = Extract<Href, string>;

export type MockItem = {
  href: MockHref;
  title: string;
  description: string;
  icon: IconName;
};

/** 每项对应 src/app/mock/ 下的一个路由，该路由复用真实页面组件而不是另写一套。 */
export const mockItems: readonly MockItem[] = [
  {
    href: '/mock/process',
    title: '回复过程预览',
    description: '切换等待、思考、搜索、完成、主动停止与连接中断，检查真实组件的展示。',
    icon: 'sparkle',
  },
  {
    href: '/mock/chat',
    title: '聊天渲染测试',
    description: '112 个会话、1735 条消息，覆盖 Markdown、公式、代码高亮、生成文件列表与长对话渲染。',
    icon: 'chat',
  },
  {
    href: '/mock/library',
    title: '资料库渲染测试',
    description: '500 个生成文件，覆盖搜索、图片/文件筛选、排序、分页、重命名与批量删除。',
    icon: 'folder',
  },
];

/** 由当前路径反查所属测试项，子路径（如分支、滚动锚点）也算在该项内。 */
export function mockItemForPath(pathname: string): MockItem | undefined {
  return mockItems.find((item) => pathname === item.href || pathname.startsWith(`${item.href}/`));
}
