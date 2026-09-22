/**
The helpers behind `FakeBwServe`: response envelopes, item field access and search filters.
*/
import type { FixtureItem } from './fake-vault-fixture.ts';

export type Body = Readonly<Record<string, unknown>>;

export const REVISION_BASE = Date.UTC(2026, 8, 22, 12, 0, 0);

export function success(data?: unknown): Body {
  return data === undefined ? { success: true } : { success: true, data };
}

export function failure(message: string): Body {
  return { success: false, message };
}

export function message(title: string, extra: Body = {}): Body {
  return { object: 'message', title, message: null, ...extra };
}

export function stringData(data: string): Body {
  return { object: 'string', data };
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function nested(item: FixtureItem, key: string): Body {
  const value = item[key];
  return typeof value === 'object' && value !== null ? (value as Body) : {};
}

function loginField(item: FixtureItem, field: string): string | undefined {
  const login = nested(item, 'login');
  if (field === 'uri') {
    const uris = Array.isArray(login['uris']) ? (login['uris'] as Body[]) : [];
    return asString(uris[0]?.['uri']);
  }
  return asString(login[field]);
}

/**
What `GET /object/{field}/{id}` reveals; the TOTP code is fixed because the seed is not real.
*/
export function secretField(item: FixtureItem, field: string): string | undefined {
  switch (field) {
    case 'notes': {
      return asString(item['notes']);
    }
    case 'totp': {
      return loginField(item, 'totp') === undefined ? undefined : '123456';
    }
    default: {
      return loginField(item, field);
    }
  }
}

export async function readBody(context: { req: { json(): Promise<unknown> } }): Promise<Body> {
  const value = await context.req.json();
  return typeof value === 'object' && value !== null ? (value as Body) : {};
}

export type ItemFilter = (item: FixtureItem) => boolean;

export function itemFilters(query: Record<string, string | undefined>): ItemFilter[] {
  const isWantTrash = query['trash'] === 'true';
  const search = query['search']?.toLowerCase();
  const { folderid, collectionid, organizationid, url } = query;
  const filters: ItemFilter[] = [(item) => (item['deletedDate'] != null) === isWantTrash];
  if (search !== undefined) {
    filters.push((item) => String(item['name']).toLowerCase().includes(search));
  }
  if (folderid !== undefined) {
    filters.push((item) => item['folderId'] === folderid);
  }
  if (collectionid !== undefined) {
    filters.push((item) =>
      ((item['collectionIds'] as string[] | undefined) ?? []).includes(collectionid),
    );
  }
  if (organizationid !== undefined) {
    filters.push((item) => item['organizationId'] === organizationid);
  }
  if (url !== undefined) {
    filters.push((item) =>
      ((nested(item, 'login')['uris'] as Body[] | undefined) ?? []).some(
        (entry) => entry['uri'] === url,
      ),
    );
  }
  return filters;
}
