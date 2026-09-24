/**
 * The address a computer takes from its vault item (ACT-1, ACT-2): the
 * item's login addresses and text fields, none of them secret, offered next
 * to the destination's address field and copied into it when the target is
 * saved. Copied, not linked: the saved destination is what ACT-3 resolves
 * and checks and what every confirmation binds to, and a later change to the
 * item does not move the computer. A host field takes a host (and its port,
 * when the address carries one); a URL field takes an http:// or https://
 * URL as it stands.
 */
import { fieldName, type FormValues } from './form-values.ts';

import type { ConnectorForm, FieldDescriptor } from './descriptors.ts';
import type { ItemSummary } from '../../vault/client.ts';

export const ADDRESS_FROM_FIELD = 'address_from';

export interface AddressCandidate {
  readonly value: string;
  /**
  Where in the item it is: `address 1` for the first login address, `field <name>` for a text field.
  */
  readonly source: string;
}

type AddressKind = NonNullable<(FieldDescriptor & { readonly kind: 'text' })['address']>;

interface HostAndPort {
  readonly host: string;
  readonly port?: string;
}

/**
A bare host, an IPv4 address or a bracketed IPv6 one, with an optional port.
*/
const HOST_PORT = /^(?<host>[\w.-]+|\[[\d.:a-f]+\])(?::(?<port>\d{1,5}))?$/iu;

function withoutBrackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

/**
 * The host (and port) an address names: a URL's host, or `host[:port]` as
 * written. `db.example.com:1433` parses as a URL whose scheme is the host
 * name and which has no host, so the URL reading is kept only when it has one.
 */
export function hostAndPort(text: string): HostAndPort | undefined {
  const url = URL.parse(text);
  if (url !== null && url.hostname !== '') {
    return { host: withoutBrackets(url.hostname), ...(url.port !== '' && { port: url.port }) };
  }
  const groups = HOST_PORT.exec(text)?.groups;
  if (groups?.['host'] === undefined) {
    return undefined;
  }
  const { port } = groups;
  return { host: withoutBrackets(groups['host']), ...(port !== undefined && { port }) };
}

function isWebUrl(text: string): boolean {
  const url = URL.parse(text);
  return url !== null && url.hostname !== '' && ['http:', 'https:'].includes(url.protocol);
}

/**
Whether a field of this kind can take the address.
*/
export function canTakeAddress(kind: AddressKind, value: string): boolean {
  return kind === 'url' ? isWebUrl(value) : hostAndPort(value) !== undefined;
}

/**
The item's login addresses, then its text fields, each value once, in the vault's order.
*/
export function addressCandidates(item: ItemSummary): readonly AddressCandidate[] {
  const uris = (item.login?.uris ?? []).map((value, index) => ({
    value: value.trim(),
    source: `address ${String(index + 1)}`,
  }));
  const texts = item.customFields
    .filter((field) => field.kind === 'text')
    .map((field) => ({ value: (field.value ?? '').trim(), source: `field ${field.name}` }));
  const seen = new Set<string>();
  return [...uris, ...texts].filter((candidate) => {
    const isNew = candidate.value !== '' && !seen.has(candidate.value);
    seen.add(candidate.value);
    return isNew;
  });
}

type AddressField = FieldDescriptor & { readonly kind: 'text'; readonly address: AddressKind };

export function addressField(form: ConnectorForm): AddressField | undefined {
  for (const field of form.fields) {
    if (field.kind === 'text' && field.address !== undefined) {
      return { ...field, address: field.address };
    }
  }
  return undefined;
}

function isPortField(field: FieldDescriptor): boolean {
  return field.document === 'destination' && field.name === 'port';
}

export interface AppliedAddress {
  readonly values: FormValues;
  readonly problems: readonly string[];
}

/**
What copying one address did: the address the field now holds with every value written, or why not.
*/
type Copy =
  | { readonly ok: true; readonly address: string; readonly values: FormValues }
  | { readonly ok: false; readonly problem: string };

function copyUrl(field: AddressField, chosen: string): Copy {
  return isWebUrl(chosen)
    ? { ok: true, address: chosen, values: new Map([[fieldName(field), chosen]]) }
    : {
        ok: false,
        problem: `${fieldName(field)}: the vault item's address "${chosen}" is not an http:// or https:// URL`,
      };
}

function copyHost(form: ConnectorForm, field: AddressField, chosen: string): Copy {
  const parsed = hostAndPort(chosen);
  if (parsed === undefined) {
    return {
      ok: false,
      problem: `${fieldName(field)}: the vault item's address "${chosen}" names no host`,
    };
  }
  const copied = new Map([[fieldName(field), parsed.host]]);
  for (const candidate of form.fields) {
    if (parsed.port !== undefined && isPortField(candidate)) {
      copied.set(fieldName(candidate), parsed.port);
    }
  }
  return { ok: true, address: parsed.host, values: copied };
}

/**
 * The submitted values with the chosen address copied in (ACT-2), or the
 * problem that stops the save. A choice that fits no address of its field
 * comes only from a hand-made request, which is told why. An address typed
 * into the field that differs from the one chosen is the operator saying two
 * things at once, so neither is taken silently: the save asks them to keep
 * one. The same address in both is what a re-shown form carries after its
 * first save failed for another reason, and is no conflict.
 */
export function applyAddress(form: ConnectorForm, values: FormValues): AppliedAddress {
  const chosen = (values.get(ADDRESS_FROM_FIELD) ?? '').trim();
  const field = addressField(form);
  if (chosen === '' || field === undefined) {
    return { values, problems: [] };
  }
  const copy = field.address === 'url' ? copyUrl(field, chosen) : copyHost(form, field, chosen);
  if (!copy.ok) {
    return { values, problems: [copy.problem] };
  }
  const typed = (values.get(fieldName(field)) ?? '').trim();
  return typed === '' || typed === copy.address
    ? { values: new Map([...values, ...copy.values]), problems: [] }
    : {
        values,
        problems: [
          `${fieldName(field)}: an address is typed here and another is taken from the vault item; keep one of them`,
        ],
      };
}
