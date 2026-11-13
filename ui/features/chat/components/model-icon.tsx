import Anthropic from '@thesvg/react/anthropic';
import Claude from '@thesvg/react/claude';
import Deepseek from '@thesvg/react/deepseek';
import Doubao from '@thesvg/react/doubao';
import Gemini from '@thesvg/react/gemini';
import Grok from '@thesvg/react/grok';
import Kimi from '@thesvg/react/kimi';
import Minimax from '@thesvg/react/minimax';
import Mistral from '@thesvg/react/mistral';
import Ollama from '@thesvg/react/ollama';
import Openai from '@thesvg/react/openai';
import Qwen from '@thesvg/react/qwen';

import { Icon } from '@/components/web/icon';

type Props = { modelId?: string; name?: string; providerName?: string; size?: number };

/** Model identity wins over the gateway's name (for example Claude through a proxy). */
export function ModelIcon({ modelId = '', name = '', providerName = '', size = 18 }: Props) {
  const props = { width: size, height: size, 'aria-hidden': true as const, focusable: false };
  const matchIcon = (value: string) => {
    const id = value.toLowerCase();
    if (id.includes('claude')) return <Claude {...props} />;
    if (id.includes('deepseek')) return <Deepseek {...props} />;
    if (/qwen|qwq|千问|通义/.test(id)) return <Qwen {...props} variant="light" color="#615ced" />;
    if (/gemini|google/.test(id)) return <Gemini {...props} />;
    if (/mistral|mixtral|codestral/.test(id)) return <Mistral {...props} variant="color" />;
    if (/kimi|moonshot/.test(id)) return <Kimi {...props} />;
    if (id.includes('minimax')) return <Minimax {...props} />;
    if (/doubao|豆包/.test(id)) return <Doubao {...props} variant="color" />;
    // `gpt` may be followed by a space ("GPT Astra"), not only a hyphen ("gpt-4o").
    if (/openai|chatgpt|(?:^|[\s/_-])gpt(?=[-_.\s/]|\d|$)|(?:^|[\s/])o[1-9](?:[-\s]|$)/.test(id)) return <Openai {...props} variant="light" />;
    if (/grok|xai|x\.ai/.test(id)) return <Grok {...props} />;
    // These brands provide monochrome marks; use their authored theme-safe variant.
    if (id.includes('anthropic')) return <Anthropic {...props} variant="mono" />;
    if (id.includes('ollama')) return <Ollama {...props} variant="mono" />;
    return null;
  };
  const icon = matchIcon(`${modelId} ${name}`) ?? matchIcon(providerName);
  return <span className="model-icon" aria-hidden="true" style={{ width: size, height: size }}>
    {icon ?? <Icon name="model" size={size} />}
  </span>;
}
