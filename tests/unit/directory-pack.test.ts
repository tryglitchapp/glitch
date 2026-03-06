import { describe, it, expect } from 'vitest';
import {
  computeStateDeltas,
  serializeElementCore,
  serializeParentChain,
} from '../../src/lib/context-pack/element-serializer';
import type { ElementState } from '../../src/lib/context-pack/pack-types';

describe('element-serializer', () => {
  it('serializes element core with selector and tag', () => {
    const state: ElementState = {
      timestamp: 0,
      boundingBox: { x: 10, y: 20, width: 100, height: 50 },
      styles: { opacity: '1' },
      classes: ['btn', 'primary'],
      isVisible: true,
      selector: '.btn.primary',
      tag: 'button',
    };

    const core = serializeElementCore(state);
    expect(core.selector).toBe('.btn.primary');
    expect(core.tag).toBe('button');
    expect(core.boundingBox.width).toBe(100);
    expect(core.classes).toEqual(['btn', 'primary']);
  });

  it('computes state deltas with only changed properties', () => {
    const base: ElementState = {
      timestamp: 0,
      boundingBox: { x: 0, y: 0, width: 100, height: 100 },
      styles: { opacity: '1', transform: 'none' },
      computedStyles: { opacity: '1', transform: 'none', color: 'red' },
      classes: ['box'],
      isVisible: true,
    };

    const next: ElementState = {
      timestamp: 16,
      boundingBox: { x: 10, y: 0, width: 100, height: 100 },
      styles: { opacity: '0.8', transform: 'translateX(10px)' },
      computedStyles: { opacity: '0.8', transform: 'translateX(10px)', color: 'red' },
      classes: ['box'],
      isVisible: true,
    };

    const deltas = computeStateDeltas([base, next]);
    expect(deltas.length).toBe(1);

    const delta = deltas[0].delta;
    expect(delta['boundingBox.x']).toBe(10);
    expect(delta['styles.opacity']).toBe('0.8');
    expect(delta['computedStyles.opacity']).toBe('0.8');
    expect(delta['computedStyles.color']).toBeUndefined();
    expect(delta.classes).toBeUndefined();
  });

  it('serializes parent chain with core styles only', () => {
    const chain = [
      {
        selector: '#container',
        boundingBox: {
          x: 0,
          y: 0,
          width: 300,
          height: 200,
          top: 0,
          right: 300,
          bottom: 200,
          left: 0,
        },
        computedStyles: {
          position: 'relative',
          overflow: 'hidden',
          'background-color': 'red',
        },
      },
    ];

    const serialized = serializeParentChain(chain);
    expect(serialized.length).toBe(1);
    expect(serialized[0].coreStyles.position).toBe('relative');
    expect(serialized[0].coreStyles.overflow).toBe('hidden');
    expect(serialized[0].coreStyles['background-color']).toBeUndefined();
  });
});
