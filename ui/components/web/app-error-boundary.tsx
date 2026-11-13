import { Component, type ErrorInfo, type ReactNode } from 'react';

type Props = { children: ReactNode; resetKey?: string };
type State = { error: Error | null };

/**
 * Without a boundary React removes the whole tree and the page goes blank with no hint,
 * which is how a single bad render (a missing icon import, a transient HMR module) turns
 * into "the sidebar/library/icon sometimes disappears". This keeps the failure on screen
 * and gives the reader the one action that always works: reload.
 */
export class AppErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[Matrius] 界面渲染失败，已隔离出错区域。', error, info.componentStack);
  }

  componentDidUpdate(previous: Props) {
    // A different route deserves a fresh attempt; the failed one would have been replaced.
    if (this.state.error && previous.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return <div className="app-error" role="alert">
      <div className="app-error-card">
        <h1>界面出错了</h1>
        <p>某块界面在渲染时失败，其余内容已停止更新。重新加载通常可以恢复；如果反复出现，把下面这条信息发给维护者。</p>
        <pre>{error.message}</pre>
        <div className="app-error-actions">
          <button type="button" className="primary-button" onClick={() => window.location.reload()}>重新加载</button>
          <button type="button" className="secondary-button" onClick={() => { window.location.href = '/'; }}>返回首页</button>
        </div>
      </div>
    </div>;
  }
}
