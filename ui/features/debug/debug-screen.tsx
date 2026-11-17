import type { ReactNode } from 'react';

import { Icon, type IconName } from '@/components/web/icon';
import { LinkAnchor } from '@/components/web/link-anchor';
import { mockItems } from '@/features/mock/mock-items';
import { Link, router, useLocalSearchParams } from '@/router';
import { ToolsPanel } from './tools-panel';

type DebugTabId = 'mock' | 'tools';

type DebugTab = {
  id: DebugTabId;
  label: string;
  description: string;
  icon: IconName;
};

/** 后续新增调试栏目只需在此登记并在下方补充对应面板。 */
const DEBUG_TABS: readonly DebugTab[] = [
  {
    id: 'mock',
    label: 'Mock 预览',
    description: '用真实界面组件预览渲染效果',
    icon: 'sparkle',
  },
  {
    id: 'tools',
    label: '工具测试',
    description: '测试 Search、Fetch 等服务端工具',
    icon: 'code',
  },
];

function MockPanel() {
  return (
    <section className="settings-section" aria-labelledby="debug-mock-heading">
      <h2 id="debug-mock-heading">Mock 预览</h2>
      <div className="mock-list">
        {mockItems.map((item) => (
          <Link key={item.href} href={item.href} asChild>
            <LinkAnchor className="mock-card">
              <span className="mock-card-icon"><Icon name={item.icon} size={20} /></span>
              <span className="mock-card-text">
                <strong>{item.title}</strong>
                <span>{item.description}</span>
              </span>
              <Icon name="back" size={16} className="mock-card-arrow" />
            </LinkAnchor>
          </Link>
        ))}
      </div>
    </section>
  );
}

const PANELS: Record<DebugTabId, () => ReactNode> = {
  mock: () => <MockPanel />,
  tools: () => <ToolsPanel />,
};

export default function DebugScreen() {
  const { tab } = useLocalSearchParams<{ tab?: string }>();
  const activeTab: DebugTabId = DEBUG_TABS.some((item) => item.id === tab)
    ? (tab as DebugTabId)
    : 'mock';

  return (
    <main className="debug-main" id="main-content" tabIndex={-1}>
      <header className="chat-topbar">
        <Link href="/" asChild>
          <LinkAnchor className="settings-back">
            <Icon name="back" size={18} />返回对话
          </LinkAnchor>
        </Link>
      </header>
      <div className="settings-scroll">
        <div className="settings-content">
          <div className="settings-heading">
            <span className="eyebrow">开发调试</span>
            <h1>Debug</h1>
            <p>仅在开发阶段存在。切换栏目以预览 Mock 界面或测试服务端工具是否正常。</p>
          </div>

          <div className="debug-tabs" role="tablist" aria-label="Debug 栏目">
            {DEBUG_TABS.map((item) => {
              const selected = item.id === activeTab;
              return (
                <button
                  key={item.id}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  className={`debug-tab${selected ? ' active' : ''}`}
                  onClick={() => router.replace(`/debug?tab=${item.id}`)}
                >
                  <Icon name={item.icon} size={16} />
                  <span>{item.label}</span>
                </button>
              );
            })}
          </div>

          {PANELS[activeTab]()}
        </div>
      </div>
    </main>
  );
}
