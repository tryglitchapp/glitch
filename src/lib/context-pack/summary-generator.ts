import type { BugPattern } from '../analysis/patterns';
import type { BugType } from '../../types/context-pack';
import type { DirectoryPack, PackSummary } from './pack-types';

const BUG_TYPE_PATTERNS: Record<BugType, BugPattern> = {
  animation: {
    name: 'Animation / Jitter',
    confidence: 0.35,
    explanation: 'User categorized this issue as animation or jitter.',
    suggestions: ['Inspect transform/opacity deltas across states.'],
  },
  'layout-shift': {
    name: 'Layout Shift',
    confidence: 0.35,
    explanation: 'User categorized this issue as a layout shift.',
    suggestions: ['Check bounding box changes and layout-related properties.'],
  },
  'z-index': {
    name: 'Overlap / Z-Index',
    confidence: 0.35,
    explanation: 'User categorized this issue as overlap or z-index.',
    suggestions: ['Inspect stacking context and z-index changes.'],
  },
  visibility: {
    name: 'Color / Visibility',
    confidence: 0.35,
    explanation: 'User categorized this issue as color or visibility.',
    suggestions: ['Check opacity, visibility, and color deltas.'],
  },
  overflow: {
    name: 'Overflow / Clipping',
    confidence: 0.35,
    explanation: 'User categorized this issue as overflow or clipping.',
    suggestions: ['Inspect parent chain overflow and scroll metrics.'],
  },
  other: {
    name: 'Other',
    confidence: 0.2,
    explanation: 'No specific bug category was selected.',
    suggestions: ['Start with manifest and element core data.'],
  },
};

export function generatePackSummary(pack: DirectoryPack): PackSummary {
  const watchedCount = pack.watchedElements.length;
  const interactionCount = pack.interactions.length;
  const totalStateChanges = pack.manifest.stats.totalStateChanges;
  const propertiesChanged = pack.manifest.stats.propertiesChanged;

  const keyFindings: string[] = [
    `${watchedCount} watched element${watchedCount === 1 ? '' : 's'} captured.`,
    `${totalStateChanges} state change${totalStateChanges === 1 ? '' : 's'} recorded.`,
    interactionCount > 0
      ? `${interactionCount} interaction${interactionCount === 1 ? '' : 's'} captured.`
      : 'No interactions recorded.',
  ];

  if (propertiesChanged.length > 0) {
    keyFindings.push(`Most changed properties: ${propertiesChanged.slice(0, 6).join(', ')}.`);
  }

  const recommendedMCPQueries = buildRecommendedQueries(pack);

  const detectedBugPatterns = buildDetectedPatterns(pack);

  return {
    detectedBugPatterns,
    keyFindings,
    recommendedMCPQueries,
  };
}

function buildDetectedPatterns(pack: DirectoryPack): BugPattern[] {
  const bugType = pack.manifest.bugType;
  if (!bugType) return [];
  const pattern = BUG_TYPE_PATTERNS[bugType];
  return pattern ? [pattern] : [];
}

function buildRecommendedQueries(pack: DirectoryPack): string[] {
  const queries: string[] = [];
  queries.push(`get_pack_manifest(\"${pack.id}\")`);

  const firstWatched = pack.watchedElements[0];
  if (firstWatched) {
    queries.push(
      `get_element_data(\"${pack.id}\", \"${firstWatched.id}\", [\"core\", \"states\"])`
    );
    if (firstWatched.parents && firstWatched.parents.length > 0) {
      queries.push(`get_parent_chain(\"${pack.id}\", \"${firstWatched.id}\", false)`);
    }
  }

  if (pack.manifest.stats.propertiesChanged.some((prop) => prop.includes('transform'))) {
    queries.push(`get_state_at_time(\"${pack.id}\", \"${firstWatched?.id ?? 'el_00'}\", 0)`);
  }

  return queries;
}
