import { Link } from 'expo-router';

import { Icon } from '@/components/web/icon';

const pages = [
  { title: '对话与侧栏', href: '/mock/chat', icon: 'chat', description: '10 组对话、置顶、长标题、搜索、菜单、多轮消息和代码块。' },
  { title: '外观与设置', href: '/mock/settings', icon: 'monitor', description: '全页设置、10 套配色，以及浅色、深色和跟随系统。' },
] as const;

export default function MockDirectory() {
  return <main className="mock-directory" id="main-content">
    <div className="mock-directory-content">
      <span className="eyebrow">Matrius · 开发预览</span>
      <h1>Mock 预览</h1>
      <p>使用独立示例数据查看界面与交互。所有修改仅在本次预览中生效。</p>
      <div className="mock-page-list">{pages.map((page) => <Link key={page.href} href={page.href} asChild><a className="mock-page-link">
        <span className="empty-icon"><Icon name={page.icon} size={24} /></span>
        <span><strong>{page.title}</strong><span>{page.description}</span><code>{page.href}</code></span>
        <Icon name="back" size={18} className="result-arrow" />
      </a></Link>)}</div>
      <Link href="/" asChild><a className="settings-back"><Icon name="back" size={17} />返回应用</a></Link>
    </div>
  </main>;
}
