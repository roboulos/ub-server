import express, { Request, Response, NextFunction, Router } from 'express';
import { Pool, QueryResult } from 'pg';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import fs from 'fs';
import path from 'path';
import ts from 'typescript';

// === Interfaces ===

interface RouteInfo {
  method: string;
  path: string;
  deployed_at: string;
  language: 'js' | 'ts';
}

interface FunctionInfo {
  code: string;
  description: string;
}

interface DaemonInfo {
  timer: ReturnType<typeof setInterval>;
  interval_ms: number;
  started: string;
}

interface RouteStoreRow {
  name: string;
  method: string;
  path: string;
  code: string;
  language?: string;
  deployed_at: string;
}

interface FunctionStoreRow {
  name: string;
  code: string;
  description: string;
  created_at: string;
}

interface HealthStatus {
  server: string;
  uptime: number;
  timestamp: string;
  database?: string;
  db_time?: string;
  db_error?: string;
}

// === App Setup ===

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json({ limit: '2mb' }));

// Database connection (Neon via DATABASE_URL)
let pool: Pool | null = null;
if (process.env.DATABASE_URL) {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 10,
    idleTimeoutMillis: 30000,
  });
  pool.on('error', (err: Error) => console.error('[DB] Pool error:', err.message));
}

app.locals.db = pool;
app.locals.jwt = jwt;
app.locals.bcrypt = bcrypt;
const JWT_SECRET = process.env.JWT_SECRET || 'hp-dev-secret-change-in-prod';

// Request logging
app.use((req: Request, res: Response, next: NextFunction) => {
  const start = Date.now();
  res.on('finish', () => {
    console.log(`${req.method} ${req.path} ${res.statusCode} ${Date.now() - start}ms`);
  });
  next();
});

// === Health ===

app.get('/health', async (req: Request, res: Response) => {
  const status: HealthStatus = { server: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() };
  if (pool) {
    try {
      const result = await pool.query('SELECT NOW()');
      status.database = 'connected';
      status.db_time = result.rows[0].now;
    } catch (err: any) {
      status.database = 'error';
      status.db_error = err.message;
    }
  } else {
    status.database = 'not configured';
  }
  res.json(status);
});

// === SQL ===

app.post('/sql', async (req: Request, res: Response) => {
  if (!pool) return res.status(503).json({ error: 'Database not configured' });
  const { query, params } = req.body;
  if (!query) return res.status(400).json({ error: 'query is required' });
  try {
    const result = await pool.query(query, params || []);
    res.json({ rows: result.rows, rowCount: result.rowCount, command: result.command });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// === Dynamic Route Loader ===

const ROUTES_DIR = process.env.ROUTES_DIR || '/app/routes';
let dynamicRouter: Router = express.Router();
app.use((req: Request, res: Response, next: NextFunction) => dynamicRouter(req, res, next));

function loadRoutes(): void {
  if (!fs.existsSync(ROUTES_DIR)) {
    console.log(`[Routes] No routes directory at ${ROUTES_DIR}, skipping`);
    return;
  }
  Object.keys(require.cache).forEach(key => {
    if (key.startsWith(ROUTES_DIR)) delete require.cache[key];
  });
  const newRouter = express.Router();
  const files = fs.readdirSync(ROUTES_DIR).filter((f: string) => f.endsWith('.js'));
  for (const file of files) {
    try {
      const route = require(path.join(ROUTES_DIR, file));
      if (typeof route === 'function') {
        route({
          ...app,
          get: newRouter.get.bind(newRouter),
          post: newRouter.post.bind(newRouter),
          put: newRouter.put.bind(newRouter),
          patch: newRouter.patch.bind(newRouter),
          delete: newRouter.delete.bind(newRouter),
          locals: app.locals,
        });
        console.log(`[Routes] Loaded: ${file}`);
      }
    } catch (err: any) {
      console.error(`[Routes] Failed to load ${file}:`, err.message);
    }
  }
  dynamicRouter = newRouter;
}
loadRoutes();

app.post('/_reload', async (req: Request, res: Response) => {
  if (pool) {
    try {
      const result = await syncRoutesFromDB();
      return res.json({ success: true, message: 'Routes synced from database', ...result });
    } catch (err: any) {
      console.error('[Reload] DB sync failed, falling back to filesystem:', err.message);
    }
  }
  loadRoutes();
  res.json({ success: true, message: 'Routes reloaded from filesystem', routes: deployedRoutes.size });
});

// === Route Persistence ===

const deployedRoutes = new Map<string, RouteInfo>();

async function initRouteStore(): Promise<void> {
  if (!pool) return;
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS _route_store (
      name TEXT PRIMARY KEY,
      method TEXT NOT NULL,
      path TEXT NOT NULL,
      code TEXT NOT NULL,
      language TEXT DEFAULT 'js',
      deployed_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    // Add language column if missing (existing tables)
    await pool.query(`ALTER TABLE _route_store ADD COLUMN IF NOT EXISTS language TEXT DEFAULT 'js'`);
    const result = await pool.query('SELECT * FROM _route_store');
    for (const row of result.rows as RouteStoreRow[]) {
      deployRoute(row.name, row.method, row.path, row.code, false, (row.language || 'js') as 'js' | 'ts');
    }
    console.log(`[Routes] Restored ${result.rows.length} routes from database`);
  } catch (err: any) {
    console.error('[Routes] Failed to init route store:', err.message);
  }
}

function compileTypeScript(code: string): string {
  const result = ts.transpileModule(code, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      strict: false,
    },
  });
  return result.outputText;
}

async function deployRoute(
  name: string,
  method: string,
  routePath: string,
  code: string,
  persist: boolean = true,
  language: 'js' | 'ts' = 'js'
): Promise<void> {
  const verb = method.toLowerCase();
  const fileName = `${name}.js`;
  const filePath = path.join(ROUTES_DIR, fileName);

  // DB-first: persist before writing to filesystem
  if (persist && pool) {
    await pool.query(
      `INSERT INTO _route_store (name, method, path, code, language) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (name) DO UPDATE SET method = $2, path = $3, code = $4, language = $5, deployed_at = NOW()`,
      [name, verb.toUpperCase(), routePath, code, language]
    );
  }

  // Compile TS to JS if needed
  let compiledCode = code;
  if (language === 'ts') {
    try {
      compiledCode = compileTypeScript(code);
    } catch (err: any) {
      throw new Error(`TypeScript compilation failed: ${err.message}`);
    }
  }

  // Build wrapper via array join — NOT template literals.
  // Compiled code can contain backticks, ${ }, or any JS/TS output.
  // String concatenation is the only safe way to inject arbitrary code.
  const wrappedCode = [
    "const jwt = require('jsonwebtoken');",
    "const bcrypt = require('bcryptjs');",
    "module.exports = function(app) {",
    "  app." + verb + "('" + routePath + "', async (req, res) => {",
    "    const db = app.locals.db;",
    "    const JWT_SECRET = process.env.JWT_SECRET || 'hp-dev-secret-change-in-prod';",
    "    const getUser = () => {",
    "      const auth = req.headers.authorization;",
    "      if (!auth || !auth.startsWith('Bearer ')) return null;",
    "      try { return jwt.verify(auth.slice(7), JWT_SECRET); } catch { return null; }",
    "    };",
    "    const callFn = async (name, ...args) => app.locals.callFunction(name, ...args);",
    "    try {",
    compiledCode,
    "    } catch (err) {",
    "      res.status(500).json({ error: err.message });",
    "    }",
    "  });",
    "};",
  ].join("\n");

  fs.writeFileSync(filePath, wrappedCode);
  loadRoutes();
  deployedRoutes.set(name, {
    method: verb.toUpperCase(),
    path: routePath,
    deployed_at: new Date().toISOString(),
    language,
  });

  console.log(`[Deploy] ${verb.toUpperCase()} ${routePath} -> ${fileName} (${language})`);
}

app.post('/_deploy', async (req: Request, res: Response) => {
  const { name, method, path: routePath, code, language } = req.body;
  if (!name || !routePath || !code) {
    return res.status(400).json({ error: 'name, path, and code are required' });
  }
  const verb = (method || 'GET').toLowerCase();
  if (!['get', 'post', 'put', 'patch', 'delete'].includes(verb)) {
    return res.status(400).json({ error: 'Invalid method. Use GET, POST, PUT, PATCH, or DELETE' });
  }
  const lang: 'js' | 'ts' = language === 'ts' ? 'ts' : 'js';
  try {
    await deployRoute(name, verb.toUpperCase(), routePath, code, true, lang);
    res.json({ success: true, route: { name, method: verb.toUpperCase(), path: routePath, language: lang } });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/_undeploy', async (req: Request, res: Response) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });

  let dbDeleted = false;
  let fileDeleted = false;

  // DB-first: always clean the source of truth
  if (pool) {
    const result = await pool.query('DELETE FROM _route_store WHERE name = $1', [name]);
    dbDeleted = (result.rowCount ?? 0) > 0;
  }

  // Then clean filesystem (best effort)
  const filePath = path.join(ROUTES_DIR, `${name}.js`);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
    fileDeleted = true;
  }

  // Clean in-memory map
  deployedRoutes.delete(name);
  loadRoutes();

  if (dbDeleted || fileDeleted) {
    res.json({ success: true, removed: name, db: dbDeleted, file: fileDeleted });
  } else {
    res.status(404).json({ error: 'Route not found in database or filesystem' });
  }
});

app.get('/_routes', (req: Request, res: Response) => {
  const routes: Array<{ name: string } & RouteInfo> = [];
  deployedRoutes.forEach((val, key) => routes.push({ name: key, ...val }));
  const files = fs.existsSync(ROUTES_DIR)
    ? fs.readdirSync(ROUTES_DIR).filter((f: string) => f.endsWith('.js'))
    : [];
  res.json({ deployed: routes, files });
});

app.get('/_routes/:name', (req: Request, res: Response) => {
  const routeName = req.params.name as string;
  // Return original source code from DB if available
  const info = deployedRoutes.get(routeName);
  if (!info) {
    const filePath = path.join(ROUTES_DIR, `${routeName}.js`);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Route not found' });
    return res.json({ name: routeName, source: fs.readFileSync(filePath, 'utf8') });
  }
  // For DB-backed routes, return original source from _route_store
  if (pool) {
    pool.query('SELECT code, language FROM _route_store WHERE name = $1', [routeName])
      .then((result: QueryResult) => {
        if (result.rows.length > 0) {
          res.json({
            ...info,
            name: routeName,
            code: result.rows[0].code,
            language: result.rows[0].language || 'js',
          });
        } else {
          const filePath = path.join(ROUTES_DIR, `${routeName}.js`);
          res.json({ name: routeName, source: fs.readFileSync(filePath, 'utf8') });
        }
      })
      .catch(() => {
        const filePath = path.join(ROUTES_DIR, `${routeName}.js`);
        res.json({ name: routeName, source: fs.readFileSync(filePath, 'utf8') });
      });
  } else {
    const filePath = path.join(ROUTES_DIR, `${routeName}.js`);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Route not found' });
    res.json({ name: routeName, source: fs.readFileSync(filePath, 'utf8') });
  }
});

// === Sync & Health ===

async function syncRoutesFromDB(): Promise<{ synced: number; orphans_removed: number }> {
  if (!pool) throw new Error('Database not configured');

  const result = await pool.query('SELECT * FROM _route_store');
  const dbRoutes = new Map<string, RouteStoreRow>();
  for (const row of result.rows as RouteStoreRow[]) {
    dbRoutes.set(row.name, row);
  }

  // Remove filesystem orphans (files not in DB)
  let orphans_removed = 0;
  if (fs.existsSync(ROUTES_DIR)) {
    const files = fs.readdirSync(ROUTES_DIR).filter((f: string) => f.endsWith('.js'));
    for (const file of files) {
      const name = file.replace('.js', '');
      if (!dbRoutes.has(name)) {
        fs.unlinkSync(path.join(ROUTES_DIR, file));
        console.log(`[Sync] Removed orphan: ${file}`);
        orphans_removed++;
      }
    }
  }

  // Deploy all DB routes to filesystem + memory
  deployedRoutes.clear();
  for (const [name, row] of dbRoutes) {
    await deployRoute(name, row.method, row.path, row.code, false, (row.language || 'js') as 'js' | 'ts');
  }

  console.log(`[Sync] Synced ${dbRoutes.size} routes, removed ${orphans_removed} orphans`);
  return { synced: dbRoutes.size, orphans_removed };
}

app.post('/_sync', async (req: Request, res: Response) => {
  if (!pool) return res.status(503).json({ error: 'Database not configured' });
  try {
    const result = await syncRoutesFromDB();
    res.json({ success: true, ...result });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/_health/routes', async (req: Request, res: Response) => {
  const memoryNames = new Set(deployedRoutes.keys());
  const filesystemNames = new Set<string>();
  if (fs.existsSync(ROUTES_DIR)) {
    for (const f of fs.readdirSync(ROUTES_DIR).filter((f: string) => f.endsWith('.js'))) {
      filesystemNames.add(f.replace('.js', ''));
    }
  }
  const dbNames = new Set<string>();
  if (pool) {
    try {
      const result = await pool.query('SELECT name FROM _route_store');
      for (const row of result.rows) dbNames.add(row.name);
    } catch (err: any) {
      return res.status(500).json({ error: `DB query failed: ${err.message}` });
    }
  }

  // Compute drift
  const allNames = new Set([...memoryNames, ...filesystemNames, ...dbNames]);
  const drift: Array<{ name: string; memory: boolean; filesystem: boolean; database: boolean }> = [];
  for (const name of allNames) {
    const inMem = memoryNames.has(name);
    const inFs = filesystemNames.has(name);
    const inDb = dbNames.has(name);
    if (!(inMem && inFs && inDb)) {
      drift.push({ name, memory: inMem, filesystem: inFs, database: inDb });
    }
  }

  res.json({
    healthy: drift.length === 0,
    counts: { memory: memoryNames.size, filesystem: filesystemNames.size, database: dbNames.size },
    drift,
  });
});

// === Daemons ===

const daemons = new Map<string, DaemonInfo>();

app.post('/_daemon/start', (req: Request, res: Response) => {
  const { name, interval_ms, code } = req.body;
  if (!name || !interval_ms) return res.status(400).json({ error: 'name and interval_ms required' });
  if (daemons.has(name)) {
    clearInterval(daemons.get(name)!.timer);
  }
  try {
    const fn = new Function('db', 'fetch', 'console', code);
    const timer = setInterval(() => {
      try { fn(pool, fetch, console); }
      catch (err: any) { console.error(`[Daemon:${name}]`, err.message); }
    }, interval_ms);
    daemons.set(name, { timer, interval_ms, started: new Date().toISOString() });
    res.json({ success: true, daemon: name, interval_ms });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/_daemon/stop', (req: Request, res: Response) => {
  const { name } = req.body;
  if (!name || !daemons.has(name)) return res.status(404).json({ error: 'Daemon not found' });
  clearInterval(daemons.get(name)!.timer);
  daemons.delete(name);
  res.json({ success: true, stopped: name });
});

app.get('/_daemon/list', (req: Request, res: Response) => {
  const list: Array<{ name: string; interval_ms: number; started: string }> = [];
  daemons.forEach((val, key) => list.push({ name: key, interval_ms: val.interval_ms, started: val.started }));
  res.json({ daemons: list });
});

// === Functions ===

const storedFunctions = new Map<string, FunctionInfo>();

async function initFunctionStore(): Promise<void> {
  if (!pool) return;
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS _function_store (
      name TEXT PRIMARY KEY,
      code TEXT NOT NULL,
      description TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    const result = await pool.query('SELECT * FROM _function_store');
    for (const row of result.rows as FunctionStoreRow[]) {
      storedFunctions.set(row.name, { code: row.code, description: row.description || '' });
    }
    console.log(`[Functions] Restored ${result.rows.length} functions from database`);
  } catch (err: any) {
    console.error('[Functions] Failed to init function store:', err.message);
  }
}

async function callFunction(name: string, ...args: any[]): Promise<any> {
  const fn = storedFunctions.get(name);
  if (!fn) throw new Error(`Function "${name}" not found`);
  const executor = new Function('db', 'fetch', 'console', 'args', `return (async () => { ${fn.code} })()`);
  return executor(pool, fetch, console, args);
}

app.locals.callFunction = callFunction;

app.post('/_functions', (req: Request, res: Response) => {
  const { name, code, description } = req.body;
  if (!name || !code) return res.status(400).json({ error: 'name and code are required' });
  storedFunctions.set(name, { code, description: description || '' });
  if (pool) {
    pool.query(
      `INSERT INTO _function_store (name, code, description) VALUES ($1, $2, $3)
       ON CONFLICT (name) DO UPDATE SET code = $2, description = $3, created_at = NOW()`,
      [name, code, description || '']
    ).catch((err: Error) => console.error('[Functions] Failed to persist:', err.message));
  }
  console.log(`[Functions] Stored: ${name}`);
  res.json({ success: true, function: { name, description: description || '' } });
});

app.get('/_functions', (req: Request, res: Response) => {
  const list: Array<{ name: string; description: string }> = [];
  storedFunctions.forEach((val, key) => list.push({ name: key, description: val.description }));
  res.json({ functions: list });
});

app.get('/_functions/:name', (req: Request, res: Response) => {
  const fnName = req.params.name as string;
  const fn = storedFunctions.get(fnName);
  if (!fn) return res.status(404).json({ error: 'Function not found' });
  res.json({ name: fnName, code: fn.code, description: fn.description });
});

app.delete('/_functions/:name', (req: Request, res: Response) => {
  const fnName = req.params.name as string;
  if (!storedFunctions.has(fnName)) return res.status(404).json({ error: 'Function not found' });
  storedFunctions.delete(fnName);
  if (pool) pool.query('DELETE FROM _function_store WHERE name = $1', [fnName]).catch(() => {});
  console.log(`[Functions] Deleted: ${fnName}`);
  res.json({ success: true, deleted: fnName });
});

// === Root Info ===

app.get('/', (req: Request, res: Response) => {
  const routes: Array<{ name: string } & RouteInfo> = [];
  deployedRoutes.forEach((val, key) => routes.push({ name: key, ...val }));
  res.json({
    name: process.env.INSTANCE_NAME || 'hp-instance',
    version: '4.0.0',
    database: pool ? 'configured' : 'none',
    routes: routes.length,
    functions: storedFunctions.size,
    daemons: daemons.size,
    uptime: process.uptime(),
    typescript: true,
    endpoints: {
      system: [
        'GET /', 'GET /health', 'POST /sql',
        'POST /_deploy', 'POST /_undeploy',
        'GET /_routes', 'GET /_routes/:name',
        'POST /_reload', 'POST /_sync', 'GET /_health/routes',
        'POST /_functions', 'GET /_functions', 'GET /_functions/:name', 'DELETE /_functions/:name',
        'POST /_daemon/start', 'POST /_daemon/stop', 'GET /_daemon/list',
      ],
      deployed: routes,
    },
  });
});

// === Start ===

app.listen(PORT, async () => {
  console.log(`[HP] Server running on port ${PORT} (TypeScript build)`);
  if (pool) {
    console.log('[HP] Database configured via DATABASE_URL');
    await initRouteStore();
    await initFunctionStore();
  } else {
    console.log('[HP] No DATABASE_URL — running without database');
  }
});
