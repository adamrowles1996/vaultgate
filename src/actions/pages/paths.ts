/**
 * Where each page and write of the Actions section lives (ACT-5). One module
 * so a renderer can link to a page without importing it, and so the route
 * templates and the links an operator follows cannot drift apart.
 */
export const CREATE_PATH = '/account/actions';

/**
ACT-63: the unexpected-write view, which belongs to no single target.
*/
export const UNEXPECTED_PATH = `${CREATE_PATH}/unexpected`;

/**
ACT-9: the grant writes of the connected-clients list, where the path names the client.
*/
export const CLIENT_GRANTS_TEMPLATE = `${CREATE_PATH}/clients/:clientId/grants`;
export const CLIENT_GRANT_REVOKE_TEMPLATE = `${CLIENT_GRANTS_TEMPLATE}/revoke`;

export function targetPath(id: string): string {
  return `${CREATE_PATH}/${encodeURIComponent(id)}`;
}

/**
ACT-63: one target's whole call history, paged.
*/
export function callsPath(targetId: string): string {
  return `${targetPath(targetId)}/calls`;
}

export function clientGrantsPath(clientId: string): string {
  return `${CREATE_PATH}/clients/${encodeURIComponent(clientId)}/grants`;
}

export function clientGrantRevokePath(clientId: string): string {
  return `${clientGrantsPath(clientId)}/revoke`;
}
