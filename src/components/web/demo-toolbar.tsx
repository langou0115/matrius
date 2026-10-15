import { Link } from 'expo-router';
import { LinkAnchor } from '@/components/web/link-anchor';

export function DemoToolbar() {
  return <div className="demo-toolbar" aria-label="开发示例预览">
    <span>聊天渲染测试</span>
    <button onClick={() => window.location.reload()}>重置</button>
    <Link href="/" asChild><LinkAnchor>退出</LinkAnchor></Link>
  </div>;
}
