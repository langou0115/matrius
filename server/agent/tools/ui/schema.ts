import { Type } from 'typebox';

const weatherConditionSchema = Type.Union([
  Type.Literal('sunny'),
  Type.Literal('partly-cloudy'),
  Type.Literal('cloudy'),
  Type.Literal('rain'),
  Type.Literal('storm'),
  Type.Literal('snow'),
  Type.Literal('fog'),
]);

export const showWeatherParameters = Type.Object({
  location: Type.String({
    description: 'City or district name to display on the weather card, e.g. "北京 · 朝阳区".',
    minLength: 1,
    maxLength: 80,
  }),
  observedAt: Type.Optional(Type.String({
    description: 'Optional observation timestamp label, e.g. "14:20 更新".',
    maxLength: 40,
  })),
  condition: weatherConditionSchema,
  conditionLabel: Type.String({
    description: 'Human-readable weather condition label in the user language, e.g. "晴间微风".',
    minLength: 1,
    maxLength: 40,
  }),
  temperatureC: Type.Number({ description: 'Current temperature in Celsius.' }),
  feelsLikeC: Type.Optional(Type.Number({ description: 'Feels-like temperature in Celsius.' })),
  highC: Type.Number({ description: 'Today high temperature in Celsius.' }),
  lowC: Type.Number({ description: 'Today low temperature in Celsius.' }),
  humidity: Type.Optional(Type.Number({ minimum: 0, maximum: 100 })),
  windSpeedKmh: Type.Optional(Type.Number({ minimum: 0 })),
  windDir: Type.Optional(Type.String({ maxLength: 20 })),
  aqi: Type.Optional(Type.Object({
    value: Type.Number({ minimum: 0 }),
    label: Type.String({ minLength: 1, maxLength: 20 }),
  })),
  hourly: Type.Optional(Type.Array(Type.Object({
    time: Type.String({ minLength: 1, maxLength: 20 }),
    condition: weatherConditionSchema,
    tempC: Type.Number(),
  }), { maxItems: 24 })),
  daily: Type.Optional(Type.Array(Type.Object({
    day: Type.String({ minLength: 1, maxLength: 20 }),
    condition: weatherConditionSchema,
    lowC: Type.Number(),
    highC: Type.Number(),
  }), {
    description: '1 to 14 days of daily forecast entries.',
    minItems: 1,
    maxItems: 14,
  })),
});

export const askQuestionParameters = Type.Object({
  id: Type.Optional(Type.String({
    description: 'Optional unique card id.',
    maxLength: 80,
  })),
  title: Type.Optional(Type.String({
    description: 'Short card header title, e.g. "需要确认你的偏好".',
    maxLength: 80,
  })),
  description: Type.Optional(Type.String({
    description: 'Optional brief guidance shown under the title.',
    maxLength: 200,
  })),
  submitLabel: Type.Optional(Type.String({
    description: 'Optional label for the direct-send button, defaults to "确认并发送".',
    maxLength: 30,
  })),
  questions: Type.Array(Type.Object({
    id: Type.String({ minLength: 1, maxLength: 60 }),
    prompt: Type.String({ minLength: 1, maxLength: 200 }),
    type: Type.Union([Type.Literal('single'), Type.Literal('multi'), Type.Literal('text')]),
    required: Type.Optional(Type.Boolean()),
    allowCustom: Type.Optional(Type.Boolean()),
    customPlaceholder: Type.Optional(Type.String({ maxLength: 100 })),
    options: Type.Optional(Type.Array(Type.Object({
      id: Type.String({ minLength: 1, maxLength: 60 }),
      label: Type.String({ minLength: 1, maxLength: 100 }),
      description: Type.Optional(Type.String({ maxLength: 160 })),
    }), { minItems: 0, maxItems: 12 })),
  }), {
    description: 'One or more structured questions rendered as selectable lists.',
    minItems: 1,
    maxItems: 6,
  }),
});
