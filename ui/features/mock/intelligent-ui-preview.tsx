import { useState } from 'react';

import {
  AskQuestionCard,
  MapCard,
  WeatherCard,
  type AskQuestionData,
  type AskQuestionSubmission,
  type MapData,
  type WeatherData,
} from '@/ui/index';

type ComponentTab = 'all' | 'weather' | 'map' | 'ask';
type WeatherPresetKey = 'sunny' | 'rain' | 'snow';
type AskPresetKey = 'multi' | 'single';

const WEATHER_PRESETS: Record<WeatherPresetKey, { label: string; data: WeatherData }> = {
  sunny: {
    label: '北京 · 晴朗',
    data: {
      location: '北京 · 朝阳区',
      observedAt: '14:20 更新',
      condition: 'sunny',
      conditionLabel: '晴间微风',
      temperatureC: 24,
      feelsLikeC: 25,
      highC: 26,
      lowC: 14,
      humidity: 36,
      windSpeedKmh: 12,
      windDir: '东南风',
      aqi: { value: 42, label: '优' },
      hourly: [
        { time: '现在', condition: 'sunny', tempC: 24 },
        { time: '15:00', condition: 'sunny', tempC: 26 },
        { time: '16:00', condition: 'partly-cloudy', tempC: 25 },
        { time: '17:00', condition: 'partly-cloudy', tempC: 23 },
        { time: '18:00', condition: 'cloudy', tempC: 20 },
        { time: '19:00', condition: 'cloudy', tempC: 18 },
      ],
      daily: [
        { day: '今天', condition: 'sunny', lowC: 14, highC: 26 },
        { day: '周三', condition: 'partly-cloudy', lowC: 15, highC: 25 },
        { day: '周四', condition: 'cloudy', lowC: 13, highC: 22 },
        { day: '周五', condition: 'rain', lowC: 11, highC: 18 },
        { day: '周六', condition: 'sunny', lowC: 12, highC: 23 },
        { day: '周日', condition: 'sunny', lowC: 14, highC: 25 },
        { day: '下周一', condition: 'partly-cloudy', lowC: 15, highC: 24 },
        { day: '下周二', condition: 'cloudy', lowC: 13, highC: 21 },
        { day: '下周三', condition: 'rain', lowC: 10, highC: 17 },
        { day: '下周四', condition: 'partly-cloudy', lowC: 11, highC: 20 },
        { day: '下周五', condition: 'sunny', lowC: 12, highC: 22 },
        { day: '下周六', condition: 'sunny', lowC: 13, highC: 24 },
        { day: '下周日', condition: 'partly-cloudy', lowC: 14, highC: 23 },
        { day: '第14天', condition: 'sunny', lowC: 13, highC: 25 },
      ],
    },
  },
  rain: {
    label: '上海 · 小雨',
    data: {
      location: '上海 · 静安区',
      observedAt: '14:15 更新',
      condition: 'rain',
      conditionLabel: '小雨转阴',
      temperatureC: 18,
      feelsLikeC: 17,
      highC: 20,
      lowC: 15,
      humidity: 84,
      windSpeedKmh: 19,
      windDir: '东风',
      aqi: { value: 31, label: '优' },
      hourly: [
        { time: '现在', condition: 'rain', tempC: 18 },
        { time: '15:00', condition: 'rain', tempC: 18 },
        { time: '16:00', condition: 'storm', tempC: 17 },
        { time: '17:00', condition: 'rain', tempC: 17 },
        { time: '18:00', condition: 'cloudy', tempC: 16 },
        { time: '19:00', condition: 'cloudy', tempC: 16 },
      ],
      daily: [
        { day: '今天', condition: 'rain', lowC: 15, highC: 20 },
        { day: '周三', condition: 'cloudy', lowC: 14, highC: 21 },
        { day: '周四', condition: 'partly-cloudy', lowC: 15, highC: 23 },
        { day: '周五', condition: 'sunny', lowC: 16, highC: 25 },
        { day: '周六', condition: 'partly-cloudy', lowC: 17, highC: 24 },
        { day: '周日', condition: 'rain', lowC: 15, highC: 19 },
        { day: '下周一', condition: 'storm', lowC: 14, highC: 18 },
        { day: '下周二', condition: 'cloudy', lowC: 14, highC: 20 },
        { day: '下周三', condition: 'partly-cloudy', lowC: 15, highC: 22 },
        { day: '下周四', condition: 'sunny', lowC: 16, highC: 24 },
        { day: '下周五', condition: 'sunny', lowC: 17, highC: 26 },
        { day: '下周六', condition: 'partly-cloudy', lowC: 16, highC: 24 },
        { day: '下周日', condition: 'rain', lowC: 15, highC: 20 },
        { day: '第14天', condition: 'cloudy', lowC: 15, highC: 21 },
      ],
    },
  },
  snow: {
    label: '哈尔滨 · 小雪',
    data: {
      location: '哈尔滨 · 道里区',
      observedAt: '14:10 更新',
      condition: 'snow',
      conditionLabel: '阵雪',
      temperatureC: -6,
      feelsLikeC: -11,
      highC: -3,
      lowC: -12,
      humidity: 72,
      windSpeedKmh: 24,
      windDir: '西北风',
      aqi: { value: 54, label: '良' },
      hourly: [
        { time: '现在', condition: 'snow', tempC: -6 },
        { time: '15:00', condition: 'snow', tempC: -5 },
        { time: '16:00', condition: 'cloudy', tempC: -7 },
        { time: '17:00', condition: 'cloudy', tempC: -9 },
        { time: '18:00', condition: 'fog', tempC: -10 },
      ],
      daily: [
        { day: '今天', condition: 'snow', lowC: -12, highC: -3 },
        { day: '周三', condition: 'cloudy', lowC: -14, highC: -4 },
        { day: '周四', condition: 'sunny', lowC: -13, highC: -2 },
        { day: '周五', condition: 'sunny', lowC: -11, highC: 0 },
      ],
    },
  },
};

const MAP_SAMPLE: MapData = {
  title: '三里屯周边推荐与步行路线',
  subtitle: '北京市朝阳区 · 拖拽可平移，点击标记切换详情',
  center: { lat: 39.9355, lng: 116.4541 },
  route: {
    mode: 'walk',
    durationText: '14 分钟',
    distanceText: '1.1 km',
    points: [
      { x: 22, y: 66 },
      { x: 38, y: 52 },
      { x: 56, y: 48 },
      { x: 76, y: 31 },
    ],
  },
  places: [
    {
      id: 'place-1',
      name: '三里屯太古里南区',
      category: '商业街区',
      address: '朝阳区三里屯路19号',
      lat: 39.9352,
      lng: 116.4543,
      rating: 4.7,
      distanceText: '起点',
      openStatus: '营业中 10:00-22:00',
      x: 22,
      y: 66,
    },
    {
      id: 'place-2',
      name: 'PageOne 书店',
      category: '书店 / 咖啡',
      address: '三里屯太古里南区 S2-14',
      lat: 39.9361,
      lng: 116.4552,
      rating: 4.8,
      distanceText: '步行 4 分钟',
      openStatus: '营业中 10:00-22:00',
      x: 42,
      y: 50,
    },
    {
      id: 'place-3',
      name: '使馆区林荫道',
      category: '城市漫步',
      address: '三里屯东五街',
      lat: 39.9378,
      lng: 116.4584,
      rating: 4.9,
      distanceText: '步行 9 分钟',
      openStatus: '全天开放',
      x: 61,
      y: 44,
    },
    {
      id: 'place-4',
      name: '亮马河畔咖啡馆',
      category: '休闲餐饮',
      address: '亮马河南路18号',
      lat: 39.9412,
      lng: 116.4621,
      rating: 4.6,
      distanceText: '步行 14 分钟',
      openStatus: '营业中 08:30-21:30',
      x: 76,
      y: 31,
    },
  ],
};

const ASK_PRESETS: Record<AskPresetKey, { label: string; data: AskQuestionData }> = {
  multi: {
    label: '多题规划（单选 + 多选 + 可选文本）',
    data: {
      id: 'trip-plan-ask',
      title: 'Ask Question',
      submitLabel: '提交全部答案',
      questions: [
        {
          id: 'framework',
          prompt: '你希望使用什么前端框架？',
          type: 'single',
          required: true,
          options: [
            { id: 'react', label: 'React + TypeScript' },
            { id: 'vue', label: 'Vue 3' },
            { id: 'svelte', label: 'Svelte' },
          ],
        },
        {
          id: 'features',
          prompt: '需要哪些 Agent 功能？',
          type: 'multi',
          required: true,
          options: [
            { id: 'stream', label: '流式输出（SSE / WebSocket）' },
            { id: 'tools', label: '工具调用与执行状态' },
            { id: 'hitl', label: '人工审批（Human-in-the-loop）' },
            { id: 'multi', label: '多 Agent 协作' },
          ],
        },
        {
          id: 'extra',
          prompt: '是否有其他要求？',
          type: 'text',
          required: false,
          customPlaceholder: '例如：需要支持移动端、动态表单、超时处理等...',
        },
      ],
    },
  },
  single: {
    label: '单题快速确认',
    data: {
      id: 'format-ask',
      title: '输出格式确认',
      submitLabel: '确认并发送',
      questions: [
        {
          id: 'format',
          prompt: '希望我以哪种形式整理这份报告？',
          type: 'single',
          required: true,
          options: [
            { id: 'brief', label: '精简要点版', description: '3 分钟读完，突出核心结论' },
            { id: 'detailed', label: '完整分析版', description: '含数据对比、风险与执行清单' },
          ],
        },
      ],
    },
  },
};

export default function IntelligentUiPreview() {
  const [tab, setTab] = useState<ComponentTab>('all');
  const [weatherPreset, setWeatherPreset] = useState<WeatherPresetKey>('sunny');
  const [dataLoading, setDataLoading] = useState(false);
  const [askPreset, setAskPreset] = useState<AskPresetKey>('multi');
  const [askResetKey, setAskResetKey] = useState(0);
  const [submissions, setSubmissions] = useState<AskQuestionSubmission[]>([]);

  const showWeather = tab === 'all' || tab === 'weather';
  const showMap = tab === 'all' || tab === 'map';
  const showAsk = tab === 'all' || tab === 'ask';

  const handleAskSubmit = (submission: AskQuestionSubmission) => {
    setSubmissions((prev) => [...prev, submission]);
  };

  const resetAsk = () => {
    setAskResetKey((k) => k + 1);
    setSubmissions([]);
  };

  return (
    <div className="chat-screen">
      <main className="chat-main has-messages" id="main-content">
        <header className="chat-topbar">
          <strong>Intelligent UI</strong>
        </header>

        <div className="messages-scroll">
          <div className="messages-content">
            <p className="process-preview-intro">
              展示 <code>ui/ui/</code> 下的三个交互式智能组件：天气、地图与 Ask Question（选择后可直接点击组件按钮发送）。
            </p>

            <div className="process-preview-controls" role="group" aria-label="组件筛选">
              {([
                ['all', '全部组件'],
                ['weather', '天气 Weather'],
                ['map', '地图 Map'],
                ['ask', 'Ask Question'],
              ] as const).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  aria-pressed={tab === key}
                  onClick={() => setTab(key)}
                >
                  {label}
                </button>
              ))}
              <button
                type="button"
                aria-pressed={dataLoading}
                onClick={() => setDataLoading((v) => !v)}
              >
                {dataLoading ? '恢复数据填充' : '预览未填充/加载中'}
              </button>
            </div>

            {showWeather && (
              <article className="assistant-message" aria-label="天气组件预览">
                <div className="process-preview-controls" role="group" aria-label="天气示例切换">
                  {(Object.keys(WEATHER_PRESETS) as WeatherPresetKey[]).map((key) => (
                    <button
                      key={key}
                      type="button"
                      aria-pressed={weatherPreset === key}
                      onClick={() => setWeatherPreset(key)}
                    >
                      {WEATHER_PRESETS[key].label}
                    </button>
                  ))}
                </div>
                <WeatherCard data={WEATHER_PRESETS[weatherPreset].data} loading={dataLoading} />
              </article>
            )}

            {showMap && (
              <article className="assistant-message" aria-label="地图组件预览">
                <MapCard data={MAP_SAMPLE} loading={dataLoading} />
              </article>
            )}

            {showAsk && (
              <article className="assistant-message" aria-label="Ask Question 组件预览">
                <div className="process-preview-controls" role="group" aria-label="Ask Question 示例">
                  {(Object.keys(ASK_PRESETS) as AskPresetKey[]).map((key) => (
                    <button
                      key={key}
                      type="button"
                      aria-pressed={askPreset === key}
                      onClick={() => {
                        setAskPreset(key);
                        setAskResetKey((k) => k + 1);
                      }}
                    >
                      {ASK_PRESETS[key].label}
                    </button>
                  ))}
                  <button type="button" onClick={resetAsk}>
                    重置问答状态
                  </button>
                </div>

                <AskQuestionCard
                  key={`${askPreset}-${askResetKey}`}
                  data={ASK_PRESETS[askPreset].data}
                  onSubmit={handleAskSubmit}
                />

                {submissions.length > 0 && (
                  <div className="iui-preview-sent-log" role="status" aria-label="已触发直接发送的消息">
                    <span className="iui-preview-sent-label">
                      已通过组件按钮直接发送（无需经过输入框）：
                    </span>
                    {submissions.map((sub, idx) => (
                      <div key={`${sub.cardId}-${idx}`} className="user-message">
                        <div className="user-bubble">
                          <span style={{ whiteSpace: 'pre-wrap' }}>{sub.formattedText}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </article>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
