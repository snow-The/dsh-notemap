import { readFile } from 'node:fs/promises';
import { exportGraph, findRelated, graphStats, addNote, linkNotes, searchNotes, closeStore, removeNote, clearAll, unlinkNotes } from './notemap.ts';
import { importSessions } from './index.ts';

export interface UiCtx {
  webServer?: {
    register(opts: { kind: 'exact' | 'prefix'; path: string; handler: (req: any, res: any) => void | Promise<void> }): void;
  };
}

type Res = any;
const sendFile = (res: Res, type: string, body: string): void => {
  res.writeHead(200, { 'content-type': type });
  res.end(body);
};
const sendJson = (res: Res, obj: unknown, code = 200): void => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
};
const readBody = (req: any): Promise<string> =>
  new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk: Buffer) => { data += chunk.toString('utf8'); });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });

async function apiHandler(req: any, res: Res): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const route = url.pathname.replace(/^\/notemap\/api/, '') || '/';
  const method = req.method ?? 'GET';
  try {
    if (route === '/graph' && method === 'GET') {
      sendJson(res, exportGraph());
      return;
    }
    if (route === '/stats' && method === 'GET') {
      sendJson(res, graphStats());
      return;
    }
    if (route === '/related' && method === 'GET') {
      const id = url.searchParams.get('id') ?? '';
      const limit = Number(url.searchParams.get('limit') ?? 10);
      sendJson(res, findRelated({ id, limit }));
      return;
    }
    if (route === '/add' && method === 'POST') {
      const body = JSON.parse(await readBody(req) || '{}');
      sendJson(res, addNote({ title: String(body.title ?? 'untitled'), content: body.content, type: body.type }));
      return;
    }
    if (route === '/link' && method === 'POST') {
      const body = JSON.parse(await readBody(req) || '{}');
      sendJson(res, linkNotes({ source: String(body.source), target: String(body.target), type: body.type, weight: body.weight, confidence: body.confidence }));
      return;
    }
    if (route === '/unlink' && method === 'POST') {
      const body = JSON.parse(await readBody(req) || '{}');
      sendJson(res, { unlinked: unlinkNotes({ source: String(body.source), target: String(body.target), type: body.type }) });
      return;
    }
    if (route === '/project' && method === 'POST') {
      const body = JSON.parse(await readBody(req) || '{}');
      const events = Array.isArray(body.events) ? body.events : [];
      const created: string[] = [];
      for (const ev of events) {
        if (!ev || typeof ev.id !== 'string') continue;
        const title = String(ev.title ?? 'event');
        const content = typeof ev.content === 'string' ? ev.content : '';
        const type = typeof ev.type === 'string' ? ev.type : 'session-event';
        try {
          const node = addNote({ id: ev.id, title, content, type });
          created.push(node.id);
          if (typeof ev.parentId === 'string' && ev.parentId && ev.parentId !== ev.id) {
            linkNotes({ source: ev.parentId, target: ev.id, type: ev.edgeType ?? 'follows', weight: ev.weight ?? 0.8, confidence: 1 });
          }
        } catch { /* node exists: ignore */ }
      }
      sendJson(res, { ok: true, created: created.length });
      return;
    }
    if (route === '/search' && method === 'GET') {
      const q = url.searchParams.get('q') ?? '';
      sendJson(res, searchNotes({ q, limit: 20 }));
      return;
    }
    if (route === '/import-session' && method === 'POST') {
      const body = JSON.parse(await readBody(req) || '{}');
      sendJson(res, await importSessions({ limit: body.limit, force: body.force }));
      return;
    }
    if (route === '/remove' && method === 'POST') {
      const body = JSON.parse(await readBody(req) || '{}');
      sendJson(res, { removed: removeNote(String(body.id ?? '')) });
      return;
    }
    if (route === '/clear' && method === 'POST') {
      const body = JSON.parse(await readBody(req) || '{}');
      if (body.confirm !== true) { sendJson(res, { cleared: false, reason: 'confirm=true required' }); return; }
      sendJson(res, { cleared: true, ...clearAll() });
      return;
    }
    sendJson(res, { error: 'not found' }, 404);
  } catch (err: any) {
    sendJson(res, { error: err?.message ?? String(err) }, 500);
  }
}

export async function registerUi(ctx: UiCtx): Promise<void> {
  const ws = ctx.webServer;
  if (!ws) return;
  const base = new URL('../web/', import.meta.url);
  const read = (p: string) => readFile(new URL(p, base), 'utf8');
  ws.register({ kind: 'exact', path: '/notemap', handler: (_req: any, res: Res) => { res.writeHead(302, { location: '/notemap/' }); res.end(); } });
  ws.register({ kind: 'exact', path: '/notemap/', handler: async (_req: any, res: Res) => { sendFile(res, 'text/html; charset=utf-8', await read('index.html')); } });
  ws.register({ kind: 'exact', path: '/notemap/app.js', handler: async (_req: any, res: Res) => { sendFile(res, 'text/javascript; charset=utf-8', await read('app.js')); } });
  ws.register({ kind: 'exact', path: '/notemap/lit.bundle.js', handler: async (_req: any, res: Res) => { sendFile(res, 'text/javascript; charset=utf-8', await read('lit.bundle.js')); } });
  ws.register({ kind: 'exact', path: '/notemap/styles.css', handler: async (_req: any, res: Res) => { sendFile(res, 'text/css; charset=utf-8', await read('styles.css')); } });
  ws.register({ kind: 'exact', path: '/notemap/litegraph.js', handler: async (_req: any, res: Res) => { sendFile(res, 'text/javascript; charset=utf-8', await read('litegraph.js')); } });
  ws.register({ kind: 'exact', path: '/notemap/litegraph.css', handler: async (_req: any, res: Res) => { sendFile(res, 'text/css; charset=utf-8', await read('litegraph.css')); } });
  ws.register({ kind: 'prefix', path: '/notemap/api', handler: apiHandler });
}

export function disposeUi(): void {
  try { closeStore(); } catch { /* noop */ }
}
