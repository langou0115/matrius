import { Link } from 'expo-router';
import { LinkAnchor } from '@/components/web/link-anchor';

import { Icon } from '@/components/web/icon';
import { mockItems } from './mock-items';

export default function MockIndexScreen() {
  return <main className="mock-main" id="main-content" tabIndex={-1}>
    <header className="chat-topbar">
      <Link href="/" asChild><LinkAnchor className="settings-back"><Icon name="back" size={18} />返回对话</LinkAnchor></Link>
    </header>
    <div className="settings-scroll"><div className="settings-content">
      <div className="settings-heading">
        <span className="eyebrow">开发预览</span>
        <h1>Mock 测试</h1>
        <p>选择一个测试项，用真实界面组件查看渲染效果。仅开发环境可用。</p>
      </div>
      <section className="settings-section" aria-labelledby="mock-list-heading">
        <h2 id="mock-list-heading">可用测试</h2>
        <div className="mock-list">{mockItems.map((item) => (
          <Link key={item.href} href={item.href} asChild><LinkAnchor className="mock-card">
            <span className="mock-card-icon"><Icon name={item.icon} size={20} /></span>
            <span className="mock-card-text"><strong>{item.title}</strong><span>{item.description}</span></span>
            <Icon name="back" size={16} className="mock-card-arrow" />
          </LinkAnchor></Link>
        ))}</div>
      </section>
    </div></div>
  </main>;
}
