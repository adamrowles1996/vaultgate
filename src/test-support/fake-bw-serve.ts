/**
 * An in-process double of the `bw serve` Vault Management API subset that
 * vaultgate uses (spec §05.3). It is a Hono app, so the client under test
 * calls it through `fetch` without a socket (ARCH-5, QG-2). Every request is
 * recorded; any route can be overridden to return an arbitrary body so
 * protocol errors are testable.
 */
import { Hono } from 'hono';

import {
  asString,
  failure,
  itemFilters,
  message,
  readBody,
  REVISION_BASE,
  secretField,
  stringData,
  success,
} from './fake-bw-serve-support.ts';
import {
  CANARY,
  fixtureCollections,
  fixtureFolders,
  type FixtureItem,
  fixtureItems,
} from './fake-vault-fixture.ts';

import type { FetchFunction } from '../bitwarden/api.ts';

export type FakeLockState = 'unauthenticated' | 'locked' | 'unlocked';

export interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

export interface FakeBwServeOptions {
  readonly masterPassword?: string;
  readonly state?: FakeLockState;
  /**
  Reads of a just-written item that still see the previous revision (VAULT-10).
  */
  readonly revisionLag?: number;
}

interface StaleRead {
  readonly snapshot: FixtureItem | undefined;
  remaining: number;
}

export class FakeBwServe {
  readonly #revisionLag: number;
  readonly #stale = new Map<string, StaleRead>();
  readonly #overrides = new Map<string, string>();
  readonly #app = new Hono();
  #revision = 0;
  #nextId = 1;
  /**
  What `/unlock` accepts; settable so a credential switch can be exercised.
  */
  masterPassword: string;
  readonly requests: RecordedRequest[] = [];
  readonly items = new Map<string, FixtureItem>();
  readonly folders = fixtureFolders();
  readonly collections = fixtureCollections();
  state: FakeLockState;
  lastSync: string | null = null;

  /**
  A `fetch` bound to this double; the host and port of the URL are ignored.
  */
  readonly fetch: FetchFunction = async (input, init) => {
    const url = new URL(input);
    const method = init?.method ?? 'GET';
    const text = typeof init?.body === 'string' ? init.body : undefined;
    this.requests.push({
      method,
      path: `${url.pathname}${url.search}`,
      body: text === undefined ? undefined : (JSON.parse(text) as unknown),
    });
    const override =
      this.#overrides.get(`${method} ${url.pathname}${url.search}`) ??
      this.#overrides.get(`${method} ${url.pathname}`);
    return override === undefined
      ? this.#app.request(input, init)
      : new Response(override, { headers: { 'content-type': 'application/json' } });
  };

  constructor(options: FakeBwServeOptions = {}) {
    this.masterPassword = options.masterPassword ?? CANARY.masterPassword;
    this.state = options.state ?? 'unlocked';
    this.#revisionLag = options.revisionLag ?? 0;
    for (const item of fixtureItems()) {
      this.items.set(String(item['id']), item);
    }
    this.#mountLifecycle();
    this.#mountReads();
    this.#mountWrites();
  }

  #nextRevision(): string {
    this.#revision += 1;
    return new Date(REVISION_BASE + this.#revision * 1000).toISOString();
  }

  #markWritten(id: string, previous: FixtureItem | undefined): void {
    if (this.#revisionLag > 0) {
      this.#stale.set(id, { snapshot: previous, remaining: this.#revisionLag });
    }
  }

  #readItem(id: string): FixtureItem | undefined {
    const stale = this.#stale.get(id);
    if (stale !== undefined && stale.remaining > 0) {
      stale.remaining -= 1;
      return stale.snapshot;
    }
    return this.items.get(id);
  }

  #mountLifecycle(): void {
    this.#app.get('/status', (context) =>
      context.json(
        success({
          object: 'template',
          template: {
            serverUrl: 'https://vault.example.test',
            lastSync: this.lastSync,
            userEmail: 'alice@example.com',
            status: this.state,
          },
        }),
      ),
    );
    this.#app.post('/unlock', async (context) => {
      const body = await readBody(context);
      if (this.state === 'unauthenticated') {
        return context.json(failure('You are not logged in.'), 400);
      }
      if (body['password'] !== this.masterPassword) {
        return context.json(failure('Invalid master password.'), 400);
      }
      this.state = 'unlocked';
      return context.json(
        success(message('Your vault is now unlocked!', { raw: CANARY.sessionKey })),
      );
    });
    this.#app.post('/lock', (context) => {
      this.state = 'locked';
      return context.json(success(message('Your vault is locked.')));
    });
    this.#app.use('*', (context, next) =>
      this.state === 'unlocked'
        ? next()
        : Promise.resolve(context.json(failure('Vault is locked.'), 400)),
    );
    this.#app.post('/sync', (context) => {
      this.lastSync = this.#nextRevision();
      return context.json(success(message('Syncing complete.')));
    });
  }

  #listItems(query: Record<string, string | undefined>): FixtureItem[] {
    const filters = itemFilters(query);
    const matches: FixtureItem[] = [];
    for (const item of this.items.values()) {
      if (filters.every((matcher) => matcher(item))) {
        matches.push(item);
      }
    }
    return matches;
  }

  #mountReads(): void {
    this.#app.get('/list/object/items', (context) => {
      const data = this.#listItems(context.req.query());
      return context.json(success({ object: 'list', data }));
    });
    this.#app.get('/list/object/folders', (context) =>
      context.json(
        success({
          object: 'list',
          data: [...this.folders, { object: 'folder', id: '', name: 'No Folder' }],
        }),
      ),
    );
    this.#app.get('/list/object/collections', (context) =>
      context.json(success({ object: 'list', data: this.collections })),
    );
    this.#app.get('/object/item/:id', (context) => {
      const item = this.#readItem(context.req.param('id'));
      return item === undefined
        ? context.json(failure('Not found.'), 404)
        : context.json(success(item));
    });
    this.#app.get('/object/:field{password|username|uri|totp|notes}/:id', (context) => {
      const item = this.items.get(context.req.param('id'));
      const value = item === undefined ? undefined : secretField(item, context.req.param('field'));
      return value === undefined
        ? context.json(failure('Not found.'), 404)
        : context.json(success(stringData(value)));
    });
    this.#app.get('/generate', (context) => {
      const query = context.req.query();
      const generated =
        query['passphrase'] === 'true'
          ? Array.from({ length: Number(query['words']) }, () => 'word').join(
              query['separator'] ?? '-',
            )
          : 'x'.repeat(Number(query['length']));
      return context.json(success(stringData(generated)));
    });
  }

  #mountWrites(): void {
    this.#app.post('/object/item', async (context) => {
      const body = await readBody(context);
      if (asString(body['name']) === undefined || typeof body['type'] !== 'number') {
        return context.json(failure('Item name and type are required.'), 400);
      }
      const id = `created-${this.#nextId++}`;
      const item: FixtureItem = {
        ...body,
        id,
        revisionDate: this.#nextRevision(),
        deletedDate: null,
      };
      this.items.set(id, item);
      this.#markWritten(id, undefined);
      return context.json(success(item));
    });
    this.#app.put('/object/item/:id', async (context) => {
      const id = context.req.param('id');
      const previous = this.items.get(id);
      const body = await readBody(context);
      if (previous === undefined) {
        return context.json(failure('Not found.'), 404);
      }
      if (asString(body['name']) === undefined) {
        return context.json(failure('Item name is required.'), 400);
      }
      const item: FixtureItem = { ...body, id, revisionDate: this.#nextRevision() };
      this.items.set(id, item);
      this.#markWritten(id, previous);
      return context.json(success(item));
    });
    this.#app.delete('/object/item/:id', (context) => {
      const id = context.req.param('id');
      const previous = this.items.get(id);
      if (previous === undefined) {
        return context.json(failure('Not found.'), 404);
      }
      this.items.set(id, { ...previous, deletedDate: this.#nextRevision() });
      this.#markWritten(id, previous);
      return context.json(success());
    });
    this.#app.post('/object/folder', async (context) => {
      const body = await readBody(context);
      const name = asString(body['name']);
      if (name === undefined) {
        return context.json(failure('Folder name is required.'), 400);
      }
      const folder = { id: `folder-${this.#nextId++}`, name };
      this.folders.push(folder);
      return context.json(success({ object: 'folder', ...folder }));
    });
  }

  /**
  Makes `METHOD /path` (optionally with a query) answer with `body` verbatim (a string is sent as-is, anything else as JSON).
  */
  override(method: string, path: string, body: unknown): void {
    this.#overrides.set(
      `${method} ${path}`,
      typeof body === 'string' ? body : JSON.stringify(body),
    );
  }

  requestsTo(path: string): RecordedRequest[] {
    return this.requests.filter((request) => request.path === path);
  }
}
