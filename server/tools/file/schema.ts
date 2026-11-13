import { Type } from 'typebox';

const officeCommand = Type.Object({
  command: Type.Union([
    Type.Literal('add'),
    Type.Literal('set'),
    Type.Literal('remove'),
    Type.Literal('duplicate'),
    Type.Literal('move'),
  ]),
  parent: Type.Optional(Type.String({ maxLength: 500 })),
  path: Type.Optional(Type.String({ maxLength: 500 })),
  type: Type.Optional(Type.String({ maxLength: 40 })),
  props: Type.Optional(Type.Record(Type.String({ maxLength: 100 }),
    Type.Union([Type.String({ maxLength: 6000 }), Type.Number(), Type.Boolean()]))),
});

const pdfDrawText = Type.Object({
  operation: Type.Literal('draw_text'),
  page: Type.Integer({ minimum: 1 }),
  text: Type.String({ maxLength: 50_000 }),
  x: Type.Number({ minimum: 0 }),
  y: Type.Number({ minimum: 0 }),
  size: Type.Optional(Type.Number({ minimum: 1, maximum: 200 })),
  color: Type.Optional(Type.String({ maxLength: 7 })),
});
const pdfReplacePage = Type.Object({
  operation: Type.Literal('replace_page'),
  page: Type.Integer({ minimum: 1 }),
  text: Type.String({ maxLength: 50_000 }),
  x: Type.Number({ minimum: 0 }),
  y: Type.Number({ minimum: 0 }),
  size: Type.Optional(Type.Number({ minimum: 1, maximum: 200 })),
  color: Type.Optional(Type.String({ maxLength: 7 })),
});
const pdfAddPage = Type.Object({
  operation: Type.Literal('add_page'),
  page: Type.Optional(Type.Integer({ minimum: 1 })),
  width: Type.Optional(Type.Number({ minimum: 1 })),
  height: Type.Optional(Type.Number({ minimum: 1 })),
  text: Type.Optional(Type.String({ maxLength: 50_000 })),
  x: Type.Optional(Type.Number({ minimum: 0 })),
  y: Type.Optional(Type.Number({ minimum: 0 })),
  size: Type.Optional(Type.Number({ minimum: 1, maximum: 200 })),
  color: Type.Optional(Type.String({ maxLength: 7 })),
});
const pdfRemovePage = Type.Object({
  operation: Type.Literal('remove_page'),
  page: Type.Integer({ minimum: 1 }),
});
const pdfRotatePage = Type.Object({
  operation: Type.Literal('rotate_page'),
  page: Type.Integer({ minimum: 1 }),
  degrees: Type.Union([Type.Literal(0), Type.Literal(90), Type.Literal(180), Type.Literal(270)]),
});
const pdfSetField = Type.Object({
  operation: Type.Literal('set_field'),
  name: Type.String({ maxLength: 200 }),
  text: Type.String({ maxLength: 50_000 }),
});
const pdfChange = Type.Union([
  pdfDrawText,
  pdfReplacePage,
  pdfAddPage,
  pdfRemovePage,
  pdfRotatePage,
  pdfSetField,
]);

export const fileParameters = Type.Object({
  operation: Type.Union([
    Type.Literal('list'),
    Type.Literal('read'),
    Type.Literal('grep'),
    Type.Literal('help'),
    Type.Literal('inspect'),
    Type.Literal('create'),
    Type.Literal('edit'),
    Type.Literal('save'),
    Type.Literal('delete'),
  ]),
  fileId: Type.Optional(Type.String({
    description: 'A Library file UUID or a draft: handle returned by create/edit. Never a filename or path.',
    minLength: 1,
    maxLength: 80,
  })),
  conversationId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  format: Type.Optional(Type.Union([
    Type.Literal('docx'),
    Type.Literal('xlsx'),
    Type.Literal('pptx'),
    Type.Literal('pdf'),
  ])),
  filename: Type.Optional(Type.String({ minLength: 1, maxLength: 255 })),
  commands: Type.Optional(Type.Array(officeCommand, {
    maxItems: 100,
    description: 'Structured Office commands. Batch one logical block per call; the model-facing cap is 20 commands.',
  })),
  pdfChanges: Type.Optional(Type.Array(pdfChange, {
    maxItems: 100,
    description: 'Structured PDF page/text operations. Use instead of commands for PDF files.',
  })),
  save: Type.Optional(Type.Boolean({ description: 'create/edit: save directly to the Library instead of creating a draft.' })),
  path: Type.Optional(Type.String({ maxLength: 500, description: 'Document-internal path for inspect.' })),
  element: Type.Optional(Type.String({ maxLength: 80, description: 'Element name for help.' })),
  start: Type.Optional(Type.Integer({ minimum: 1, default: 1 })),
  end: Type.Optional(Type.Integer({ minimum: 1 })),
  maxChars: Type.Optional(Type.Integer({ minimum: 1, maximum: 50_000, default: 50_000 })),
  pattern: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  context: Type.Optional(Type.Integer({ minimum: 0, maximum: 5, default: 1 })),
  maxMatches: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, default: 50 })),
});
