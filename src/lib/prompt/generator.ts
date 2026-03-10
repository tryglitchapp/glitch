import type { PromptTarget } from './templates';
import { getPromptTemplate } from './templates';

export type PromptStyle = 'concise' | 'detailed';
export type PromptFramework = 'auto' | 'react' | 'vue' | 'angular' | 'svelte';

export type PromptWatchedElement = {
  id: string;
  selector: string;
  targetRefId?: string;
  core?: Record<string, unknown>;
  fullStyles?: Record<string, unknown>;
};

export type PromptPackInput = {
  packId: string;
  source: string;
  bugType: string | null;
  url: string;
  timestamp: string;
  mode?: 'slim' | 'full';
  prompt: string;
  summary: Record<string, unknown>;
  watchedElements: PromptWatchedElement[];
  totalStateChanges: number | null;
  interactionsCount: number | null;
};

export type PromptGenerateOptions = {
  target: PromptTarget;
  framework: PromptFramework;
  style: PromptStyle;
  includeCode: boolean;
};

export function generatePrompt(pack: PromptPackInput, options: PromptGenerateOptions): string {
  const template = getPromptTemplate(options.target);
  const lines: string[] = [];

  lines.push(template.prefix.trimEnd());
  lines.push(`Pack ID: ${pack.packId}`);
  lines.push(`URL: ${pack.url || 'unknown'}`);
  lines.push(`Source: ${pack.source}`);
  if (pack.mode) lines.push(`Bundle mode: ${pack.mode}`);
  if (pack.bugType) lines.push(`Bug type: ${pack.bugType}`);
  lines.push(`Watched elements: ${pack.watchedElements.length}`);
  if (pack.totalStateChanges !== null) lines.push(`State changes: ${pack.totalStateChanges}`);
  if (pack.interactionsCount !== null) lines.push(`Interactions: ${pack.interactionsCount}`);

  if (pack.prompt.trim()) {
    lines.push('');
    lines.push('User report:');
    lines.push(pack.prompt.trim());
  }

  const keyFindings = readStringArray(pack.summary, 'keyFindings');
  if (keyFindings.length > 0) {
    lines.push('');
    lines.push('Key findings:');
    keyFindings.forEach((finding) => {
      lines.push(`- ${finding}`);
    });
  }

  const queries = readStringArray(pack.summary, 'recommendedMCPQueries');
  if (queries.length > 0 && options.style === 'detailed') {
    lines.push('');
    lines.push('Suggested MCP queries:');
    queries.slice(0, 8).forEach((query) => {
      lines.push(`- ${query}`);
    });
  }

  lines.push('');
  lines.push('Watched selectors:');
  pack.watchedElements.slice(0, options.style === 'detailed' ? 10 : 5).forEach((entry) => {
    const ref = entry.targetRefId ? ` (${entry.targetRefId})` : '';
    lines.push(`- ${entry.selector}${ref}`);
  });

  if (options.includeCode) {
    const codeLines = renderCodeSection(pack, options.style);
    if (codeLines.length > 0) {
      lines.push('');
      lines.push(...codeLines);
    }
  }

  lines.push('');
  if (options.framework !== 'auto') {
    lines.push(`Framework context: ${options.framework}`);
  } else {
    lines.push('Framework context: auto-detect based on provided selectors/styles.');
  }
  lines.push(template.request);

  return lines.join('\n').trim();
}

function renderCodeSection(pack: PromptPackInput, style: PromptStyle): string[] {
  const rows: string[] = [];
  const maxElements = style === 'detailed' ? 3 : 1;

  pack.watchedElements.slice(0, maxElements).forEach((entry) => {
    if (!entry.core && !entry.fullStyles) return;

    rows.push(`Element: ${entry.selector}`);

    if (entry.core) {
      rows.push('```json');
      rows.push(JSON.stringify(entry.core, null, 2));
      rows.push('```');
    }

    if (entry.fullStyles && style === 'detailed') {
      rows.push('```json');
      rows.push(JSON.stringify(entry.fullStyles, null, 2));
      rows.push('```');
    }
  });

  if (rows.length === 0) {
    return [];
  }

  return ['Relevant captured code/context:', ...rows];
}

function readStringArray(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
}
