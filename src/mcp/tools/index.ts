import { toolGeneratePassphrase, toolGeneratePassword } from './generate.ts';
import {
  toolGetItem,
  toolListCollections,
  toolListFolders,
  toolSearchItems,
  toolVaultStatus,
} from './read.ts';
import { toolGetSecret } from './reveal.ts';
import { toolCreateFolder, toolCreateItem, toolTrashItem, toolUpdateItem } from './write.ts';

import type { Tool } from './definition.ts';

/**
Every tool in spec §06.2, in the table's order.
*/
export const ALL_TOOLS: readonly Tool[] = [
  toolVaultStatus,
  toolSearchItems,
  toolGetItem,
  toolListFolders,
  toolListCollections,
  toolGetSecret,
  toolGeneratePassword,
  toolGeneratePassphrase,
  toolCreateItem,
  toolUpdateItem,
  toolTrashItem,
  toolCreateFolder,
];
