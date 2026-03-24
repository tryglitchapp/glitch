import { createInterface } from 'node:readline/promises';
import process from 'node:process';

export type ConfirmFn = (prompt: string) => Promise<boolean>;

export function isInteractiveSession(
  stdin: NodeJS.ReadStream = process.stdin,
  stdout: NodeJS.WriteStream = process.stdout,
): boolean {
  return Boolean(stdin.isTTY && stdout.isTTY);
}

export async function confirmYesNo(prompt: string, defaultValue = true): Promise<boolean> {
  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const answer = (await readline.question(prompt)).trim().toLowerCase();
    if (!answer) return defaultValue;
    if (answer === 'y' || answer === 'yes') return true;
    if (answer === 'n' || answer === 'no') return false;
    return defaultValue;
  } finally {
    readline.close();
  }
}
