export type QuestionType = 'noul' | 'choice' | 'score';

export interface ClefQuestion {
  type: QuestionType;
  instructions: string;
  /**
   * `choice`: map of option id -> description.
   * `score`: ordered list of criterion descriptions (index == score).
   * `noul`: optional map with "true"/"false" descriptions.
   */
  criteria?: string[] | Record<string, string>;
}

export interface ClefDecideInput {
  state: unknown;
  questions: Record<string, ClefQuestion>;
  model?: string;
  options?: {
    temperature?: number;
  };
}

/** Probability distribution over answer options for one question. */
export type ClefDecisionAnswer = Record<string, number>;

/**
 * Model-reported token usage / latency. Fields are optional because runtimes
 * report different subsets (llama.cpp: tokens; the MLX loader: latency_ms).
 */
export type ClefUsage = {
  input_tokens?: number;
  output_tokens?: number;
  latency_ms?: number;
};

// Type aliases (not interfaces) so the shape is assignable to the MCP SDK's
// `structuredContent` (which requires an implicit string index signature).
export type ClefDecideOutput = {
  model: string;
  decisions: Record<string, { answer: ClefDecisionAnswer; confidence?: number }>;
  usage?: ClefUsage;
};
