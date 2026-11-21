import { Icon } from '@/components/web/icon';
import { SidebarMenu } from '@/components/web/sidebar-menu';
import type { Conversation } from '../chat-state';

type Props = {
  conversation: Conversation;
  anchor: HTMLButtonElement;
  onClose: () => void;
  onPin: () => void;
  onRename: () => void;
  onDelete: () => void;
};

export function ConversationMenu({ conversation, anchor, onClose, onPin, onRename, onDelete }: Props) {
  return (
    <SidebarMenu
      id="conversation-menu"
      label={`对话操作：${conversation.title}`}
      anchor={anchor}
      rowSelector=".conversation-item"
      onClose={onClose}
    >
      <button role="menuitem" onClick={onPin}><Icon name="pin" size={17} />{conversation.pinned ? '取消置顶' : '置顶'}</button>
      <button role="menuitem" onClick={onRename}><Icon name="pen" size={17} />重命名</button>
      <button role="menuitem" className="danger-text" onClick={onDelete}><Icon name="trash" size={17} />删除</button>
    </SidebarMenu>
  );
}
