import { createReadStream, createWriteStream, existsSync, readFileSync, statSync } from 'node:fs';
import { appendFile, mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Connect, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const AUDIO_ENGINE_ASSET_MODULE_ID = 'virtual:audio-engine-assets';
const RESOLVED_AUDIO_ENGINE_ASSET_MODULE_ID = `\0${AUDIO_ENGINE_ASSET_MODULE_ID}`;
const AUDIO_ENGINE_ASSET_FILES = new Set([
  resolve(dirname(fileURLToPath(import.meta.url)), 'public/audio/audio-worklet-wasm.js'),
  resolve(dirname(fileURLToPath(import.meta.url)), 'public/audio/teia-kernel.wasm'),
  resolve(dirname(fileURLToPath(import.meta.url)), 'public/audio/teia-kernel-simd.wasm'),
  resolve(dirname(fileURLToPath(import.meta.url)), 'public/audio/teia-kernel-parallel.wasm'),
  resolve(dirname(fileURLToPath(import.meta.url)), 'public/audio/dsp-parallel-worker.js'),
]);

export default defineConfig({
  resolve: { dedupe: ['react', 'react-dom', '@xyflow/react'] },
  plugins: [
    react(),
    audioEngineAssetVersionPlugin(),
    localDiagnosticsPlugin(),
    renderSyncPlugin(),
    localSampleStoragePlugin(),
    localImageStoragePlugin(),
    localRecordingStoragePlugin(),
    ...(patchStorageMode() === 'browser' ? [] : [localBufferStoragePlugin(), localPatchStoragePlugin()]),
  ],
  server: {
    watch: process.env.CHOKIDAR_USEPOLLING === 'true' ? { usePolling: true, interval: 150 } : undefined,
    https: viteHttpsConfig(),
    headers: crossOriginIsolationHeaders(),
  },
  preview: {
    https: viteHttpsConfig(),
    headers: crossOriginIsolationHeaders(),
  },
});

/**
 * Public audio assets keep stable filenames, so give each URL a version derived
 * from its contents rather than relying on browser-cache behaviour. The virtual
 * module also changes on dev-server file updates and reloads the page, because
 * AudioWorklet modules cannot be replaced safely in an active AudioContext.
 */
function audioEngineAssetVersionPlugin(): Plugin {
  return {
    name: 'audio-engine-asset-version',
    resolveId(id) {
      return id === AUDIO_ENGINE_ASSET_MODULE_ID ? RESOLVED_AUDIO_ENGINE_ASSET_MODULE_ID : null;
    },
    load(id) {
      if (id !== RESOLVED_AUDIO_ENGINE_ASSET_MODULE_ID) return null;
      return [
        `export const AUDIO_WORKLET_ASSET_VERSION = ${JSON.stringify(audioAssetVersion('audio-worklet-wasm.js'))};`,
        `export const AUDIO_WASM_ASSET_VERSION = ${JSON.stringify(audioAssetVersion('teia-kernel.wasm'))};`,
        `export const AUDIO_SIMD_WASM_ASSET_VERSION = ${JSON.stringify(audioAssetVersion('teia-kernel-simd.wasm'))};`,
        `export const AUDIO_PARALLEL_WASM_ASSET_VERSION = ${JSON.stringify(audioAssetVersion('teia-kernel-parallel.wasm'))};`,
        `export const AUDIO_PARALLEL_WORKER_ASSET_VERSION = ${JSON.stringify(audioAssetVersion('dsp-parallel-worker.js'))};`,
      ].join('\n');
    },
    configureServer(server) {
      const reloadForAudioAsset = (file: string) => {
        if (!AUDIO_ENGINE_ASSET_FILES.has(resolve(file))) return;
        const module = server.moduleGraph.getModuleById(RESOLVED_AUDIO_ENGINE_ASSET_MODULE_ID);
        if (module) server.moduleGraph.invalidateModule(module);
        server.ws.send({ type: 'full-reload' });
      };
      server.watcher.on('add', reloadForAudioAsset);
      server.watcher.on('change', reloadForAudioAsset);
      server.watcher.on('unlink', reloadForAudioAsset);
    },
  };
}

function audioAssetVersion(fileName: string): string {
  const filePath = resolve(dirname(fileURLToPath(import.meta.url)), 'public/audio', fileName);
  return createHash('sha256').update(readFileSync(filePath)).digest('hex').slice(0, 16);
}

function patchStorageMode() {
  return process.env.VITE_TEIA_PATCH_STORAGE;
}

function localDiagnosticsPlugin(): Plugin {
  const diagnosticsDir = resolve(dirname(fileURLToPath(import.meta.url)), 'diagnostics');
  const logPath = join(diagnosticsDir, 'browser-events.jsonl');

  const middleware: Connect.NextHandleFunction = (request, response, next) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const path = url.pathname;

    if (path !== '/api/diagnostics') {
      next();
      return;
    }

    if (request.method === 'POST') {
      readRequestBuffer(request, 256 * 1024, 'Diagnostic payload is too large.').then(async (body) => {
        const payload = parseDiagnosticPayload(body);
        await mkdir(diagnosticsDir, { recursive: true });
        await appendFile(logPath, `${JSON.stringify(payload)}\n`, 'utf8');

        if (payload.level === 'warn' || payload.level === 'error') {
          const detail = payload.details ? ` ${JSON.stringify(payload.details)}` : '';
          console[payload.level](`[browser:${payload.sessionId}] ${payload.event}${detail}`);
        }

        response.statusCode = 204;
        response.end();
      }).catch((error: unknown) => {
        sendDiagnosticError(response, error);
      });
      return;
    }

    if (request.method === 'GET') {
      readDiagnosticTail(logPath, url).then((entries) => {
        response.statusCode = 200;
        response.setHeader('Cache-Control', 'no-store');
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ logPath, entries }, null, 2));
      }).catch((error: unknown) => {
        sendDiagnosticError(response, error);
      });
      return;
    }

    response.statusCode = 405;
    response.setHeader('Allow', 'GET, POST');
    response.end();
  };

  return {
    name: 'teia-local-diagnostics',
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}

function crossOriginIsolationHeaders() {
  return {
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
  };
}

function localSampleStoragePlugin(): Plugin {
  const samplesDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'samples');

  const middleware: Connect.NextHandleFunction = (request, response, next) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const path = url.pathname;

    if (path === '/api/local-samples' && request.method === 'GET') {
      listLocalSamples(samplesDir).then((samples) => {
        response.statusCode = 200;
        response.setHeader('Cache-Control', 'no-store');
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ samples }));
      }).catch((error: unknown) => {
        sendPatchStorageError(response, error);
      });
      return;
    }

    if (path === '/api/local-samples' && request.method === 'POST') {
      saveUploadedSample(samplesDir, request, url.searchParams.get('name')).then((sample) => {
        response.statusCode = 201;
        response.setHeader('Cache-Control', 'no-store');
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify(sample));
      }).catch((error: unknown) => {
        sendPatchStorageError(response, error);
      });
      return;
    }

    if (path.startsWith('/samples/') && (request.method === 'GET' || request.method === 'HEAD')) {
      const fileName = safeDecodedPathSegment(path.slice('/samples/'.length));
      if (!fileName || !isSafePatchStorageSegment(fileName)) {
        response.statusCode = 404;
        response.end();
        return;
      }

      const filePath = join(samplesDir, fileName);
      if (!existsSync(filePath)) {
        response.statusCode = 404;
        response.end();
        return;
      }

      const fileSize = statSync(filePath).size;
      const byteRange = requestedByteRange(request.headers.range, fileSize);
      if (byteRange === 'unsatisfiable') {
        response.statusCode = 416;
        response.setHeader('Accept-Ranges', 'bytes');
        response.setHeader('Content-Range', `bytes */${fileSize}`);
        response.end();
        return;
      }

      response.statusCode = byteRange ? 206 : 200;
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('Content-Type', sampleContentType(fileName));
      response.setHeader('Accept-Ranges', 'bytes');
      if (byteRange) {
        response.setHeader('Content-Range', `bytes ${byteRange.start}-${byteRange.end}/${fileSize}`);
        response.setHeader('Content-Length', byteRange.end - byteRange.start + 1);
      } else {
        response.setHeader('Content-Length', fileSize);
      }
      if (request.method === 'HEAD') {
        response.end();
        return;
      }
      createReadStream(filePath, byteRange ?? undefined).pipe(response);
      return;
    }

    next();
  };

  return {
    name: 'teia-local-sample-storage',
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}

interface ByteRange {
  start: number;
  end: number;
}

function requestedByteRange(header: string | undefined, fileSize: number): ByteRange | 'unsatisfiable' | null {
  if (!header) return null;
  if (fileSize <= 0 || header.includes(',')) return 'unsatisfiable';
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
  if (!match || (!match[1] && !match[2])) return 'unsatisfiable';

  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return 'unsatisfiable';
    return { start: Math.max(0, fileSize - suffixLength), end: fileSize - 1 };
  }

  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : fileSize - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) || start >= fileSize) {
    return 'unsatisfiable';
  }
  const end = Math.min(requestedEnd, fileSize - 1);
  return end >= start ? { start, end } : 'unsatisfiable';
}

function localImageStoragePlugin(): Plugin {
  const imagesDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'images');

  const middleware: Connect.NextHandleFunction = (request, response, next) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const path = url.pathname;

    if (path === '/api/local-images' && request.method === 'GET') {
      listLocalImages(imagesDir).then((images) => {
        response.statusCode = 200;
        response.setHeader('Cache-Control', 'no-store');
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ images }));
      }).catch((error: unknown) => sendPatchStorageError(response, error));
      return;
    }

    if (path === '/api/local-images' && request.method === 'POST') {
      saveUploadedImage(imagesDir, request).then((image) => {
        response.statusCode = 201;
        response.setHeader('Cache-Control', 'no-store');
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify(image));
      }).catch((error: unknown) => sendPatchStorageError(response, error));
      return;
    }

    if (path.startsWith('/images/') && (request.method === 'GET' || request.method === 'HEAD')) {
      const fileName = safeDecodedPathSegment(path.slice('/images/'.length));
      if (!fileName || !isSafePatchStorageSegment(fileName)) {
        response.statusCode = 404;
        response.end();
        return;
      }
      const filePath = join(imagesDir, fileName);
      if (!existsSync(filePath)) {
        response.statusCode = 404;
        response.end();
        return;
      }
      response.statusCode = 200;
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('Content-Type', imageContentType(fileName));
      if (request.method === 'HEAD') {
        response.end();
        return;
      }
      createReadStream(filePath).pipe(response);
      return;
    }

    next();
  };

  return {
    name: 'teia-local-image-storage',
    configureServer(server) { server.middlewares.use(middleware); },
    configurePreviewServer(server) { server.middlewares.use(middleware); },
  };
}

function localRecordingStoragePlugin(): Plugin {
  const recordingsDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'recordings');

  const middleware: Connect.NextHandleFunction = (request, response, next) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const path = url.pathname;

    if (request.method === 'POST' && path === '/api/recording-metadata') {
      saveRecordingMetadata(recordingsDir, request).then((metadata) => {
        response.statusCode = 201;
        response.setHeader('Cache-Control', 'no-store');
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify(metadata));
      }).catch((error: unknown) => sendPatchStorageError(response, error));
      return;
    }

    if (path !== '/api/recordings' || request.method !== 'POST') {
      next();
      return;
    }

    saveUploadedRecording(recordingsDir, request).then((recording) => {
      response.statusCode = 201;
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify(recording));
    }).catch((error: unknown) => {
      sendPatchStorageError(response, error);
    });
  };

  return {
    name: 'teia-local-recording-storage',
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}

function viteHttpsConfig() {
  const keyPath = process.env.TEIA_HTTPS_KEY;
  const certPath = process.env.TEIA_HTTPS_CERT;
  if (!keyPath || !certPath || !existsSync(keyPath) || !existsSync(certPath)) return undefined;

  return {
    key: readFileSync(keyPath),
    cert: readFileSync(certPath),
  };
}

function renderSyncPlugin(): Plugin {
  const latestBundles = new Map<string, string>();
  const clientsByAppId = new Map<string, Set<Connect.ServerResponse>>();

  const sendBundle = (response: Connect.ServerResponse, bundle: string) => {
    response.write(`event: render-bundle\ndata: ${bundle}\n\n`);
  };

  const middleware: Connect.NextHandleFunction = (request, response, next) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const path = url.pathname;

    if (path === '/api/render-bundle' && request.method === 'GET') {
      const appId = renderSyncAppId(url, response);
      if (!appId) return;

      const latestBundle = latestBundles.get(appId) ?? null;
      response.statusCode = latestBundle ? 200 : 204;
      response.setHeader('Cache-Control', 'no-store');
      if (latestBundle) {
        response.setHeader('Content-Type', 'application/json');
        response.end(latestBundle);
      } else {
        response.end();
      }
      return;
    }

    if (path === '/api/render-bundle' && request.method === 'POST') {
      readRequestBody(request).then((body) => {
        const appId = renderSyncAppId(url, response);
        if (!appId) return;

        latestBundles.set(appId, body);
        response.statusCode = 204;
        response.end();
        for (const client of clientsByAppId.get(appId) ?? []) {
          sendBundle(client, body);
        }
      }).catch((error: unknown) => {
        response.statusCode = 400;
        response.setHeader('Content-Type', 'text/plain');
        response.end(error instanceof Error ? error.message : String(error));
      });
      return;
    }

    if (path === '/api/render-events' && request.method === 'GET') {
      const appId = renderSyncAppId(url, response);
      if (!appId) return;

      response.statusCode = 200;
      response.setHeader('Content-Type', 'text/event-stream');
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('Connection', 'keep-alive');
      response.write('retry: 1000\n\n');
      const clients = clientsByAppId.get(appId) ?? new Set<Connect.ServerResponse>();
      clientsByAppId.set(appId, clients);
      clients.add(response);

      const latestBundle = latestBundles.get(appId);
      if (latestBundle) {
        sendBundle(response, latestBundle);
      }

      request.on('close', () => {
        clients.delete(response);
        if (clients.size === 0) {
          clientsByAppId.delete(appId);
        }
      });
      return;
    }

    next();
  };

  return {
    name: 'teia-render-sync',
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}

function renderSyncAppId(url: URL, response: Connect.ServerResponse): string | null {
  const appId = url.searchParams.get('app-id');
  if (appId && /^[A-Za-z0-9]{5}$/.test(appId)) return appId;

  response.statusCode = 400;
  response.setHeader('Content-Type', 'text/plain');
  response.end('A valid 5-character app-id is required.');
  return null;
}

function localPatchStoragePlugin(): Plugin {
  const patchesDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'patches');

  const middleware: Connect.NextHandleFunction = (request, response, next) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const path = url.pathname;

    if (!path.startsWith('/api/local-patches')) {
      next();
      return;
    }

    if (path === '/api/local-patches' && request.method === 'GET') {
      listLocalPatches(patchesDir).then((patches) => {
        response.statusCode = 200;
        response.setHeader('Cache-Control', 'no-store');
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ patches }));
      }).catch((error: unknown) => {
        sendPatchStorageError(response, error);
      });
      return;
    }

    if (path === '/api/local-patches' && request.method === 'POST') {
      readRequestBody(request).then(async (body) => {
        const payload = JSON.parse(body) as unknown;
        if (!isRecord(payload) || typeof payload.name !== 'string' || typeof payload.patchJson !== 'string') {
          throw new Error('Expected patch name and patch JSON.');
        }

        JSON.parse(payload.patchJson);
        const result = await saveLocalPatch(patchesDir, payload.name, payload.patchJson);
        response.statusCode = 201;
        response.setHeader('Cache-Control', 'no-store');
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify(result));
      }).catch((error: unknown) => {
        sendPatchStorageError(response, error);
      });
      return;
    }

    if (path === '/api/local-patches/version' && request.method === 'GET') {
      readLocalPatchVersion(patchesDir, url.searchParams.get('patch'), url.searchParams.get('version')).then((patchJson) => {
        response.statusCode = 200;
        response.setHeader('Cache-Control', 'no-store');
        response.setHeader('Content-Type', 'application/json');
        response.end(patchJson);
      }).catch((error: unknown) => {
        sendPatchStorageError(response, error);
      });
      return;
    }

    next();
  };

  return {
    name: 'teia-local-patch-storage',
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}

const BUFFER_HASH_PATTERN = /^[a-f0-9]{64}$/;
const MAX_LOCAL_BUFFER_BYTES = 960_000 * Float32Array.BYTES_PER_ELEMENT;

function localBufferStoragePlugin(): Plugin {
  const buffersDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'buffers');

  const middleware: Connect.NextHandleFunction = (request, response, next) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const path = url.pathname;
    if (!path.startsWith('/api/local-buffers')) {
      next();
      return;
    }

    if (path === '/api/local-buffers/missing' && request.method === 'POST') {
      readRequestBuffer(request, 16 * 1024, 'Buffer hash request is too large.').then((body) => {
        const payload = JSON.parse(body.toString('utf8')) as unknown;
        if (!isRecord(payload) || !Array.isArray(payload.hashes)) throw new Error('Expected Buffer hashes.');
        const hashes = [...new Set(payload.hashes)];
        if (!hashes.every((hash): hash is string => typeof hash === 'string' && BUFFER_HASH_PATTERN.test(hash))) {
          throw new Error('Invalid Buffer hash.');
        }
        response.statusCode = 200;
        response.setHeader('Cache-Control', 'no-store');
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ missing: hashes.filter((hash) => !existsSync(bufferFilePath(buffersDir, hash))) }));
      }).catch((error: unknown) => sendPatchStorageError(response, error));
      return;
    }

    const hash = safeDecodedPathSegment(path.slice('/api/local-buffers/'.length));
    if (!hash || !BUFFER_HASH_PATTERN.test(hash)) {
      response.statusCode = 404;
      response.end();
      return;
    }

    if (request.method === 'GET') {
      const filePath = bufferFilePath(buffersDir, hash);
      if (!existsSync(filePath)) {
        response.statusCode = 404;
        response.end();
        return;
      }
      response.statusCode = 200;
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('Content-Type', 'application/octet-stream');
      response.setHeader('Content-Length', statSync(filePath).size);
      createReadStream(filePath).pipe(response);
      return;
    }

    if (request.method === 'PUT') {
      readRequestBuffer(request, MAX_LOCAL_BUFFER_BYTES, 'Buffer content is too large.').then(async (body) => {
        if (body.length === 0 || body.length % Float32Array.BYTES_PER_ELEMENT !== 0) {
          throw new Error('Buffer content must contain raw Float32 samples.');
        }
        if (createHash('sha256').update(body).digest('hex') !== hash) {
          throw new Error('Buffer content does not match its hash.');
        }
        await mkdir(buffersDir, { recursive: true });
        const filePath = bufferFilePath(buffersDir, hash);
        if (!existsSync(filePath)) {
          const temporaryPath = join(buffersDir, `.${hash}.${randomUUID()}.upload`);
          try {
            await writeFile(temporaryPath, body);
            if (!existsSync(filePath)) await rename(temporaryPath, filePath);
          } finally {
            if (existsSync(temporaryPath)) await unlink(temporaryPath);
          }
        }
        response.statusCode = 204;
        response.end();
      }).catch((error: unknown) => sendPatchStorageError(response, error));
      return;
    }

    response.statusCode = 405;
    response.setHeader('Allow', 'GET, PUT');
    response.end();
  };

  return {
    name: 'teia-local-buffer-storage',
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}

function bufferFilePath(buffersDir: string, hash: string): string {
  return join(buffersDir, `${hash}.f32`);
}

interface LocalPatchVersion {
  id: string;
  savedAt: string;
}

interface LocalPatchEntry {
  name: string;
  versionCount: number;
  versions: LocalPatchVersion[];
}

interface UploadedSampleFile {
  name: string;
  contentType: string;
  data: Buffer;
}

interface DiagnosticLogEntry {
  sessionId: string;
  timestamp: string;
  serverReceivedAt: string;
  performanceNowMs: number | null;
  level: 'info' | 'warn' | 'error';
  event: string;
  url: string;
  visibilityState: string;
  details?: unknown;
}

const MAX_SAMPLE_UPLOAD_BYTES = 1024 * 1024 * 1024;
const MAX_IMAGE_UPLOAD_BYTES = 50 * 1024 * 1024;
const MAX_RECORDING_UPLOAD_BYTES = 1024 * 1024 * 1024;
const SAMPLE_AUDIO_EXTENSIONS = new Set([
  '.aac',
  '.aif',
  '.aiff',
  '.flac',
  '.m4a',
  '.mp3',
  '.mp4',
  '.oga',
  '.ogg',
  '.wav',
  '.wave',
  '.webm',
]);
const IMAGE_EXTENSIONS = new Set(['.avif', '.gif', '.jpeg', '.jpg', '.png', '.webp']);
const VIDEO_PROXY_SUFFIX = '.teia-proxy.mp4';

async function saveUploadedRecording(recordingsDir: string, request: Connect.IncomingMessage) {
  const contentType = Array.isArray(request.headers['content-type'])
    ? request.headers['content-type'][0]
    : request.headers['content-type'] ?? '';
  if (!contentType.toLowerCase().startsWith('audio/wav')) {
    throw new Error('Expected a WAV recording upload.');
  }

  const data = await readRequestBuffer(request, MAX_RECORDING_UPLOAD_BYTES, 'Recording upload is too large.');
  if (!isWavData(data)) {
    throw new Error('Expected WAV audio data.');
  }

  await mkdir(recordingsDir, { recursive: true });
  const encodedPatchNameHeader = request.headers['x-teia-patch-name-encoded'];
  const encodedPatchName = Array.isArray(encodedPatchNameHeader) ? encodedPatchNameHeader[0] : encodedPatchNameHeader;
  const patchName = encodedPatchName === undefined ? undefined : decodeRecordingPatchName(encodedPatchName);
  const name = await uniqueSampleFilename(recordingsDir, recordingFilename(patchName));
  await writeFile(join(recordingsDir, name), data);

  return { name };
}

async function saveRecordingMetadata(recordingsDir: string, request: Connect.IncomingMessage) {
  const recordingHeader = request.headers['x-teia-recording-name'];
  const recordingName = Array.isArray(recordingHeader) ? recordingHeader[0] : recordingHeader;
  const safeRecordingName = basename(recordingName ?? '');
  if (!safeRecordingName.toLowerCase().endsWith('.wav')) {
    throw new Error('Expected the associated WAV recording name.');
  }
  const data = await readRequestBuffer(request, 16 * 1024 * 1024, 'Recording metadata is too large.');
  await mkdir(recordingsDir, { recursive: true });
  const name = `${safeRecordingName.slice(0, -4)}.csv`;
  await writeFile(join(recordingsDir, name), data);
  return { name };
}

function parseDiagnosticPayload(body: Buffer): DiagnosticLogEntry {
  const payload = JSON.parse(body.toString('utf8')) as unknown;
  if (!isRecord(payload)) {
    throw new Error('Expected a diagnostic event object.');
  }

  const level = payload.level === 'warn' || payload.level === 'error' ? payload.level : 'info';
  const sessionId = typeof payload.sessionId === 'string' && payload.sessionId ? payload.sessionId.slice(0, 120) : 'unknown-session';
  const event = typeof payload.event === 'string' && payload.event ? payload.event.slice(0, 160) : 'unknown-event';
  const timestamp = typeof payload.timestamp === 'string' && payload.timestamp ? payload.timestamp : new Date().toISOString();
  const performanceNowMs = typeof payload.performanceNowMs === 'number' && Number.isFinite(payload.performanceNowMs)
    ? payload.performanceNowMs
    : null;
  const url = typeof payload.url === 'string' ? payload.url.slice(0, 2048) : '';
  const visibilityState = typeof payload.visibilityState === 'string' ? payload.visibilityState.slice(0, 40) : '';

  return {
    sessionId,
    timestamp,
    serverReceivedAt: new Date().toISOString(),
    performanceNowMs,
    level,
    event,
    url,
    visibilityState,
    ...(payload.details !== undefined ? { details: payload.details } : {}),
  };
}

async function readDiagnosticTail(logPath: string, url: URL): Promise<unknown[]> {
  if (!existsSync(logPath)) return [];

  const requestedLines = Number(url.searchParams.get('lines') ?? 200);
  const lineCount = Math.max(1, Math.min(1000, Number.isFinite(requestedLines) ? Math.trunc(requestedLines) : 200));
  const text = await readFile(logPath, 'utf8');
  const lines = text.trimEnd().split('\n').filter(Boolean).slice(-lineCount);
  return lines.map((line) => {
    try {
      return JSON.parse(line) as unknown;
    } catch {
      return { parseError: true, raw: line };
    }
  });
}

async function saveUploadedSample(
  samplesDir: string,
  request: Connect.IncomingMessage,
  requestedName: string | null,
) {
  if (requestedName) {
    return saveStreamedSampleUpload(samplesDir, request, requestedName);
  }

  const boundary = multipartBoundary(request.headers['content-type']);
  if (!boundary) throw new Error('Expected a multipart sample upload.');

  const body = await readRequestBuffer(request, MAX_SAMPLE_UPLOAD_BYTES, 'Sample upload is too large.');
  const uploaded = parseMultipartSampleFile(body, boundary);
  if (!uploaded) throw new Error('Expected an audio file named "sample".');
  const isSupportedMediaType = uploaded.contentType.startsWith('audio/')
    || uploaded.contentType === 'video/mp4'
    || uploaded.contentType === 'application/mp4'
    || uploaded.contentType === 'application/octet-stream';
  if (!isSupportedMediaType) {
    throw new Error('Expected an audio file or MP4 video upload.');
  }

  const fileName = sanitizeSampleFilename(uploaded.name);
  await mkdir(samplesDir, { recursive: true });
  const savedName = await uniqueSampleFilename(samplesDir, fileName);
  await writeFile(join(samplesDir, savedName), uploaded.data);
  return finalizeUploadedSample(samplesDir, savedName);
}

async function saveStreamedSampleUpload(
  samplesDir: string,
  request: Connect.IncomingMessage,
  requestedName: string,
) {
  const contentTypeHeader = request.headers['content-type'];
  const contentType = (Array.isArray(contentTypeHeader) ? contentTypeHeader[0] : contentTypeHeader)
    ?.split(';', 1)[0]
    ?.trim()
    .toLowerCase() ?? 'application/octet-stream';
  const isSupportedMediaType = contentType.startsWith('audio/')
    || contentType === 'video/mp4'
    || contentType === 'application/mp4'
    || contentType === 'application/octet-stream';
  if (!isSupportedMediaType) {
    throw new Error('Expected an audio file or MP4 video upload.');
  }

  const fileName = sanitizeSampleFilename(requestedName);
  await mkdir(samplesDir, { recursive: true });
  const savedName = await uniqueSampleFilename(samplesDir, fileName);
  const temporaryPath = join(samplesDir, `.${savedName}.${randomUUID()}.upload`);
  const finalPath = join(samplesDir, savedName);

  try {
    await streamRequestToFile(request, temporaryPath, MAX_SAMPLE_UPLOAD_BYTES);
    await rename(temporaryPath, finalPath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }

  return finalizeUploadedSample(samplesDir, savedName);
}

async function finalizeUploadedSample(samplesDir: string, savedName: string) {
  const originalUrl = `/samples/${encodeURIComponent(savedName)}`;
  if (extname(savedName).toLowerCase() !== '.mp4') {
    return { name: savedName, url: originalUrl };
  }

  const proxyName = `${basename(savedName, extname(savedName))}${VIDEO_PROXY_SUFFIX}`;
  const proxyPath = join(samplesDir, proxyName);
  try {
    await transcodeVideoProxy(join(samplesDir, savedName), proxyPath);
  } catch (error) {
    await unlink(proxyPath).catch(() => undefined);
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`The original video was saved as "${savedName}", but its UI proxy could not be created: ${message}`);
  }

  return {
    name: savedName,
    url: `/samples/${encodeURIComponent(proxyName)}`,
    originalUrl,
  };
}

function transcodeVideoProxy(inputPath: string, outputPath: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
      '-i', inputPath,
      '-map', '0:v:0', '-map', '0:a:0?',
      '-vf', 'scale=640:480:force_original_aspect_ratio=decrease:force_divisible_by=2',
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '28',
      // Every frame is independently decodable, trading some proxy size for
      // consistently fast seeks to arbitrary frames in the editor.
      '-g', '1', '-keyint_min', '1', '-sc_threshold', '0',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k',
      '-movflags', '+faststart',
      outputPath,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < 16_384) stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      reject(new Error(stderr.trim() || `ffmpeg exited with status ${code ?? 'unknown'}.`));
    });
  });
}

function streamRequestToFile(
  request: Connect.IncomingMessage,
  filePath: string,
  maxBytes: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const output = createWriteStream(filePath, { flags: 'wx' });
    let byteLength = 0;
    let tooLarge = false;
    let settled = false;

    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      output.destroy();
      reject(error);
    };

    output.on('error', fail);
    request.on('error', fail);
    request.on('data', (chunk: Buffer) => {
      byteLength += chunk.length;
      if (byteLength > maxBytes) {
        tooLarge = true;
        return;
      }
      if (!output.write(chunk)) {
        request.pause();
        output.once('drain', () => request.resume());
      }
    });
    request.on('end', () => {
      if (tooLarge) {
        fail(new Error('Sample upload is too large (maximum 1 GB).'));
        return;
      }
      output.end(() => {
        if (settled) return;
        settled = true;
        resolve();
      });
    });
  });
}

async function saveUploadedImage(imagesDir: string, request: Connect.IncomingMessage) {
  const boundary = multipartBoundary(request.headers['content-type']);
  if (!boundary) throw new Error('Expected a multipart image upload.');
  const body = await readRequestBuffer(request, MAX_IMAGE_UPLOAD_BYTES, 'Image upload is too large.');
  const uploaded = parseMultipartFile(body, boundary, 'image');
  if (!uploaded) throw new Error('Expected an image file named "image".');
  if (!uploaded.contentType.startsWith('image/') && uploaded.contentType !== 'application/octet-stream') {
    throw new Error('Expected an image file upload.');
  }
  const fileName = sanitizeImageFilename(uploaded.name);
  await mkdir(imagesDir, { recursive: true });
  const savedName = await uniqueSampleFilename(imagesDir, fileName);
  await writeFile(join(imagesDir, savedName), uploaded.data);
  return { name: savedName, url: `/images/${encodeURIComponent(savedName)}` };
}

function recordingFilename(patchName: string | undefined): string {
  const patchStem = sanitizeRecordingPatchName(patchName);
  const timestamp = new Date().toISOString()
    .replace(/\.\d{3}Z$/, 'Z')
    .replace(/:/g, '-');
  return `${patchStem}-recording-${timestamp}.wav`;
}

function decodeRecordingPatchName(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new Error('Invalid encoded recording patch name.');
  }
}

function sanitizeRecordingPatchName(name: string | undefined): string {
  const cleaned = (name ?? '')
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^\.+/, '')
    .replace(/\.+$/, '');
  return cleaned || 'untitled-patch';
}

function isWavData(data: Buffer): boolean {
  return (
    data.length >= 44 &&
    data.subarray(0, 4).toString('ascii') === 'RIFF' &&
    data.subarray(8, 12).toString('ascii') === 'WAVE'
  );
}

async function listLocalSamples(samplesDir: string) {
  if (!existsSync(samplesDir)) return [];

  const entries = await readdir(samplesDir, { withFileTypes: true });
  const entryNames = new Set(entries.filter((entry) => entry.isFile()).map((entry) => entry.name));
  const samples = await Promise.all(entries
    .filter((entry) => entry.isFile()
      && !entry.name.endsWith(VIDEO_PROXY_SUFFIX)
      && isSafePatchStorageSegment(entry.name)
      && SAMPLE_AUDIO_EXTENSIONS.has(extname(entry.name).toLowerCase()))
    .map(async (entry) => {
      const fileStats = await stat(join(samplesDir, entry.name));
      const stem = basename(entry.name, extname(entry.name));
      const teiaProxyName = `${stem}${VIDEO_PROXY_SUFFIX}`;
      const proxyName = extname(entry.name).toLowerCase() === '.mp4'
        ? teiaProxyName
        : null;
      return {
        name: entry.name,
        url: `/samples/${encodeURIComponent(proxyName && entryNames.has(proxyName) ? proxyName : entry.name)}`,
        ...(proxyName && entryNames.has(proxyName)
          ? { originalUrl: `/samples/${encodeURIComponent(entry.name)}` }
          : {}),
        updatedAt: fileStats.mtime.getTime(),
      };
    }));

  return samples
    .sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name))
    .map(({ name, url, originalUrl }) => ({ name, url, ...(originalUrl ? { originalUrl } : {}) }));
}

async function listLocalImages(imagesDir: string) {
  if (!existsSync(imagesDir)) return [];
  const entries = await readdir(imagesDir, { withFileTypes: true });
  const images = await Promise.all(entries
    .filter((entry) => entry.isFile() && isSafePatchStorageSegment(entry.name) && IMAGE_EXTENSIONS.has(extname(entry.name).toLowerCase()))
    .map(async (entry) => {
      const fileStats = await stat(join(imagesDir, entry.name));
      return { name: entry.name, url: `/images/${encodeURIComponent(entry.name)}`, updatedAt: fileStats.mtime.getTime() };
    }));
  return images
    .sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name))
    .map(({ name, url }) => ({ name, url }));
}

function multipartBoundary(contentType: string | string[] | undefined): string | null {
  const header = Array.isArray(contentType) ? contentType[0] : contentType;
  const match = header?.match(/(?:^|;)\s*boundary=(?:"([^"]+)"|([^;]+))/i);
  return match?.[1] ?? match?.[2] ?? null;
}

function parseMultipartSampleFile(body: Buffer, boundary: string): UploadedSampleFile | null {
  return parseMultipartFile(body, boundary, 'sample');
}

function parseMultipartFile(body: Buffer, boundary: string, expectedFieldName: string): UploadedSampleFile | null {
  const delimiter = Buffer.from(`--${boundary}`);
  const headerDelimiter = Buffer.from('\r\n\r\n');
  let searchFrom = 0;

  while (searchFrom < body.length) {
    const delimiterStart = body.indexOf(delimiter, searchFrom);
    if (delimiterStart < 0) return null;
    let partStart = delimiterStart + delimiter.length;
    if (body[partStart] === 45 && body[partStart + 1] === 45) return null;
    if (body[partStart] === 13 && body[partStart + 1] === 10) partStart += 2;

    const headerEnd = body.indexOf(headerDelimiter, partStart);
    if (headerEnd < 0) return null;

    const nextDelimiter = body.indexOf(delimiter, headerEnd + headerDelimiter.length);
    if (nextDelimiter < 0) return null;

    const headers = body.subarray(partStart, headerEnd).toString('utf8');
    let dataEnd = nextDelimiter;
    if (body[dataEnd - 2] === 13 && body[dataEnd - 1] === 10) dataEnd -= 2;

    const disposition = headers.match(/content-disposition:[^\r\n]*/i)?.[0] ?? '';
    const fieldName = disposition.match(/\bname="([^"]+)"/i)?.[1] ?? '';
    const fileName = disposition.match(/\bfilename="([^"]*)"/i)?.[1] ?? '';
    if (fieldName === expectedFieldName && fileName) {
      return {
        name: fileName,
        contentType: headers.match(/content-type:\s*([^\r\n]+)/i)?.[1]?.trim().toLowerCase() ?? 'application/octet-stream',
        data: Buffer.from(body.subarray(headerEnd + headerDelimiter.length, dataEnd)),
      };
    }

    searchFrom = nextDelimiter + delimiter.length;
  }

  return null;
}

function sanitizeSampleFilename(name: string): string {
  const extension = extname(name).toLowerCase();
  if (!SAMPLE_AUDIO_EXTENSIONS.has(extension)) {
    throw new Error('Unsupported sample file type.');
  }

  const stem = basename(name, extension)
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^\.+/, '')
    .replace(/\.+$/, '') || 'sample';

  return `${stem}${extension}`;
}

function sanitizeImageFilename(name: string): string {
  const extension = extname(name).toLowerCase();
  if (!IMAGE_EXTENSIONS.has(extension)) throw new Error('Unsupported image file type.');
  const stem = basename(name, extension)
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^\.+/, '')
    .replace(/\.+$/, '') || 'image';
  return `${stem}${extension}`;
}

async function uniqueSampleFilename(samplesDir: string, fileName: string): Promise<string> {
  const extension = extname(fileName);
  const stem = basename(fileName, extension);
  let candidate = fileName;
  let suffix = 2;
  while (existsSync(join(samplesDir, candidate))) {
    candidate = `${stem}-${suffix}${extension}`;
    suffix += 1;
  }
  return candidate;
}

async function listLocalPatches(patchesDir: string): Promise<LocalPatchEntry[]> {
  if (!existsSync(patchesDir)) return [];

  const entries = await readdir(patchesDir, { withFileTypes: true });
  const patches = await Promise.all(entries
    .filter((entry) => entry.isDirectory() && isSafePatchStorageSegment(entry.name))
    .map(async (entry): Promise<LocalPatchEntry | null> => {
      const patchDir = join(patchesDir, entry.name);
      const files = await readdir(patchDir, { withFileTypes: true });
      const versions = await Promise.all(files
        .filter((file) => file.isFile() && file.name.endsWith('.json') && isSafePatchVersionFilename(file.name))
        .map(async (file): Promise<LocalPatchVersion> => {
          const fileStats = await stat(join(patchDir, file.name));
          return {
            id: file.name.slice(0, -'.json'.length),
            savedAt: fileStats.mtime.toISOString(),
          };
        }));

      versions.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
      if (versions.length === 0) return null;

      return {
        name: entry.name,
        versionCount: versions.length,
        versions,
      };
    }));

  return patches
    .filter((entry): entry is LocalPatchEntry => entry !== null)
    .sort((a, b) => {
      const latestA = a.versions[0]?.savedAt ?? '';
      const latestB = b.versions[0]?.savedAt ?? '';
      return latestB.localeCompare(latestA) || a.name.localeCompare(b.name);
    });
}

async function saveLocalPatch(patchesDir: string, requestedName: string, patchJson: string) {
  const patchName = sanitizePatchStorageSegment(requestedName);
  const patchDir = join(patchesDir, patchName);
  await mkdir(patchDir, { recursive: true });

  const savedAt = new Date();
  const versionId = savedAt.toISOString().replace(/:/g, '-');
  let filePath = join(patchDir, `${versionId}.json`);
  let suffix = 2;
  while (existsSync(filePath)) {
    filePath = join(patchDir, `${versionId}-${suffix}.json`);
    suffix += 1;
  }

  await writeFile(filePath, patchJson, 'utf8');

  return {
    patchName,
    version: {
      id: filePath.slice(patchDir.length + 1, -'.json'.length),
      savedAt: savedAt.toISOString(),
    },
  };
}

async function readLocalPatchVersion(patchesDir: string, patchName: string | null, versionId: string | null): Promise<string> {
  if (!patchName || !versionId || !isSafePatchStorageSegment(patchName) || !isSafePatchStorageSegment(versionId)) {
    throw new Error('Invalid patch version.');
  }

  return readFile(join(patchesDir, patchName, `${versionId}.json`), 'utf8');
}

function sanitizePatchStorageSegment(name: string): string {
  const cleaned = name
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^\.+/, '')
    .replace(/\.+$/, '');

  return cleaned || 'untitled-patch';
}

function isSafePatchStorageSegment(value: string): boolean {
  return (
    value.length > 0 &&
    value !== '.' &&
    value !== '..' &&
    !value.includes('/') &&
    !value.includes('\\') &&
    !/[\u0000-\u001f]/.test(value)
  );
}

function isSafePatchVersionFilename(value: string): boolean {
  return /^[0-9TZ_.-]+\.json$/.test(value);
}

function safeDecodedPathSegment(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function sampleContentType(fileName: string): string {
  switch (extname(fileName).toLowerCase()) {
    case '.aac':
      return 'audio/aac';
    case '.aif':
    case '.aiff':
      return 'audio/aiff';
    case '.flac':
      return 'audio/flac';
    case '.m4a':
      return 'audio/mp4';
    case '.mp3':
      return 'audio/mpeg';
    case '.mp4':
      // Preserve the asset as video media so a future Sample video display can
      // consume the same uploaded file; playback currently decodes its audio track.
      return 'video/mp4';
    case '.oga':
    case '.ogg':
      return 'audio/ogg';
    case '.wav':
    case '.wave':
      return 'audio/wav';
    case '.webm':
      return 'audio/webm';
    default:
      return 'application/octet-stream';
  }
}

function imageContentType(fileName: string): string {
  switch (extname(fileName).toLowerCase()) {
    case '.avif': return 'image/avif';
    case '.gif': return 'image/gif';
    case '.jpeg':
    case '.jpg': return 'image/jpeg';
    case '.png': return 'image/png';
    case '.webp': return 'image/webp';
    default: return 'application/octet-stream';
  }
}

function sendPatchStorageError(response: Connect.ServerResponse, error: unknown): void {
  response.statusCode = 400;
  response.setHeader('Content-Type', 'text/plain');
  response.end(error instanceof Error ? error.message : String(error));
}

function sendDiagnosticError(response: Connect.ServerResponse, error: unknown): void {
  response.statusCode = 400;
  response.setHeader('Content-Type', 'text/plain');
  response.end(error instanceof Error ? error.message : String(error));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readRequestBody(request: Connect.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];

    request.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    request.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    request.on('error', reject);
  });
}

function readRequestBuffer(request: Connect.IncomingMessage, maxBytes: number, tooLargeMessage: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let byteLength = 0;
    let tooLarge = false;

    request.on('data', (chunk: Buffer) => {
      byteLength += chunk.length;
      if (byteLength > maxBytes) {
        tooLarge = true;
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (tooLarge) {
        reject(new Error(tooLargeMessage));
      } else {
        resolve(Buffer.concat(chunks));
      }
    });
    request.on('error', reject);
  });
}
