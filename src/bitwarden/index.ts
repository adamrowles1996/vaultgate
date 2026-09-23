/**
The vault backend's public surface: the composition layer imports only this.
*/
export { createVaultConnection } from './connection.ts';
export { createVaultSettings } from './settings.ts';
export { startVaultSupervisor } from './supervisor.ts';
export type { VaultSupervisor } from './supervisor.ts';
