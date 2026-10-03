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

// Type aliases (not interfaces) so the shape is assignable to the MCP SDK's
// `structuredContent` (which requires an implicit string index signature).
export type ClefDecideOutput = {
  model: string;
  decisions: Record<string, { answer: ClefDecisionAnswer }>;
};
