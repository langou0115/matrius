import type { AskQuestionSubmission, IntelligentUiBlock } from '@contract/agent-types';

import { AskQuestionCard, WeatherCard } from '@/ui/index';

export type ReplyUiBlocksProps = {
  blocks?: IntelligentUiBlock[];
  streaming?: boolean;
  isLatest?: boolean;
  onSubmitAskQuestion?: (blockId: string, submission: AskQuestionSubmission) => void;
};

export function ReplyUiBlockItem({
  block,
  streaming = false,
  onSubmitAskQuestion,
}: {
  block: IntelligentUiBlock;
  streaming?: boolean;
  onSubmitAskQuestion?: (blockId: string, submission: AskQuestionSubmission) => void;
}) {
  if (block.kind === 'weather') {
    return (
      <WeatherCard
        data={block.data}
        loading={block.loading}
      />
    );
  }

  if (block.kind === 'ask_question') {
    return (
      <AskQuestionCard
        data={block.data}
        disabled={streaming}
        submitted={Boolean(block.submission)}
        initialSubmission={block.submission}
        onSubmit={(submission) => onSubmitAskQuestion?.(block.id, submission)}
      />
    );
  }

  return null;
}

export function ReplyUiBlocks({
  blocks,
  streaming = false,
  isLatest = true,
  onSubmitAskQuestion,
}: ReplyUiBlocksProps) {
  if (!blocks?.length) return null;

  const visibleBlocks = blocks.filter(
    (block) => block.kind !== 'ask_question' || isLatest || Boolean(block.submission),
  );
  if (!visibleBlocks.length) return null;

  return (
    <div className="reply-ui-blocks">
      {visibleBlocks.map((block) => (
        <ReplyUiBlockItem
          key={block.id}
          block={block}
          streaming={streaming}
          onSubmitAskQuestion={onSubmitAskQuestion}
        />
      ))}
    </div>
  );
}
