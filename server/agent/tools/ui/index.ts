import type { AgentTool } from '@mariozechner/pi-agent-core';
import type { Static } from 'typebox';

import type { AskQuestionData, IntelligentUiBlock, WeatherData } from '../../../../contract/intelligent-ui';
import type { ToolModule } from '../types';
import { askQuestionParameters, showWeatherParameters } from './schema';

type ShowWeatherParams = Static<typeof showWeatherParameters>;
type AskQuestionParams = Static<typeof askQuestionParameters>;

const WEATHER_PROMPT = `Intelligent UI — Weather (show_weather):
- For ANY weather, temperature, rain/snow, air quality, or 1–14 day forecast question, you MUST call show_weather instead of answering with only plain text or a Markdown weather table.
- When web tools are enabled, search/fetch forecast data first, then immediately call show_weather as your next tool call (if a live current thermometer reading is missing from search results, estimate temperatureC reasonably from the day's forecast range).
- Do NOT begin writing the final weather reply before calling show_weather — even if the card should appear in the middle or at the end of your reply. Call show_weather first; the tool response will give you the exact token needed to render the card.`;

const ASK_QUESTION_PROMPT = `Intelligent UI — Ask Question (ask_question):
- Proactively call ask_question INSTEAD OF writing plain-text numbered questions or generic advice walls whenever the user's request is open-ended, ambiguous, or missing key preferences/constraints (e.g. travel itinerary, study/fitness plan, proposal/outline, product or restaurant recommendations, or multi-factor confirmation before acting).
- Do NOT begin writing plain-text follow-up questions before calling ask_question — even if the card should appear after an intro paragraph or at the end of your reply. Call ask_question first; the tool response will give you the exact token needed to render the card.
- Skip ask_question only for direct factual/translation/coding questions with sufficient context, scheduled task creation requests (direct them to the Scheduled Tasks page), or when the user explicitly asks not to be asked questions.`;

function createShowWeatherTool(): AgentTool<typeof showWeatherParameters> {
  return {
    name: 'show_weather',
    label: '展示天气卡片',
    description:
      'Render an interactive Weather card for any weather or forecast query (fetch forecast data via web_search first if web tools are enabled). Always call this tool before writing your weather reply.',
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
          text: `Weather card ready for ${data.location} (${data.conditionLabel}, ${data.temperatureC}°C${data.daily?.length ? `, ${data.daily.length}-day forecast` : ''}). Now write your brief summary/advice (keeping inline source citations like [^1] and their footnote definitions if you used web results) and place [[ui:${uiBlock.id}]] on its own line at the exact point (start, middle, or end) where the card should appear, without wrapping it in backticks. Do not repeat the forecast table in prose.`,
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
      'Render an interactive choice/input card instead of plain-text questions whenever a request is open-ended, missing preferences/constraints (e.g. travel/study/fitness plans, proposals, recommendations), or needs confirmation. Always call this tool before writing your reply.',
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
          text: `Ask Question card ready with ${data.questions.length} question(s). Now write your brief intro/guidance and place [[ui:${uiBlock.id}]] on its own line at the exact point (start, middle, or end) where the card should appear, without wrapping it in backticks or repeating the options in text, then wait for the user to submit.`,
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
