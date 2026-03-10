import { spawnSync } from 'node:child_process';
import process from 'node:process';

export type ClipboardCopyResult = {
  ok: boolean;
  method?: string;
  error?: string;
};

export function copyToClipboard(text: string): ClipboardCopyResult {
  const platform = process.platform;

  if (platform === 'darwin') {
    return runClipboardCommand('pbcopy', [], text, 'pbcopy');
  }

  if (platform === 'win32') {
    return runClipboardCommand('clip', [], text, 'clip');
  }

  const xclip = runClipboardCommand('xclip', ['-selection', 'clipboard'], text, 'xclip');
  if (xclip.ok) return xclip;

  const xsel = runClipboardCommand('xsel', ['--clipboard', '--input'], text, 'xsel');
  if (xsel.ok) return xsel;

  return {
    ok: false,
    error: xsel.error || xclip.error || 'No supported clipboard command found.',
  };
}

function runClipboardCommand(command: string, args: string[], text: string, method: string): ClipboardCopyResult {
  const result = spawnSync(command, args, {
    input: text,
    encoding: 'utf8',
  });

  if (result.error) {
    return {
      ok: false,
      error: result.error.message,
    };
  }

  if (result.status !== 0) {
    const stderr = typeof result.stderr === 'string' ? result.stderr.trim() : '';
    return {
      ok: false,
      error: stderr || `${command} exited with status ${String(result.status)}`,
    };
  }

  return {
    ok: true,
    method,
  };
}
