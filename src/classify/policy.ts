import { ClefError, ClefErrorCode } from '../clef/errors.js';
import type { ClassificationProfile } from './profile.js';

export type ReviewReason = 'low_probability' | 'low_margin' | 'tie' | 'low_confidence' | 'missing_confidence';
export interface PolicyResult {
  status: 'classified' | 'needs_review';
  label: string | null;
  suggested_label: string;
  probability: number;
  margin: number;
  probabilities: Record<string, number>;
  confidence?: number;
  review_reasons: ReviewReason[];
}

export function evaluateClassification(profile: ClassificationProfile, decision: { answer: Record<string, number>; confidence?: number }): PolicyResult {
  const entries = Object.entries(decision.answer);
  const labels = Object.keys(profile.labels);
  const total = entries.reduce((sum, [, p]) => sum + p, 0);
  if (entries.length !== labels.length || entries.some(([label, p]) => !Object.hasOwn(profile.labels, label) || !Number.isFinite(p) || p < 0 || p > 1) || Math.abs(total - 1) > .001 + 1e-12 || decision.confidence !== undefined && (!Number.isFinite(decision.confidence) || decision.confidence < 0 || decision.confidence > 1)) {
    throw new ClefError(ClefErrorCode.CLEF_INFERENCE_FAILED, 'Runtime returned an invalid classification distribution or confidence');
  }
  const ranked = entries.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const top = ranked[0]!;
  const margin = top[1] - ranked[1]![1];
  const reasons: ReviewReason[] = [];
  if (top[1] < profile.policy.min_probability - 1e-12) reasons.push('low_probability');
  if (margin < profile.policy.min_margin - 1e-12) reasons.push('low_margin');
  if (top[1] === ranked[1]![1]) reasons.push('tie');
  if (profile.policy.min_confidence !== undefined) {
    if (decision.confidence === undefined) reasons.push('missing_confidence');
    else if (decision.confidence < profile.policy.min_confidence - 1e-12) reasons.push('low_confidence');
  }
  return {
    status: reasons.length ? 'needs_review' : 'classified', label: reasons.length ? null : top[0],
    suggested_label: top[0], probability: top[1], margin, probabilities: decision.answer,
    ...(decision.confidence !== undefined ? { confidence: decision.confidence } : {}), review_reasons: reasons,
  };
}
