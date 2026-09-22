/**
The vault backend's public surface: the composition layer imports only this.
*/
export { startVaultSupervisor } from './supervisor.ts';
export type { VaultSupervisor } from './supervisor.ts';
