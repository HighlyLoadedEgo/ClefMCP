import { ClefError, ClefErrorCode } from './errors.js';
import type { ClefDecideInput, ClefDecideOutput, ClefQuestion } from './types.js';

/**
 * Wire-level types for the SystemOne API (`POST /v1/systemone`), the de-facto
 * interchange format for Clef decision models exposed by llama.cpp and the
 * MLX loader alike.
 */
export interface SystemOneQuestion {
  type: 'noul' | 'choice' | 'score';
  instructions?: string;
  criteria?: string[] | Record<string, string>;
}

export interface SystemOneRequest {
  model: string;
  state: string;
  questions: Record<string, SystemOneQuestion>;
}

export interface SystemOneUsage {
  [key: string]: unknown;
}

export interface SystemOneAnswer {
  choice?: string;
  confidence?: number;
  /** Probability of `true` for noul questions (llama.cpp uses `noul`). */
  noul?: number;
  probability_true?: number;
  probabilities?: Record<string, number> | number[];
  expected_score?: number;
  score?: number;
  legend?: string[] | Record<string, string>;
  [key: string]: unknown;
}

export interface SystemOneResponse {
  model?: string;
  answers: Record<string, SystemOneAnswer>;
  usage?: SystemOneUsage;
}

function stateToString(state: unknown): string {
  if (typeof state === 'string') return state;
  try {
    return JSON.stringify(state) ?? '';
  } catch (err) {
    throw new ClefError(
      ClefErrorCode.INVALID_INPUT,
      `state must be JSON-serializable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Map a validated clef_decide input to a SystemOne request body. */
export function toSystemOneRequest(input: ClefDecideInput, defaultModel: string): SystemOneRequest {
  const questions: Record<string, SystemOneQuestion> = {};
  for (const [qid, q] of Object.entries(input.questions)) {
    const question: SystemOneQuestion = { type: q.type, instructions: q.instructions };
    if (q.criteria !== undefined) question.criteria = q.criteria;
    questions[qid] = question;
  }
  return {
    model: input.model ?? defaultModel,
    state: stateToString(input.state),
    questions,
  };
}

function finiteNumber(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ClefError(
      ClefErrorCode.CLEF_INFERENCE_FAILED,
      `Runtime returned a non-numeric probability for ${where}`,
    );
  }
  return value;
}

function answerFor(answers: Record<string, SystemOneAnswer>, qid: string): SystemOneAnswer {
  const ans = answers[qid];
  if (!ans || typeof ans !== 'object') {
    throw new ClefError(
      ClefErrorCode.CLEF_INFERENCE_FAILED,
      `Runtime response is missing an answer for question "${qid}"`,
    );
  }
  return ans;
}

function probabilitiesMap(ans: SystemOneAnswer, qid: string): Record<string, number> {
  const raw = ans.probabilities;
  if (raw && !Array.isArray(raw) && typeof raw === 'object') {
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(raw)) out[k] = finiteNumber(v, `"${qid}" option "${k}"`);
    return out;
  }
  if (Array.isArray(raw)) {
    const out: Record<string, number> = {};
    for (const [i, v] of raw.entries()) out[String(i)] = finiteNumber(v, `"${qid}" option #${i}`);
    return out;
  }
  throw new ClefError(
    ClefErrorCode.CLEF_INFERENCE_FAILED,
    `Runtime response is missing probabilities for question "${qid}"`,
  );
}

function normalizeNoul(ans: SystemOneAnswer, qid: string): Record<string, number> {
  let pTrue: number | undefined;
  if (typeof ans.noul === 'number') {
    // Field used by llama.cpp's /v1/systemone.
    pTrue = finiteNumber(ans.noul, `"${qid}"`);
  } else if (typeof ans.probability_true === 'number') {
    pTrue = finiteNumber(ans.probability_true, `"${qid}"`);
  } else if (ans.probabilities && !Array.isArray(ans.probabilities)) {
    const map = ans.probabilities as Record<string, unknown>;
    const direct = map.true ?? map.yes ?? map.TRUE;
    if (typeof direct === 'number') pTrue = finiteNumber(direct, `"${qid}"`);
  } else if (Array.isArray(ans.probabilities) && typeof ans.probabilities[0] === 'number') {
    pTrue = finiteNumber(ans.probabilities[0], `"${qid}"`);
  }
  if (pTrue === undefined) {
    throw new ClefError(
      ClefErrorCode.CLEF_INFERENCE_FAILED,
      `Runtime response is missing the true-probability for noul question "${qid}"`,
    );
  }
  // Clamp to [0,1] so the derived false probability stays valid.
  const p = Math.min(1, Math.max(0, pTrue));
  return { true: p, false: 1 - p };
}

function normalizeScore(ans: SystemOneAnswer, qid: string, question: ClefQuestion): Record<string, number> {
  const criteria = question.criteria;
  if (!Array.isArray(criteria) || criteria.length === 0) {
    // Schema validation should prevent this; defensive check keeps the adapter honest.
    throw new ClefError(ClefErrorCode.INVALID_INPUT, `Score question "${qid}" requires an array of criteria`);
  }
  const raw = ans.probabilities;
  let pairs: Array<[string, number]>;

  if (Array.isArray(raw)) {
    // Distribution aligned with the criteria order.
    if (raw.length !== criteria.length) {
      throw new ClefError(
        ClefErrorCode.CLEF_INFERENCE_FAILED,
        `Runtime returned ${raw.length} probabilities for score question "${qid}" with ${criteria.length} criteria`,
      );
    }
    pairs = raw.map((v, i) => [criteria[i]!, finiteNumber(v, `"${qid}" criterion "${criteria[i]}"`)]);
  } else if (raw && typeof raw === 'object') {
    const entries = Object.entries(raw as Record<string, unknown>);
    const allNumericKeys = entries.length > 0 && entries.every(([k]) => /^\d+$/.test(k));
    if (allNumericKeys) {
      // llama.cpp shape: probabilities keyed by option index + legend mapping index -> label.
      pairs = entries.map(([k, v]) => {
        const idx = Number(k);
        let label: string | undefined;
        if (Array.isArray(ans.legend)) label = ans.legend[idx];
        else if (ans.legend && typeof ans.legend === 'object') label = (ans.legend as Record<string, string>)[k];
        const fallback = Number.isInteger(idx) ? criteria[idx] : undefined;
        return [label ?? fallback ?? k, finiteNumber(v, `"${qid}" option #${k}`)];
      });
    } else {
      // Already keyed by criterion label.
      pairs = entries.map(([k, v]) => [k, finiteNumber(v, `"${qid}" criterion "${k}"`)]);
    }
  } else {
    throw new ClefError(
      ClefErrorCode.CLEF_INFERENCE_FAILED,
      `Runtime response is missing the probability distribution for score question "${qid}"`,
    );
  }

  const out: Record<string, number> = {};
  for (const criterion of criteria) {
    const pair = pairs.find(([label]) => label === criterion);
    if (!pair) {
      throw new ClefError(
        ClefErrorCode.CLEF_INFERENCE_FAILED,
        `Runtime response is missing probability for score question "${qid}" criterion "${criterion}"`,
      );
    }
    out[criterion] = pair[1];
  }
  return out;
}

function normalizeChoice(ans: SystemOneAnswer, qid: string): Record<string, number> {
  return probabilitiesMap(ans, qid);
}

/** Normalize a SystemOne response into the strict clef_decide output shape. */
export function fromSystemOneResponse(
  response: SystemOneResponse,
  questions: Record<string, ClefQuestion>,
  fallbackModel: string,
): ClefDecideOutput {
  const answers = response.answers;
  if (!answers || typeof answers !== 'object') {
    throw new ClefError(ClefErrorCode.CLEF_INFERENCE_FAILED, 'Runtime response is missing the answers object');
  }
  const decisions: ClefDecideOutput['decisions'] = {};
  for (const [qid, question] of Object.entries(questions)) {
    const ans = answerFor(answers, qid);
    let answer: Record<string, number>;
    switch (question.type) {
      case 'choice':
        answer = normalizeChoice(ans, qid);
        break;
      case 'noul':
        answer = normalizeNoul(ans, qid);
        break;
      case 'score':
        answer = normalizeScore(ans, qid, question);
        break;
    }
    decisions[qid] = { answer };
  }
  return { model: response.model ?? fallbackModel, decisions };
}
