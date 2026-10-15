import { Link } from 'expo-router';

export function DemoToolbar() {
  return <div className="demo-toolbar" aria-label="开发示例预览">
    <span>Mock 预览</span>
    <Link href="/mock" asChild><a>目录</a></Link>
    <button onClick={() => window.location.reload()}>重置</button>
    <Link href="/" asChild><a>退出</a></Link>
  </div>;
}
