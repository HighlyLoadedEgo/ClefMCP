import readline from 'node:readline/promises';
import { ClefError, ClefErrorCode } from '../clef/errors.js';

/** `[Y/n]` confirmation. Requires --yes in non-interactive contexts. */
export async function confirm(question: string, yes: boolean): Promise<boolean> {
  if (yes) return true;
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new ClefError(
      ClefErrorCode.INVALID_INPUT,
      'Refusing to proceed interactively without a terminal.',
      'Re-run with --yes to confirm non-interactively.',
    );
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${question} [Y/n] `)).trim().toLowerCase();
    return answer === '' || answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}
