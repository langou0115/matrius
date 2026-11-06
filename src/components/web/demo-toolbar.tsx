import { Link, usePathname } from '@/router';
import { LinkAnchor } from '@/components/web/link-anchor';

import { mockItemForPath } from '@/features/mock/mock-items';

export function DemoToolbar() {
  const pathname = usePathname().replace(/\/$/, '');
  const item = mockItemForPath(pathname);
  // mock 索引页本身就是导航，不需要这条工具条。
  if (!item) return null;
  return <div className="demo-toolbar" aria-label="开发示例预览">
    <span>{item.title}</span>
    <Link href="/mock" asChild><LinkAnchor>索引</LinkAnchor></Link>
    <button onClick={() => window.location.reload()}>重置</button>
    <Link href="/" asChild><LinkAnchor>退出</LinkAnchor></Link>
  </div>;
}
