import { describe, expect, it } from 'vitest';
import { ClefError, ClefErrorCode } from '../../src/clef/errors.js';
import { fromSystemOneResponse, toSystemOneRequest } from '../../src/clef/systemone.js';
import type { ClefQuestion } from '../../src/clef/types.js';

describe('toSystemOneRequest', () => {
  it('passes string state through and falls back to the default model', () => {
    const request = toSystemOneRequest(
      { state: 'raw state', questions: { q: { type: 'noul', instructions: 'i' } } },
      'clef-flash',
    );
    expect(request).toEqual({
      model: 'clef-flash',
      state: 'raw state',
      questions: { q: { type: 'noul', instructions: 'i' } },
    });
  });

  it('serializes structured state to JSON', () => {
    const request = toSystemOneRequest({ state: { task: 't', n: 1 }, questions: {} }, 'clef-flash');
    expect(request.state).toBe('{"task":"t","n":1}');
  });

  it('uses the explicit model when given', () => {
    const request = toSystemOneRequest(
      { state: 's', questions: {}, model: 'clef' },
      'clef-flash',
    );
    expect(request.model).toBe('clef');
  });

  it('converts plain-list choice criteria into an id -> id map for SystemOne', () => {
    const request = toSystemOneRequest(
      {
        state: 's',
        questions: { c: { type: 'choice', instructions: 'i', criteria: ['rollback', 'hotfix'] } },
      },
      'clef-flash',
    );
    expect(request.questions.c?.criteria).toEqual({ rollback: 'rollback', hotfix: 'hotfix' });
  });

  it('keeps criteria and instructions in questions', () => {
    const request = toSystemOneRequest(
      {
        state: 's',
        questions: {
          c: { type: 'choice', instructions: 'pick', criteria: { a: 'alpha', b: 'beta' } },
          s: { type: 'score', instructions: 'score', criteria: ['one', 'two'] },
        },
      },
      'clef-flash',
    );
    expect(request.questions.c?.criteria).toEqual({ a: 'alpha', b: 'beta' });
    expect(request.questions.s?.criteria).toEqual(['one', 'two']);
  });
});

describe('fromSystemOneResponse', () => {
  const choiceQ: Record<string, ClefQuestion> = {
    next_action: { type: 'choice', instructions: 'i', criteria: { inspect: '', modify: '' } },
  };

  it('maps choice probabilities as-is', () => {
    const out = fromSystemOneResponse(
      { model: 'clef-flash', answers: { next_action: { probabilities: { inspect: 0.7, modify: 0.3 } } } },
      choiceQ,
      'fallback',
    );
    expect(out.model).toBe('clef-flash');
    expect(out.decisions.next_action?.answer).toEqual({ inspect: 0.7, modify: 0.3 });
  });

  it('falls back to the provided model name when the response omits it', () => {
    const out = fromSystemOneResponse(
      { answers: { next_action: { probabilities: { inspect: 1, modify: 0 } } } },
      choiceQ,
      'clef-flash',
    );
    expect(out.model).toBe('clef-flash');
  });

  it('maps noul probability_true into a true/false distribution', () => {
    const out = fromSystemOneResponse(
      { answers: { q: { probability_true: 0.9 } } },
      { q: { type: 'noul', instructions: 'i' } },
      'clef-flash',
    );
    expect(out.decisions.q?.answer?.true).toBeCloseTo(0.9, 5);
    expect(out.decisions.q?.answer?.false).toBeCloseTo(0.1, 5);
  });

  it('maps the llama.cpp `noul` field (observed live shape)', () => {
    const out = fromSystemOneResponse(
      { answers: { q: { type: 'noul', noul: 0.0498 } } },
      { q: { type: 'noul', instructions: 'i' } },
      'clef-flash',
    );
    expect(out.decisions.q?.answer?.true).toBeCloseTo(0.0498, 5);
    expect(out.decisions.q?.answer?.false).toBeCloseTo(0.9502, 5);
  });

  it('clamps out-of-range noul probabilities', () => {
    const out = fromSystemOneResponse(
      { answers: { q: { probability_true: 1.2 } } },
      { q: { type: 'noul', instructions: 'i' } },
      'clef-flash',
    );
    expect(out.decisions.q?.answer).toEqual({ true: 1, false: 0 });
  });

  it('accepts a noul probabilities map keyed by true/false', () => {
    const out = fromSystemOneResponse(
      { answers: { q: { probabilities: { true: 0.25, false: 0.75 } } } },
      { q: { type: 'noul', instructions: 'i' } },
      'clef-flash',
    );
    expect(out.decisions.q?.answer).toEqual({ true: 0.25, false: 0.75 });
  });

  it('resolves llama.cpp index-keyed score probabilities via the legend (observed live shape)', () => {
    const questions: Record<string, ClefQuestion> = {
      conf: { type: 'score', instructions: 'i', criteria: ['low', 'medium', 'high'] },
    };
    const out = fromSystemOneResponse(
      {
        answers: {
          conf: {
            type: 'score',
            score: 1.89,
            legend: { '0': 'low', '1': 'medium', '2': 'high' },
            probabilities: { '0': 0.0139, '1': 0.08, '2': 0.906 },
            confidence: 0.838,
          },
        },
      },
      questions,
      'clef-flash',
    );
    expect(out.decisions.conf?.answer).toEqual({ low: 0.0139, medium: 0.08, high: 0.906 });
  });

  it('zips score probability arrays with the criteria order', () => {
    const questions: Record<string, ClefQuestion> = {
      conf: { type: 'score', instructions: 'i', criteria: ['low', 'mid', 'high'] },
    };
    const out = fromSystemOneResponse(
      { answers: { conf: { probabilities: [0.2, 0.3, 0.5] } } },
      questions,
      'clef-flash',
    );
    expect(out.decisions.conf?.answer).toEqual({ low: 0.2, mid: 0.3, high: 0.5 });
  });

  it('accepts score probability maps keyed by criterion', () => {
    const questions: Record<string, ClefQuestion> = {
      conf: { type: 'score', instructions: 'i', criteria: ['low', 'high'] },
    };
    const out = fromSystemOneResponse(
      { answers: { conf: { probabilities: { low: 0.4, high: 0.6 } } } },
      questions,
      'clef-flash',
    );
    expect(out.decisions.conf?.answer).toEqual({ low: 0.4, high: 0.6 });
  });

  it('throws CLEF_INFERENCE_FAILED when an answer is missing', () => {
    try {
      fromSystemOneResponse({ answers: {} }, choiceQ, 'clef-flash');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ClefError);
      expect((err as ClefError).code).toBe(ClefErrorCode.CLEF_INFERENCE_FAILED);
      expect((err as ClefError).message).toContain('next_action');
    }
  });

  it('throws when probabilities are missing', () => {
    expect(() =>
      fromSystemOneResponse({ answers: { next_action: { choice: 'inspect' } } }, choiceQ, 'clef-flash'),
    ).toThrow(ClefError);
  });

  it('throws on non-numeric probabilities', () => {
    expect(() =>
      fromSystemOneResponse(
        { answers: { next_action: { probabilities: { inspect: 'high', modify: 0.1 } } } },
        choiceQ,
        'clef-flash',
      ),
    ).toThrow(/non-numeric/);
  });

  it('throws on score length mismatch', () => {
    const questions: Record<string, ClefQuestion> = {
      conf: { type: 'score', instructions: 'i', criteria: ['low', 'high'] },
    };
    expect(() =>
      fromSystemOneResponse({ answers: { conf: { probabilities: [1] } } }, questions, 'clef-flash'),
    ).toThrow(/1 probabilities.*2 criteria/);
  });

  it('throws when the answers object itself is missing', () => {
    expect(() => fromSystemOneResponse({} as never, choiceQ, 'clef-flash')).toThrow(/answers/);
  });
});
