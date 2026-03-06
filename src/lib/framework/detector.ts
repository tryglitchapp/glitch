/**
 * Framework detection utilities
 */

export interface FrameworkContext {
  name: 'react' | 'vue' | 'angular' | 'svelte' | 'unknown';
  version?: string;
  component?: {
    name: string;
    props?: Record<string, any>;
    state?: Record<string, any>;
  };
}

export function detectFramework(): FrameworkContext {
  if (typeof window === 'undefined') {
    return { name: 'unknown' };
  }

  const win = window as any;

  if (win.__REACT_DEVTOOLS_GLOBAL_HOOK__ || win.React) {
    const version = win.React?.version || detectReactVersion(win);
    return { name: 'react', version };
  }

  if (win.__VUE_DEVTOOLS_GLOBAL_HOOK__ || win.Vue || win.__VUE__) {
    const version = win.Vue?.version || win.__VUE__?.config?.version;
    return { name: 'vue', version };
  }

  if (win.ng || win.getAllAngularRootElements) {
    const version = win.ng?.version?.full || win.ng?.coreTokens?.VERSION?.full;
    return { name: 'angular', version };
  }

  if (win.__SVELTE_DEVTOOLS__ || win.__SVELTE__) {
    return { name: 'svelte' };
  }

  return { name: 'unknown' };
}

function detectReactVersion(win: any): string | undefined {
  try {
    const hook = win.__REACT_DEVTOOLS_GLOBAL_HOOK__;
    if (!hook || !hook.renderers) return undefined;
    
    // Check if renderers is a Map
    if (hook.renderers instanceof Map) {
      const renderers = Array.from(hook.renderers.values()) as Array<{ version?: string }>;
      return renderers[0]?.version;
    }
    
    // If it's an object, try to get values differently
    if (typeof hook.renderers === 'object') {
      const renderers = Object.values(hook.renderers) as Array<{ version?: string }>;
      return renderers[0]?.version;
    }
    
    return undefined;
  } catch {
    return undefined;
  }
}
