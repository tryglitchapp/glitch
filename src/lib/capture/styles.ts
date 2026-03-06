/**
 * Style Extraction Library
 * Captures computed styles, inline styles, and inherited properties
 */

import type { StyleCapture } from '../../types/context-pack';

const LAYOUT_PROPERTIES = [
  'display', 'position', 'float', 'clear',
  'width', 'height', 'min-width', 'max-width', 'min-height', 'max-height',
  'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'border', 'border-width', 'border-style', 'border-color',
  'box-sizing', 'overflow', 'overflow-x', 'overflow-y',
  'flex', 'flex-direction', 'flex-wrap', 'justify-content', 'align-items', 'align-self',
  'flex-grow', 'flex-shrink', 'flex-basis',
  'grid', 'grid-template-columns', 'grid-template-rows', 'grid-column', 'grid-row',
  'gap', 'row-gap', 'column-gap',
  'transform', 'transition', 'animation',
  'z-index', 'opacity', 'visibility',
  'top', 'right', 'bottom', 'left',
  'background', 'background-color',
  'color', 'font-size', 'font-family', 'font-weight', 'line-height',
];

const INHERITED_PROPERTIES = [
  'color', 'font-family', 'font-size', 'font-weight', 'font-style',
  'line-height', 'text-align', 'text-transform', 'letter-spacing',
  'cursor', 'visibility',
];

// Core styles for parent chain (minimal set)
export const CORE_PARENT_STYLES = [
  'position', 'display', 'overflow', 'overflow-x', 'overflow-y',
  'z-index', 'flex-direction', 'flex-wrap', 'justify-content',
  'align-items', 'grid-template-columns', 'grid-template-rows',
];

export function captureCoreStyles(element: Element): Record<string, string> {
  const computed = window.getComputedStyle(element);
  const styles: Record<string, string> = {};
  for (const prop of CORE_PARENT_STYLES) {
    const value = computed.getPropertyValue(prop);
    if (value && value !== 'none' && value !== 'auto' && value !== 'normal') {
      styles[prop] = value;
    }
  }
  return styles;
}

export function captureStyles(element: Element): StyleCapture {
  const computed = window.getComputedStyle(element);
  const computedStyles: Record<string, string> = {};
  
  for (const property of LAYOUT_PROPERTIES) {
    const value = computed.getPropertyValue(property);
    if (value && value !== 'none' && value !== 'auto' && value !== 'normal') {
      computedStyles[property] = value;
    }
  }
  
  const inlineStyles: Record<string, string> = {};
  if (element instanceof HTMLElement && element.style) {
    for (let i = 0; i < element.style.length; i++) {
      const property = element.style[i];
      const value = element.style.getPropertyValue(property);
      inlineStyles[property] = value;
    }
  }
  
  const inherited: StyleCapture['inherited'] = [];
  let current = element.parentElement;
  let depth = 0;
  
  while (current && depth < 3) {
    const parentComputed = window.getComputedStyle(current);
    const elementComputed = window.getComputedStyle(element);
    
    for (const property of INHERITED_PROPERTIES) {
      const parentValue = parentComputed.getPropertyValue(property);
      const elementValue = elementComputed.getPropertyValue(property);
      
      if (parentValue === elementValue && parentValue && parentValue !== 'normal') {
        const alreadyRecorded = inherited?.some(i => i.property === property);
        
        if (!alreadyRecorded) {
          inherited?.push({
            property,
            value: parentValue,
            source: getElementLabel(current),
          });
        }
      }
    }
    
    current = current.parentElement;
    depth++;
  }
  
  return {
    computed: computedStyles,
    inline: inlineStyles,
    inherited,
  };
}

function getElementLabel(element: Element): string {
  const tag = element.tagName.toLowerCase();
  
  if (element.id) {
    return `${tag}#${element.id}`;
  }
  
  const classes = Array.from(element.classList);
  if (classes.length > 0) {
    return `${tag}.${classes[0]}`;
  }
  
  return tag;
}
