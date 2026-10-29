import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { ActionSheet } from '@/components/native/action-sheet';
import { Button } from '@/components/native/button';
import { Dialog } from '@/components/native/dialog';
import { Field } from '@/components/native/field';
import type { Conversation } from '../chat-state';

/** Long-press action sheet for one conversation, plus its rename and delete dialogs. */
export function ConversationMenu({ conversation, visible, onClose, onPin, onRename, onDelete }: {
  conversation: Conversation;
  visible: boolean;
  onClose: () => void;
  onPin: () => void;
  onRename: (title: string) => void;
  onDelete: () => void;
}) {
  // The sidebar unmounts this component on close, so fresh state comes from props.
  const [editing, setEditing] = useState<'rename' | 'delete' | null>(null);
  const [title, setTitle] = useState(conversation.title);

  function closeAll() {
    setEditing(null);
    onClose();
  }

  function save() {
    if (!title.trim()) return;
    onRename(title.trim());
    closeAll();
  }

  return (
    <>
      <ActionSheet
        visible={visible && editing === null}
        title={conversation.title}
        onClose={closeAll}
        items={[
          { label: conversation.pinned ? '取消置顶' : '置顶', onPress: () => onPin() },
          { label: '重命名', onPress: () => setEditing('rename') },
          { label: '删除', destructive: true, onPress: () => setEditing('delete') },
        ]}
      />

      <Dialog
        visible={editing === 'rename'}
        title="重命名对话"
        onClose={closeAll}
        footer={
          <View style={styles.footer}>
            <Button label="取消" variant="secondary" onPress={closeAll} />
            <Button label="保存名称" variant="primary" disabled={!title.trim()} onPress={save} />
          </View>
        }
      >
        <Field label="对话标题" value={title} onChangeText={setTitle} maxLength={120} autoFocus returnKeyType="done" onSubmitEditing={save} />
      </Dialog>

      <Dialog
        visible={editing === 'delete'}
        title="删除这段对话？"
        description={`“${conversation.title}”及其消息将被删除，此操作无法撤销。`}
        onClose={closeAll}
        footer={
          <View style={styles.footer}>
            <Button label="取消" variant="secondary" onPress={closeAll} />
            <Button label="删除对话" variant="destructive" onPress={() => { onDelete(); closeAll(); }} />
          </View>
        }
      />
    </>
  );
}

const styles = StyleSheet.create({
  footer: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, flex: 1 },
});
