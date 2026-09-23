export type Question = { type: string; instructions?: unknown; criteria?: Record<string, unknown> };
export type Questions = Record<string, Question>;
export type Answer = { type: string; choice?: string; noul?: number; confidence?: number; probabilities?: Record<string, number> };
export type Answers = Record<string, Answer>;
export type Decision = { model?: string; answers?: Answers; usage?: Record<string, number>; latency_ms?: number; question_count?: number };
