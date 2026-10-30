import { useState } from 'react';

import { StorageErrorToast } from '@/components/web/storage-error-toast.web';

/** Mirrors the strings produced by the workspace persistence error path. */
const variants = [
  ['network', '网络中断', '最新修改未能保存到云端：暂时无法连接服务器。请检查网络后重试。'],
  ['conflict', '其他设备修改', '最新修改未能保存到云端：消息已在其他设备更新，请刷新后重试。（409 conflict）。内容已保留，可重试保存。'],
  ['rate', '写入频繁', '最新修改未能保存到云端：写入过于频繁（429），请稍等片刻再点“重试保存”。'],
  ['server', '服务器错误', '最新修改未能保存到云端：请求未能完成，请重试。（500 internal_error）。内容已保留，可重试保存。'],
  ['local', '浏览器存储失败', '最新修改未能保存到浏览器，关闭页面可能丢失这些修改。'],
  ['fallback', '通用兜底', '最新修改未能保存到云端。请检查网络后重试；若其他设备已修改，请保留内容后刷新。'],
] as const;
type Variant = typeof variants[number][0];

export default function StoragePreview() {
  const [variant, setVariant] = useState<Variant>('network');
  const [visible, setVisible] = useState(true);
  const [retries, setRetries] = useState(0);
  const [, , message] = variants.find(([value]) => value === variant) ?? variants[0];

  return <div className="chat-screen"><main className="chat-main has-messages" id="main-content">
    <header className="chat-topbar"><strong>保存失败提示</strong></header>
    <div className="messages-scroll"><div className="messages-content">
      <p className="process-preview-intro">使用真实的保存失败提示组件，只切换文案，不触发任何保存请求。</p>
      <div className="process-preview-controls" role="group" aria-label="提示类型">
        {variants.map(([value, label]) => <button type="button" key={value} aria-pressed={variant === value}
          onClick={() => { setVariant(value); setVisible(true); }}>{label}</button>)}
      </div>
      <div className="process-preview-controls" role="group" aria-label="显示状态">
        <button type="button" aria-pressed={visible} onClick={() => setVisible((open) => !open)}>
          {visible ? '隐藏提示' : '显示提示'}
        </button>
      </div>
      <p className="process-preview-intro">提示固定在页面顶部。用鼠标在文字上拖动即可选中，Ctrl+C（macOS 为 ⌘C）复制；点击「重试保存」会记录次数。</p>
      <p className="process-preview-intro" role="status">已点击重试 {retries} 次（mock 不会真的保存）。</p>
    </div></div>
    {visible && <StorageErrorToast message={message} onRetry={() => setRetries((current) => current + 1)} />}
  </main></div>;
}
