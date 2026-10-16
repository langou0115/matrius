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
    href: '/mock/chat',
    title: '聊天渲染测试',
    description: '109 个会话、1730 条消息，覆盖 Markdown、公式、代码高亮与长对话渲染。',
    icon: 'chat',
  },
];

/** 由当前路径反查所属测试项，子路径（如分支、滚动锚点）也算在该项内。 */
export function mockItemForPath(pathname: string): MockItem | undefined {
  return mockItems.find((item) => pathname === item.href || pathname.startsWith(`${item.href}/`));
}
