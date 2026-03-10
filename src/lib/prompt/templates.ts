export type PromptTarget = 'cursor' | 'claude' | 'copilot' | 'chatgpt';

export type PromptTemplate = {
  prefix: string;
  request: string;
};

const PROMPT_TEMPLATES: Record<PromptTarget, PromptTemplate> = {
  cursor: {
    prefix: '// Glitch Context Pack\n',
    request: 'Please diagnose the issue and propose a minimal code fix.',
  },
  claude: {
    prefix: 'I captured this UI bug with Glitch:\n',
    request: 'Please explain root cause and provide a robust fix plan.',
  },
  copilot: {
    prefix: '// UI Bug Context\n',
    request: 'Please suggest targeted code changes with rationale.',
  },
  chatgpt: {
    prefix: 'I need help debugging this frontend issue:\n',
    request: 'Please explain the likely cause and propose a fix.',
  },
};

export function getPromptTemplate(target: PromptTarget): PromptTemplate {
  return PROMPT_TEMPLATES[target];
}
