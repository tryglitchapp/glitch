/**
 * Bug pattern analysis
 */

import type { ContextPack } from '../../types/context-pack';

export interface BugPattern {
  name: string;
  confidence: number;
  explanation: string;
  suggestions: string[];
  references?: string[];
}

export function detectBugPatterns(pack: ContextPack): BugPattern[] {
  const patterns: BugPattern[] = [];

  const layout = pack.target.layout;
  const styles = pack.target.styles;
  const trace = pack.interactionTrace;

  if (layout.overflow.clippedBy) {
    patterns.push({
      name: 'Overflow Clipping',
      confidence: 0.82,
      explanation: `Element is clipped by ${layout.overflow.clippedBy}.`,
      suggestions: [
        'Check parent overflow styles (hidden/clip/scroll).',
        'Use a portal or position: fixed if the element should escape its container.',
      ],
    });
  }

  if (typeof layout.stackingContext.zIndex === 'number' && layout.stackingContext.zIndex > 999) {
    patterns.push({
      name: 'Z-Index Conflict',
      confidence: 0.7,
      explanation: `High z-index detected (${layout.stackingContext.zIndex}).`,
      suggestions: [
        'Use a z-index scale (e.g., 10/20/30).',
        'Reduce arbitrary large z-index values across the app.',
      ],
    });
  }

  const animatingLayout = trace?.timeline?.some((segment) =>
    segment.changes?.some((change) =>
      ['width', 'height', 'margin', 'padding', 'top', 'left', 'right', 'bottom'].includes(change.property)
    )
  );
  if (animatingLayout) {
    patterns.push({
      name: 'Layout Thrashing',
      confidence: 0.6,
      explanation: 'Layout-affecting properties change during interaction.',
      suggestions: [
        'Animate transforms instead of layout properties.',
        'Use will-change: transform/opacity for smoother transitions.',
      ],
    });
  }

  if (trace?.layoutShifts && trace.layoutShifts.length > 3) {
    patterns.push({
      name: 'Layout Instability',
      confidence: 0.65,
      explanation: `${trace.layoutShifts.length} layout shifts detected during interaction.`,
      suggestions: [
        'Reserve space for async content to prevent jumps.',
        'Avoid inserting above-the-fold content after render.',
      ],
    });
  }

  if (styles.computed.transition || styles.computed.animation) {
    const hasOpacity = styles.computed.opacity && styles.computed.opacity !== '1';
    const hasTransform = styles.computed.transform && styles.computed.transform !== 'none';
    if (!hasOpacity && !hasTransform) {
      patterns.push({
        name: 'Animation Jank',
        confidence: 0.4,
        explanation: 'Animations detected without GPU-friendly properties.',
        suggestions: [
          'Prefer transform and opacity animations.',
          'Avoid animating layout properties when possible.',
        ],
      });
    }
  }

  return patterns;
}

export function classifyBug(pack: ContextPack): BugPattern | null {
  const patterns = detectBugPatterns(pack);
  if (patterns.length === 0) return null;
  return patterns.sort((a, b) => b.confidence - a.confidence)[0];
}
