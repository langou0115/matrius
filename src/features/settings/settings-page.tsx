import { Link, useLocalSearchParams, usePathname, type Href } from '@/router';
import { ArrowLeft, ChartColumn, Cloud, Cpu, HardDrive, Info, Palette, Search, SlidersHorizontal, UserRound, X, type LucideIcon } from 'lucide-react';
import { useEffect, useState, type PropsWithChildren } from 'react';

import { LinkAnchor } from '@/components/web/link-anchor';
import { useIsPreview } from '@/features/workspace/preview-context';
import { useChat } from '@/features/chat/chat-state';
import { conversationHref } from '@/features/chat/conversation-href';
import { useAuth } from '@/features/auth/auth-state';

import { searchSettings, searchSettingsContent, visibleSettings } from './settings-catalog';

export function useSettingsRoot() {
  return useIsPreview() ? '/mock/chat/settings' : '/settings';
}

/** Settings navigation uses generic UI glyphs from lucide; model brand marks stay with
    the model picker, which renders them from thesvg. */
const categoryIcons: Record<string, LucideIcon> = {
  appearance: Palette,
  personalization: SlidersHorizontal,
  models: Cpu,
  about: Info,
  account: UserRound,
  storage: HardDrive,
  usage: ChartColumn,
  sync: Cloud,
};

function CategoryIcon({ id, size = 18 }: { id: string; size?: number }) {
  const Glyph = categoryIcons[id] ?? Info;
  return <Glyph size={size} strokeWidth={1.75} aria-hidden="true" />;
}

/** Desktop settings shell shared by every category: a fixed category rail on the left and the
    active category's content on the right. Categories are ordinary routes, so browser history
    and direct refreshes keep working while switching only swaps this page's content. */
export function SettingsPage({ title, description, children }: PropsWithChildren<{ title: string; description: string }>) {
  const [query, setQuery] = useState('');
  const { focus } = useLocalSearchParams<{ focus?: string }>();
  const preview = useIsPreview();
  const { activeId: conversationId } = useChat();
  const root = useSettingsRoot();
  const { user } = useAuth();
  const settingsItems = visibleSettings(
    user?.mustChangePassword ? [] : user?.features ?? [],
    preview,
    Boolean(user && !user.mustChangePassword),
  );
  const pathname = usePathname().replace(/\/$/, '');
  const homeHref = conversationHref(conversationId, preview);
  // Account, usage, storage and sync are full app pages rather than preview chat settings,
  // so they always live under /settings even when the rest of the catalogue is scoped to /mock.
  const directRoutes = new Set(['account', 'storage', 'usage']);
  // Routes are built from the catalogue IDs above; typed routes cannot express that a runtime
  // string is one of the generated static paths, so narrow at this single boundary.
  const itemHref = (id: string): Href => (directRoutes.has(id) ? `/settings/${id}` : `${root}/${id}`) as Href;
  const activeId = settingsItems.find((item) => pathname === itemHref(item.id))?.id;
  const groups = settingsItems.reduce<string[]>((list, item) => (list.includes(item.group) ? list : [...list, item.group]), []);
  const searching = query.trim().length > 0;
  const contentMatches = searching ? searchSettingsContent(query).filter((target) => settingsItems.some((item) => item.id === target.category)) : [];
  // A category row is redundant when its contents already match.
  const categoryMatches = searching ? searchSettings(query).filter((item) => settingsItems.some((visible) => visible.id === item.id)
    && !contentMatches.some((target) => target.category === item.id)) : [];
  const noResults = searching && !contentMatches.length && !categoryMatches.length;

  // Results link to a category with `?focus=<heading id>`; scroll that heading into view once
  // the target page mounts. The panel is the scroll container, and the 24px offset matches the
  // section spacing so the focused heading does not stick to the top edge.
  useEffect(() => {
    if (!focus) return;
    const target = document.getElementById(focus);
    const container = target?.closest<HTMLElement>('.settings-scroll');
    if (!target || !container) return;
    const section = target.closest('.settings-section');
    // The first section sits right below the category heading, so an un-scrolled page already
    // shows it; jumping would only hide the page title.
    if (section && section === section.parentElement?.querySelector('.settings-section') && container.scrollTop === 0) return;
    const top = target.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop;
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    container.scrollTo({ top: Math.max(0, top - 24), behavior: reduceMotion ? 'auto' : 'smooth' });
  }, [focus, pathname]);

  function categoryOf(id: string) { return settingsItems.find((item) => item.id === id); }

  return <main className={`settings-main ${pathname === root ? 'settings-index' : 'settings-detail'}`} id="main-content" tabIndex={-1}>
    <aside className="settings-sidebar" aria-label="设置导航">
      <Link href={homeHref} replace asChild>
        <LinkAnchor className="settings-back"><ArrowLeft size={18} strokeWidth={1.75} aria-hidden="true" /><span>返回对话</span></LinkAnchor>
      </Link>
      <div className="settings-search" role="search" aria-label="搜索设置">
        <Search size={16} strokeWidth={1.75} aria-hidden="true" />
        <input type="search" aria-label="搜索设置项" placeholder="搜索设置" value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Escape') setQuery(''); }} />
        {query && <button type="button" className="icon-button" aria-label="清空搜索" onClick={() => setQuery('')}><X size={14} strokeWidth={2} aria-hidden="true" /></button>}
      </div>
      <nav className="settings-nav" aria-label="设置分类">
        {searching ? (noResults
          ? <p className="settings-search-empty" role="status">没有找到相关设置</p>
          : <section className="settings-nav-group">
            <h2>搜索结果</h2>
            {contentMatches.map((target) => {
              const category = categoryOf(target.category);
              const href = `${itemHref(target.category)}?focus=${target.sectionId}` as Href;
              return <Link key={target.id} href={href} asChild>
                <LinkAnchor className="settings-nav-item settings-search-result" onClick={() => setQuery('')}>
                  <CategoryIcon id={target.category} />
                  <span>{target.title}</span>
                  <span className="settings-search-result-category">{category?.title}</span>
                </LinkAnchor>
              </Link>;
            })}
            {categoryMatches.map((item) => {
              const href: Href = itemHref(item.id);
              return <Link key={item.id} href={href} asChild>
                <LinkAnchor className="settings-nav-item settings-search-result" onClick={() => setQuery('')}>
                  <CategoryIcon id={item.id} />
                  <span>{item.title}</span>
                  <span className="settings-search-result-category">{item.group}</span>
                </LinkAnchor>
              </Link>;
            })}
          </section>)
          : groups.map((group) => <section className="settings-nav-group" key={group}>
            <h2>{group}</h2>
            {settingsItems.filter((item) => item.group === group).map((item) => {
              const href: Href = itemHref(item.id);
              return <Link key={item.id} href={href} asChild>
                <LinkAnchor className={`settings-nav-item ${activeId === item.id ? 'is-active' : ''}`} aria-current={activeId === item.id ? 'page' : undefined}>
                  <CategoryIcon id={item.id} />
                  <span>{item.title}</span>
                </LinkAnchor>
              </Link>;
            })}
          </section>)}
      </nav>
    </aside>
    <div className="settings-panel">
      <Link href={root} asChild><LinkAnchor className="settings-stack-back"><ArrowLeft size={18} aria-hidden="true" />设置</LinkAnchor></Link>
      <div className="settings-scroll">
        <div className="settings-content">
          <div className="settings-heading"><h1>{title}</h1><p>{description}</p></div>
          {children}
        </div>
      </div>
    </div>
  </main>;
}
