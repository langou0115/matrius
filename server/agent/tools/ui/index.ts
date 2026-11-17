import type { AgentTool } from '@mariozechner/pi-agent-core';
import type { Static } from 'typebox';

import type { AskQuestionData, IntelligentUiBlock, WeatherData } from '../../../../contract/intelligent-ui';
import type { ToolModule } from '../types';
import { askQuestionParameters, showWeatherParameters } from './schema';

type ShowWeatherParams = Static<typeof showWeatherParameters>;
type AskQuestionParams = Static<typeof askQuestionParameters>;

const WEATHER_PROMPT = `Intelligent UI — Weather (\`show_weather\`):
- Trigger whenever the user asks about current weather, temperature, rain/snow, air quality, outfit/travel weather, or 1–14 day forecasts for any city or region.
- Gather accurate current and forecast data first (via \`web_search\` when web tools are enabled), then call \`show_weather\` to render the interactive Weather card (°C/°F toggle, hourly strip, 1–14 day forecast).
- You may place the card at the beginning, middle, or end of your reply: either embed the returned \`[[ui:...]]\` marker inline anywhere in your prose, or call the tool at the exact point in your response where you want it to appear.
- Do NOT dump a long Markdown weather table in prose once \`show_weather\` is called; keep accompanying text to a brief summary or practical advice.`;

const ASK_QUESTION_PROMPT = `Intelligent UI — Ask Question (\`ask_question\`):
- Intelligent UI means proactively choosing interactive components over plain-text walls whenever interaction saves the user effort.
- Trigger \`ask_question\` INSTEAD OF plain-text numbered questions whenever:
  1. The user's request is incomplete or missing key parameters (e.g. "帮我新建一个定时任务：", "帮我写个方案", "推荐几家店").
  2. There are multiple valid directions, formats, frequencies, or preferences to clarify before acting.
  3. You need quick confirmation or multi-factor choices from the user.
- You decide where the card appears (beginning, middle, or end of your reply): embed the returned \`[[ui:...]]\` marker inline anywhere in your prose (for example after an explanation or in the middle between two paragraphs), or omit the marker to place it where the tool was called.
- Never repeat the card's options as a Markdown list.`;

function createShowWeatherTool(): AgentTool<typeof showWeatherParameters> {
  return {
    name: 'show_weather',
    label: '展示天气卡片',
    description:
      'Call this whenever the user asks about current weather or 1–14 day forecasts for a location (fetch data via web_search first if needed). Renders an interactive Weather card in the reply.',
    parameters: showWeatherParameters,
    execute: async (toolCallId, params: ShowWeatherParams) => {
      const data: WeatherData = {
        ...params,
        daily: params.daily?.slice(0, 14),
      };
      const uiBlock: IntelligentUiBlock = {
        id: `weather-${toolCallId}`,
        kind: 'weather',
        data,
      };
      return {
        content: [{
          type: 'text',
          text: `Weather card rendered for ${data.location} (${data.conditionLabel}, ${data.temperatureC}°C${data.daily?.length ? `, ${data.daily.length}-day forecast` : ''}). Inline marker: [[ui:${uiBlock.id}]]. You may place [[ui:${uiBlock.id}]] at the start, middle, or end of your reply.`,
        }],
        details: { uiBlock },
      };
    },
  };
}

function createAskQuestionTool(): AgentTool<typeof askQuestionParameters> {
  return {
    name: 'ask_question',
    label: '发起交互问答',
    description:
      'Call this instead of plain-text follow-up questions whenever the user request is incomplete, missing parameters (e.g. task content/schedule), ambiguous, or needs preferences/confirmation. Renders an interactive list card with presets, optional custom input, and a direct Send button.',
    parameters: askQuestionParameters,
    execute: async (toolCallId, params: AskQuestionParams) => {
      const data: AskQuestionData = {
        id: params.id?.trim() || `ask-${toolCallId}`,
        ...(params.title ? { title: params.title } : {}),
        ...(params.description ? { description: params.description } : {}),
        ...(params.submitLabel ? { submitLabel: params.submitLabel } : {}),
        questions: params.questions.map((q) => ({ ...q, options: q.options ?? [] })),
      };
      const uiBlock: IntelligentUiBlock = {
        id: data.id,
        kind: 'ask_question',
        data,
      };
      return {
        content: [{
          type: 'text',
          text: `Ask Question card rendered with ${data.questions.length} question(s). Inline marker: [[ui:${uiBlock.id}]]. You may place [[ui:${uiBlock.id}]] at the start, middle, or end of your reply, then wait for the user to submit their selection.`,
        }],
        details: { uiBlock },
      };
    },
  };
}

export const showWeatherTool: ToolModule = {
  id: 'show_weather',
  prompt: WEATHER_PROMPT,
  create: () => createShowWeatherTool(),
};

export const askQuestionTool: ToolModule = {
  id: 'ask_question',
  prompt: ASK_QUESTION_PROMPT,
  create: () => createAskQuestionTool(),
};
