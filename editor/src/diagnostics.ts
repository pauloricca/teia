type DiagnosticLevel = 'info' | 'warn' | 'error';

interface DiagnosticEvent {
  level?: DiagnosticLevel;
  event: string;
  details?: Record<string, unknown>;
}

const DIAGNOSTIC_ENDPOINT = '/api/diagnostics';
const PERFORMANCE_TIMELINE_MAINTENANCE_INTERVAL_MS = 1_000;
const PERFORMANCE_TIMELINE_ENTRY_LIMIT = 1_000;
const SESSION_STORAGE_KEY = 'teia-editor.diagnostics-session';

let sessionId: string | undefined; // Acquire standalone diagnostics storage only on first log.
let lastPerformanceTimelineMaintenanceAt = 0;

const buildEnvironment = import.meta.env as ImportMetaEnv & {
  MODE: string;
  DEV: boolean;
  PROD: boolean;
};

export function installDiagnostics(): void {
  const windowWithDiagnostics = window as Window & { __teiaDiagnosticsInstalled?: boolean };
  if (windowWithDiagnostics.__teiaDiagnosticsInstalled) return;
  windowWithDiagnostics.__teiaDiagnosticsInstalled = true;

  logDiagnosticEvent('page-loaded', {
    level: 'info',
    details: {
      href: window.location.href,
      userAgent: navigator.userAgent,
      crossOriginIsolated: window.crossOriginIsolated,
      hardwareConcurrency: navigator.hardwareConcurrency,
      deviceMemoryGb: navigatorDeviceMemory(),
      build: {
        mode: buildEnvironment.MODE,
        development: buildEnvironment.DEV,
        production: buildEnvironment.PROD,
      },
      viewport: viewportSnapshot(),
      gpu: gpuSnapshot(),
    },
  });

  window.addEventListener('error', (event) => {
    if (isBenignResizeObserverError(event.message)) return;

    logDiagnosticEvent('window-error', {
      level: 'error',
      details: {
        message: event.message,
        source: event.filename,
        line: event.lineno,
        column: event.colno,
        error: serializeError(event.error),
      },
    });
  });

  window.addEventListener('unhandledrejection', (event) => {
    logDiagnosticEvent('unhandled-rejection', {
      level: 'error',
      details: {
        reason: serializeError(event.reason),
      },
    });
  });

  document.addEventListener('visibilitychange', () => {
    logDiagnosticEvent('visibility-change', {
      details: {
        visibilityState: document.visibilityState,
        hidden: document.hidden,
      },
    });
  });

  window.addEventListener('pagehide', (event) => {
    logDiagnosticEvent('page-hide', {
      details: {
        persisted: event.persisted,
      },
      flush: true,
    });
  });

  window.addEventListener('pageshow', (event) => {
    logDiagnosticEvent('page-show', {
      details: {
        persisted: event.persisted,
      },
    });
  });

  window.addEventListener('online', () => {
    logDiagnosticEvent('network-online');
  });
  window.addEventListener('offline', () => {
    logDiagnosticEvent('network-offline');
  });


}

export function logDiagnosticEvent(
  event: string,
  options: {
    level?: DiagnosticLevel;
    details?: Record<string, unknown>;
    flush?: boolean;
  } = {},
): void {
  const now = performance.now();
  // Maintain the timeline only when something happens; idle pages need no timer.
  if (now - lastPerformanceTimelineMaintenanceAt >= PERFORMANCE_TIMELINE_MAINTENANCE_INTERVAL_MS) {
    lastPerformanceTimelineMaintenanceAt = now;
    maintainPerformanceTimeline();
  }

  const payload = {
    sessionId: sessionId ??= getSessionId(),
    timestamp: new Date().toISOString(),
    performanceNowMs: Math.round(now),
    level: options.level ?? 'info',
    event,
    url: window.location.href,
    visibilityState: document.visibilityState,
    details: sanitizeDetails({
      ...options.details,
      memory: options.details?.memory ?? memorySnapshot(),
    }),
  };
  const body = JSON.stringify(payload);

  if (options.flush && navigator.sendBeacon) {
    navigator.sendBeacon(DIAGNOSTIC_ENDPOINT, new Blob([body], { type: 'application/json' }));
    return;
  }

  void fetch(DIAGNOSTIC_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    keepalive: options.flush,
  }).catch(() => undefined);
}

export function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }
  if (typeof error === 'object' && error !== null) {
    return sanitizeDetails(error as Record<string, unknown>);
  }
  return { value: String(error) };
}

function getSessionId(): string {
  try {
    const existing = window.sessionStorage.getItem(SESSION_STORAGE_KEY);
    if (existing) return existing;
    const next = crypto.randomUUID();
    window.sessionStorage.setItem(SESSION_STORAGE_KEY, next);
    return next;
  } catch {
    return `session-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
}

function sanitizeDetails(details: Record<string, unknown>): Record<string, unknown> {
  const json = JSON.stringify(details, (_key, value) => {
    if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
    if (typeof value === 'bigint') return String(value);
    if (typeof value === 'function' || typeof value === 'symbol') return undefined;
    return value;
  });
  return JSON.parse(json) as Record<string, unknown>;
}

function viewportSnapshot() {
  return {
    width: window.innerWidth,
    height: window.innerHeight,
    devicePixelRatio: window.devicePixelRatio,
  };
}

function memorySnapshot() {
  const performanceWithMemory = performance as Performance & {
    memory?: {
      jsHeapSizeLimit?: number;
      totalJSHeapSize?: number;
      usedJSHeapSize?: number;
    };
  };
  const memory = performanceWithMemory.memory;
  if (!memory) return null;
  return {
    jsHeapSizeLimit: memory.jsHeapSizeLimit,
    totalJSHeapSize: memory.totalJSHeapSize,
    usedJSHeapSize: memory.usedJSHeapSize,
  };
}

function maintainPerformanceTimeline() {
  const snapshot = performanceTimelineSnapshot(false);
  const shouldClear = snapshot.measures > PERFORMANCE_TIMELINE_ENTRY_LIMIT
    || snapshot.marks > PERFORMANCE_TIMELINE_ENTRY_LIMIT;
  if (shouldClear) {
    performance.clearMeasures();
    performance.clearMarks();
  }
  return { ...snapshot, cleared: shouldClear };
}

function performanceTimelineSnapshot(cleared: boolean) {
  return {
    measures: performance.getEntriesByType('measure').length,
    marks: performance.getEntriesByType('mark').length,
    resources: performance.getEntriesByType('resource').length,
    cleared,
  };
}

function navigatorDeviceMemory(): number | null {
  const navigatorWithMemory = navigator as Navigator & { deviceMemory?: number };
  return typeof navigatorWithMemory.deviceMemory === 'number' ? navigatorWithMemory.deviceMemory : null;
}

function isBenignResizeObserverError(message: string): boolean {
  return message === 'ResizeObserver loop limit exceeded'
    || message === 'ResizeObserver loop completed with undelivered notifications.';
}

function gpuSnapshot() {
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
  if (!context) return null;

  const debugInfo = context.getExtension('WEBGL_debug_renderer_info');
  return {
    vendor: debugInfo ? context.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL) : context.getParameter(context.VENDOR),
    renderer: debugInfo ? context.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) : context.getParameter(context.RENDERER),
    version: context.getParameter(context.VERSION),
  };
}
