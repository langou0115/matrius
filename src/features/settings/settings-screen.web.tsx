import { Link, type Href } from 'expo-router';
import { useState } from 'react';

import { Icon } from '@/components/web/icon';
import { LinkAnchor } from '@/components/web/link-anchor';
import { useAppearance } from '@/theme/appearance';
import { themePresets } from '@/theme/presets';
import { displayModes, searchSettings } from './settings-catalog';
import { useModels } from '@/features/models/model-state';
import { SettingsPage, useSettingsRoot } from './settings-page.web';

export default function SettingsScreen() {
  const [query, setQuery] = useState('');
  const root = useSettingsRoot();
  const { models } = useModels();
  const { themeId, mode } = useAppearance();
  const results = searchSettings(query);
  const searching = query.trim().length > 0;
  const currentValues = {
    appearance: `${displayModes.find((item) => item.id === mode)?.label} · ${themePresets.find((item) => item.id === themeId)?.name}`,
    models: models.length ? `${models.length} 个模型` : '未配置',
    about: 'v1.0.0',
  };

  return <SettingsPage title="设置" description="找到你想调整的内容。" index>
    <div className="settings-search" role="search" aria-label="搜索设置">
      <Icon name="search" size={19} />
      <input type="search" aria-label="搜索设置项" placeholder="搜索设置，如深色、主题…" value={query} onChange={(event) => setQuery(event.target.value)} />
      {query && <button className="icon-button" type="button" aria-label="清空搜索" onClick={() => setQuery('')}><Icon name="close" size={16} /></button>}
    </div>
    {searching && <p className="settings-result-count" role="status">找到 {results.length} 项设置</p>}
    {results.length ? <nav aria-label="设置项目">{(searching ? ['搜索结果'] : ['偏好', '应用']).map((group) => {
      const items = searching ? results : results.filter((item) => item.group === group);
      if (!items.length) return null;
      return <section className="settings-section settings-directory" key={group} aria-label={group}>
        <h2>{group}</h2>
        <div className="settings-entry-list">{items.map((item) => {
          const href: Href = `${root}/${item.id}`;
          return <Link key={item.id} href={href} asChild><LinkAnchor className="settings-entry">
            <span className="settings-entry-icon"><Icon name={item.icon} size={21} /></span>
            <span className="settings-entry-text"><strong>{item.title}</strong><span>{item.description}</span></span>
            <span className="settings-entry-value">{currentValues[item.id]}</span>
            <Icon name="chevron" size={17} className="settings-entry-chevron" />
          </LinkAnchor></Link>;
        })}</div>
      </section>;
    })}</nav> : <div className="settings-search-empty">
      <Icon name="search" size={26} /><h2>没有找到相关设置</h2><p>试试“显示模式”“主题”或“版本”。</p>
      <button className="secondary-button" onClick={() => setQuery('')}>查看全部设置</button>
    </div>}
  </SettingsPage>;
}
