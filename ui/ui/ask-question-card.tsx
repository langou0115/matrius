import { useState } from 'react';

import type { AskQuestionAnswer, AskQuestionData, AskQuestionItem, AskQuestionSubmission } from './types';

const CUSTOM_OPTION_ID = '__custom__';

function formatAnswers(
  questions: AskQuestionItem[],
  selections: Record<string, string[]>,
  customTexts: Record<string, string>,
): {
  answers: AskQuestionAnswer[];
  formattedText: string;
} {
  const answers: AskQuestionAnswer[] = [];
  const lines: string[] = [];

  for (const question of questions) {
    const rawSelected = selections[question.id] ?? [];
    const selectedIds = rawSelected.filter((id) => id !== CUSTOM_OPTION_ID);
    const customSelected = question.type === 'text' || rawSelected.includes(CUSTOM_OPTION_ID);
    const options = question.options ?? [];
    const selectedLabels = options
      .filter((opt) => selectedIds.includes(opt.id))
      .map((opt) => opt.label);
    const customText = customSelected ? (customTexts[question.id]?.trim() || undefined) : undefined;

    if (selectedIds.length === 0 && !customText) continue;

    answers.push({
      questionId: question.id,
      prompt: question.prompt,
      selectedIds,
      selectedLabels,
      ...(customText ? { customText } : {}),
    });

    const parts = [...selectedLabels, ...(customText ? [customText] : [])];
    if (questions.length === 1) {
      lines.push(parts.join('、'));
    } else {
      lines.push(`${question.prompt}：${parts.join('、')}`);
    }
  }

  return {
    answers,
    formattedText: lines.join('\n'),
  };
}

function isQuestionAnswered(
  question: AskQuestionItem,
  selections: Record<string, string[]>,
  customTexts: Record<string, string>,
): boolean {
  const rawSelected = selections[question.id] ?? [];
  const hasPreset = rawSelected.some((id) => id !== CUSTOM_OPTION_ID);
  const hasCustomText = Boolean(customTexts[question.id]?.trim());
  if (question.type === 'text') return hasCustomText;
  return hasPreset || (rawSelected.includes(CUSTOM_OPTION_ID) && hasCustomText);
}

function questionKindLabel(question: AskQuestionItem): string {
  if (question.type === 'text') {
    return question.required ? '必填文本' : '可选文本';
  }
  const base = question.type === 'multi' ? '多选' : '单选';
  return question.required === false ? `${base} · 可选` : base;
}

export type AskQuestionCardProps = {
  data: AskQuestionData;
  onSubmit?: (submission: AskQuestionSubmission) => void;
  disabled?: boolean;
  submitted?: boolean;
  initialSubmission?: AskQuestionSubmission;
};

export function AskQuestionCard({
  data,
  onSubmit,
  disabled = false,
  submitted: controlledSubmitted,
  initialSubmission,
}: AskQuestionCardProps) {
  const [selections, setSelections] = useState<Record<string, string[]>>(() => {
    const initial: Record<string, string[]> = {};
    if (initialSubmission) {
      for (const ans of initialSubmission.answers) {
        initial[ans.questionId] = [
          ...ans.selectedIds,
          ...(ans.customText ? [CUSTOM_OPTION_ID] : []),
        ];
      }
    }
    return initial;
  });
  const [customTexts, setCustomTexts] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    if (initialSubmission) {
      for (const ans of initialSubmission.answers) {
        if (ans.customText) initial[ans.questionId] = ans.customText;
      }
    }
    return initial;
  });
  const [localSubmitted, setLocalSubmitted] = useState(Boolean(initialSubmission));

  const isSubmitted = controlledSubmitted ?? localSubmitted;
  const isLocked = disabled || isSubmitted;

  const missingRequiredCount = data.questions.filter((q) => {
    const isRequired = q.type === 'text' ? q.required === true : q.required !== false;
    return isRequired && !isQuestionAnswered(q, selections, customTexts);
  }).length;
  const hasAnyAnswer = data.questions.some((q) => isQuestionAnswered(q, selections, customTexts));
  const canSubmit = !isLocked && missingRequiredCount === 0 && hasAnyAnswer;

  const toggleOption = (question: AskQuestionItem, optionId: string) => {
    if (isLocked) return;
    setSelections((prev) => {
      const current = prev[question.id] ?? [];
      if (question.type === 'single') {
        const next = current.includes(optionId) ? [] : [optionId];
        return { ...prev, [question.id]: next };
      }
      const next = current.includes(optionId)
        ? current.filter((id) => id !== optionId)
        : [...current, optionId];
      return { ...prev, [question.id]: next };
    });
  };

  const selectCustomOption = (question: AskQuestionItem) => {
    if (isLocked) return;
    setSelections((prev) => {
      const current = prev[question.id] ?? [];
      if (question.type === 'single') {
        return { ...prev, [question.id]: [CUSTOM_OPTION_ID] };
      }
      if (current.includes(CUSTOM_OPTION_ID)) return prev;
      return { ...prev, [question.id]: [...current, CUSTOM_OPTION_ID] };
    });
  };

  const handleSubmit = () => {
    if (!canSubmit) return;
    const { answers, formattedText } = formatAnswers(data.questions, selections, customTexts);
    if (!formattedText) return;
    if (controlledSubmitted === undefined) {
      setLocalSubmitted(true);
    }
    onSubmit?.({
      cardId: data.id,
      answers,
      formattedText,
    });
  };

  const countLabel = isSubmitted
    ? '已发送'
    : `${data.questions.length} 个问题`;

  return (
    <section
      className={`iui-card iui-ask-card${isSubmitted ? ' is-submitted' : ''}`}
      aria-label={data.title ?? 'Ask Question'}
    >
      <header className="iui-ask-header">
        <div className="iui-ask-title-row">
          <span className="iui-ask-title-left">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="m3 17 2 2 4-4" />
              <path d="m3 7 2 2 4-4" />
              <path d="M13 6h8" />
              <path d="M13 12h8" />
              <path d="M13 18h8" />
            </svg>
            <strong>{data.title ?? 'Ask Question'}</strong>
          </span>
          <span className={`iui-ask-badge${isSubmitted ? ' is-done' : ''}`}>
            {countLabel}
          </span>
        </div>
        {data.description && <p className="iui-ask-description">{data.description}</p>}
      </header>

      <div className="iui-ask-questions">
        {data.questions.map((question, qIndex) => {
          const selectedIds = selections[question.id] ?? [];
          const customSelected = selectedIds.includes(CUSTOM_OPTION_ID);
          const customValue = customTexts[question.id] ?? '';
          const options = question.options ?? [];

          return (
            <fieldset key={question.id} className="iui-ask-question" disabled={isLocked}>
              <legend className="iui-ask-prompt">
                <span>
                  {qIndex + 1}. {question.prompt}
                </span>
                <span className="iui-ask-kind">{questionKindLabel(question)}</span>
              </legend>

              {question.type !== 'text' ? (
                <div className="iui-ask-list" role={question.type === 'single' ? 'radiogroup' : 'group'}>
                  {options.map((option) => {
                    const checked = selectedIds.includes(option.id);
                    return (
                      <button
                        key={option.id}
                        type="button"
                        role={question.type === 'single' ? 'radio' : 'checkbox'}
                        aria-checked={checked}
                        disabled={isLocked}
                        className={`iui-ask-list-item${checked ? ' is-selected' : ''}`}
                        onClick={() => toggleOption(question, option.id)}
                      >
                        <span
                          className={`iui-ask-indicator ${question.type === 'single' ? 'is-radio' : 'is-check'}`}
                          aria-hidden="true"
                        >
                          {checked && (
                            question.type === 'single' ? (
                              <span className="iui-ask-dot" />
                            ) : (
                              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                                <path d="m5 12 4 4L19 6" />
                              </svg>
                            )
                          )}
                        </span>
                        <span className="iui-ask-option-text">
                          <strong>{option.label}</strong>
                          {option.description && <span>{option.description}</span>}
                        </span>
                      </button>
                    );
                  })}

                  <div
                    className={`iui-ask-list-item is-custom${customSelected ? ' is-selected' : ''}`}
                  >
                    <button
                      type="button"
                      role={question.type === 'single' ? 'radio' : 'checkbox'}
                      aria-checked={customSelected}
                      aria-label="自定义选项"
                      disabled={isLocked}
                      className="iui-ask-custom-toggle"
                      onClick={() => toggleOption(question, CUSTOM_OPTION_ID)}
                    >
                      <span
                        className={`iui-ask-indicator ${question.type === 'single' ? 'is-radio' : 'is-check'}`}
                        aria-hidden="true"
                      >
                        {customSelected && (
                          question.type === 'single' ? (
                            <span className="iui-ask-dot" />
                          ) : (
                            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                              <path d="m5 12 4 4L19 6" />
                            </svg>
                          )
                        )}
                      </span>
                    </button>
                    <textarea
                      rows={1}
                      className="iui-ask-custom-input"
                      value={customValue}
                      disabled={isLocked}
                      placeholder={question.customPlaceholder ?? '其他（请填写）...'}
                      aria-label={`${question.prompt} 自定义选项`}
                      onKeyDown={(event) => {
                        if (
                          event.key === 'Enter'
                          && !event.shiftKey
                          && !event.nativeEvent.isComposing
                        ) {
                          event.preventDefault();
                          handleSubmit();
                        }
                      }}
                      onChange={(event) => {
                        const el = event.currentTarget;
                        el.style.height = 'auto';
                        el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
                        el.style.overflowY = el.scrollHeight > 160 ? 'auto' : 'hidden';
                        const nextVal = el.value;
                        const wasEmpty = !customValue.trim();
                        setCustomTexts((prev) => ({ ...prev, [question.id]: nextVal }));
                        if (!isLocked && wasEmpty && nextVal.trim() && !customSelected) {
                          selectCustomOption(question);
                        }
                      }}
                    />
                  </div>
                </div>
              ) : (
                <div className="iui-ask-custom">
                  <textarea
                    rows={1}
                    value={customValue}
                    disabled={isLocked}
                    placeholder={question.customPlaceholder ?? '输入回答...'}
                    aria-label={`${question.prompt} 文本输入`}
                    onChange={(event) => {
                      const el = event.currentTarget;
                      el.style.height = 'auto';
                      el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
                      el.style.overflowY = el.scrollHeight > 160 ? 'auto' : 'hidden';
                      const nextVal = el.value;
                      setCustomTexts((prev) => ({ ...prev, [question.id]: nextVal }));
                    }}
                  />
                </div>
              )}
            </fieldset>
          );
        })}
      </div>

      <footer className="iui-ask-footer">
        <span className="iui-ask-status">
          {isSubmitted
            ? '已直接发送，无需在输入框重复输入'
            : missingRequiredCount > 0
              ? `还有 ${missingRequiredCount} 项必选未完成`
              : '所有问题一次性提交'}
        </span>
        <button
          type="button"
          className="iui-ask-submit-btn"
          disabled={!canSubmit}
          onClick={handleSubmit}
        >
          {isSubmitted ? (
            <>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="m5 12 4 4L19 6" />
              </svg>
              <span>已发送</span>
            </>
          ) : (
            <>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="m22 2-7 20-4-9-9-4Z" />
                <path d="M22 2 11 13" />
              </svg>
              <span>{data.submitLabel ?? '提交全部答案'}</span>
            </>
          )}
        </button>
      </footer>
    </section>
  );
}
