/**
 * Shared pure types for Intelligent UI blocks rendered inside assistant replies.
 *
 * Kept free of Node, DOM, React and database imports so both `ui/` and `server/`
 * can share the exact same contract.
 */

export type WeatherCondition =
  | 'sunny'
  | 'partly-cloudy'
  | 'cloudy'
  | 'rain'
  | 'storm'
  | 'snow'
  | 'fog';

export type WeatherHourlyPoint = {
  time: string;
  condition: WeatherCondition;
  tempC: number;
};

export type WeatherDailyPoint = {
  day: string;
  condition: WeatherCondition;
  lowC: number;
  highC: number;
};

export type WeatherData = {
  location: string;
  observedAt?: string;
  condition: WeatherCondition;
  conditionLabel: string;
  temperatureC: number;
  feelsLikeC?: number;
  highC: number;
  lowC: number;
  humidity?: number;
  windSpeedKmh?: number;
  windDir?: string;
  aqi?: {
    value: number;
    label: string;
  };
  hourly?: WeatherHourlyPoint[];
  daily?: WeatherDailyPoint[];
};

export type MapPlace = {
  id: string;
  name: string;
  category: string;
  address: string;
  lat: number;
  lng: number;
  rating?: number;
  distanceText?: string;
  openStatus?: string;
  /** Normalized 0-100 coordinates on the stylized vector map canvas. */
  x?: number;
  y?: number;
};

export type MapRoute = {
  mode: 'walk' | 'drive' | 'transit';
  durationText: string;
  distanceText: string;
  points: Array<{ x: number; y: number }>;
};

export type MapData = {
  title: string;
  subtitle?: string;
  center: { lat: number; lng: number };
  places: MapPlace[];
  route?: MapRoute;
};

export type AskQuestionOption = {
  id: string;
  label: string;
  description?: string;
};

export type AskQuestionItem = {
  id: string;
  prompt: string;
  type: 'single' | 'multi' | 'text';
  required?: boolean;
  allowCustom?: boolean;
  customPlaceholder?: string;
  options?: AskQuestionOption[];
};

export type AskQuestionData = {
  id: string;
  title?: string;
  description?: string;
  submitLabel?: string;
  questions: AskQuestionItem[];
};

export type AskQuestionAnswer = {
  questionId: string;
  prompt: string;
  selectedIds: string[];
  selectedLabels: string[];
  customText?: string;
};

export type AskQuestionSubmission = {
  cardId: string;
  answers: AskQuestionAnswer[];
  /** Human-readable text ready to be sent directly as a chat message. */
  formattedText: string;
};

export type IntelligentUiBlock =
  | {
      id: string;
      kind: 'weather';
      loading?: boolean;
      data?: WeatherData | null;
    }
  | {
      id: string;
      kind: 'ask_question';
      data: AskQuestionData;
      submission?: AskQuestionSubmission;
    };

const UI_MARKER_REGEX = /\[\[ui:([a-zA-Z0-9_-]+)\]\]/gu;
const PARTIAL_UI_MARKER_SUFFIX = /\[\[ui:[a-zA-Z0-9_-]*$/u;

export function formatUiBlockMarker(id: string): string {
  return `[[ui:${id}]]`;
}

export function stripUiBlockMarkers(content: string): string {
  return content
    .replace(UI_MARKER_REGEX, '')
    .replace(PARTIAL_UI_MARKER_SUFFIX, '')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

export type ReplyUiSegment =
  | { kind: 'text'; text: string }
  | { kind: 'block'; block: IntelligentUiBlock };

export function splitReplyUiSegments(
  content: string,
  blocks: readonly IntelligentUiBlock[] | undefined,
  options: { streaming?: boolean; isLatest?: boolean } = {},
): ReplyUiSegment[] {
  const { streaming = false, isLatest = true } = options;
  const visibleBlocks = (blocks ?? []).filter(
    (block) => block.kind !== 'ask_question' || isLatest || Boolean(block.submission),
  );
  const blockById = new Map((blocks ?? []).map((block) => [block.id, block]));
  const visibleById = new Map(visibleBlocks.map((block) => [block.id, block]));
  const placedIds = new Set<string>();

  const normalized = streaming ? content.replace(PARTIAL_UI_MARKER_SUFFIX, '') : content;
  const segments: ReplyUiSegment[] = [];
  let cursor = 0;

  const pushText = (raw: string) => {
    const trimmed = raw.replace(/^\n+|\n+$/gu, '');
    if (!trimmed) return;
    const prev = segments.at(-1);
    if (prev?.kind === 'text') {
      prev.text = `${prev.text}\n\n${trimmed}`;
    } else {
      segments.push({ kind: 'text', text: trimmed });
    }
  };

  for (const match of normalized.matchAll(UI_MARKER_REGEX)) {
    const index = match.index ?? 0;
    const id = match[1];
    pushText(normalized.slice(cursor, index));
    cursor = index + match[0].length;
    if (!blockById.has(id)) continue;
    const visible = visibleById.get(id);
    if (visible && !placedIds.has(id)) {
      placedIds.add(id);
      segments.push({ kind: 'block', block: visible });
    }
  }
  pushText(normalized.slice(cursor));

  const unplaced = visibleBlocks.filter((block) => !placedIds.has(block.id));
  if (unplaced.length) {
    return [...unplaced.map((block): ReplyUiSegment => ({ kind: 'block', block })), ...segments];
  }
  return segments;
}
