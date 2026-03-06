import { describe, it, expect } from 'vitest';
import {
  buildDirectoryPack,
  getPackFiles,
} from '../../src/lib/context-pack/directory-pack-builder';
import type { ElementState, RecordingResult } from '../../src/lib/context-pack/pack-types';

describe('directory pack integration', () => {
  it('builds a directory pack with required files', async () => {
    const initialState: ElementState = {
      timestamp: 0,
      boundingBox: { x: 0, y: 0, width: 120, height: 40 },
      styles: { opacity: '1', transform: 'none' },
      computedStyles: { opacity: '1', transform: 'none' },
      classes: ['cta'],
      isVisible: true,
      viewport: { width: 1280, height: 720, devicePixelRatio: 1 },
    };

    const nextState: ElementState = {
      timestamp: 33,
      boundingBox: { x: 4, y: 0, width: 120, height: 40 },
      styles: { opacity: '0.9', transform: 'translateX(4px)' },
      computedStyles: { opacity: '0.9', transform: 'translateX(4px)' },
      classes: ['cta'],
      isVisible: true,
    };

    const recordingResult: RecordingResult = {
      selector: '.cta-button',
      initialState,
      stateHistory: [nextState],
      watchedElements: [
        {
          selector: '.cta-button',
          initialState,
          stateHistory: [nextState],
        },
      ],
      interactions: [],
      duration: 5000,
    };

    const pack = await buildDirectoryPack(recordingResult, {
      bugDescription: 'CTA button jitters when sidebar opens',
      url: 'https://example.com',
    });

    expect(pack.manifest.watchedElements.length).toBe(1);
    expect(pack.manifest.stats.totalStateChanges).toBe(1);

    const files = getPackFiles(pack);
    const paths = files.map((file) => file.path);

    expect(paths).toContain(`${pack.id}/manifest.json`);
    expect(paths).toContain(`${pack.id}/prompt.md`);
    expect(paths).toContain(`${pack.id}/summary.json`);
    expect(paths).toContain(`${pack.id}/interactions.json`);
    expect(paths).toContain(`${pack.id}/viewport.json`);
    expect(paths).toContain(`${pack.id}/context/elements.json`);

    const watchedDir = pack.manifest.watchedElements[0].dir;
    const watchedEntry = pack.manifest.watchedElements[0];
    expect(paths).toContain(`${pack.id}/${watchedDir}/core.json`);
    expect(paths).toContain(`${pack.id}/${watchedDir}/full-styles.json`);
    expect(paths).toContain(`${pack.id}/${watchedDir}/state-deltas.json`);
    expect(paths).toContain(`${pack.id}/${watchedDir}/parents.json`);
    expect(paths).toContain(`${pack.id}/${watchedDir}/target-ref.json`);
    expect(watchedEntry?.targetRefId).toBe('el_00');

    const targetRefFile = files.find((file) => file.path === `${pack.id}/${watchedDir}/target-ref.json`);
    expect(targetRefFile).toBeDefined();
    const targetRef = JSON.parse(String(targetRefFile?.contents)) as {
      refId: string;
      selector: string;
      occurrenceIndex: number;
      domPath: number[];
      fingerprint: { tag: string };
    };
    expect(targetRef.refId).toBe('el_00');
    expect(targetRef.selector).toBe('.cta-button');
    expect(targetRef.occurrenceIndex).toBe(0);
    expect(targetRef.domPath).toEqual([]);
    expect(targetRef.fingerprint.tag).toBe('element');
  });

  it('preserves provided targetRef identity end-to-end', async () => {
    const initialState: ElementState = {
      timestamp: 0,
      boundingBox: { x: 8, y: 12, width: 220, height: 48 },
      styles: { opacity: '1' },
      computedStyles: { opacity: '1' },
      classes: ['cta', 'primary'],
      isVisible: true,
      selector: '.cta.primary',
      tag: 'button',
    };

    const recordingResult: RecordingResult = {
      selector: '.cta.primary',
      initialState,
      watchedElements: [
        {
          selector: '.cta.primary',
          targetRef: {
            refId: 'ref_login_cta',
            selector: '.cta.primary',
            occurrenceIndex: 2,
            domPath: [0, 1, 3, 2],
            fingerprint: {
              tag: 'button',
              id: 'login-cta',
              classList: ['cta', 'primary'],
              textPrefix: 'Continue',
            },
          },
          initialState,
        },
      ],
      interactions: [
        {
          type: 'click',
          timestamp: 14,
          target: {
            selector: '.cta.primary',
            tag: 'button',
            isWatchedElement: true,
            targetRefId: 'ref_login_cta',
          },
        },
      ],
      duration: 400,
    };

    const pack = await buildDirectoryPack(recordingResult, {
      url: 'https://example.com/login',
      bugDescription: 'CTA does not respond on first click',
    });

    const watchedEntry = pack.manifest.watchedElements[0];
    expect(watchedEntry?.targetRefId).toBe('ref_login_cta');

    const watchedElement = pack.watchedElements[0];
    expect(watchedElement.targetRef?.refId).toBe('ref_login_cta');
    expect(watchedElement.targetRef?.occurrenceIndex).toBe(2);
    expect(watchedElement.targetRef?.domPath).toEqual([0, 1, 3, 2]);
    expect(watchedElement.targetRef?.fingerprint.tag).toBe('button');
    expect(watchedElement.targetRef?.fingerprint.id).toBe('login-cta');
  });
});
