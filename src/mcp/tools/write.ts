/**
 * `vault:write` tools. Passwords are set either by asking vaultgate to generate
 * one (the agent never sees it) or explicitly, which additionally needs
 * `vault:reveal` (spec §06.2); no tool deletes permanently.
 */
import { z } from 'zod';

import { fail, ok, type Result } from '../../result.ts';

import {
  defineTool,
  type Tool,
  ToolError,
  type ToolFailure,
  type ToolRun,
  WRITE,
} from './definition.ts';
import { DEFAULT_PASSWORD_LENGTH } from './generate.ts';
import { folderSchema, itemIdSchema, itemSummarySchema, toItemSummaryOutput } from './schemas.ts';

import type { ItemPatch, NewItem, NewLoginFields, VaultClient } from '../../vault/client.ts';

const passwordInputs = {
  password: z
    .string()
    .min(1)
    .optional()
    .describe('An explicit password; requires the vault:reveal scope as well as vault:write.'),
  generate_password: z
    .boolean()
    .default(false)
    .describe('Have vaultgate generate a strong password and store it without returning it.'),
};

interface PasswordChoice {
  readonly password?: string | undefined;
  readonly generate_password: boolean;
}

async function resolvePassword(
  vault: VaultClient,
  choice: PasswordChoice,
): Promise<Result<string | undefined, ToolFailure>> {
  if (choice.password !== undefined && choice.generate_password) {
    return fail(
      new ToolError('conflicting_arguments', 'give password or generate_password, not both'),
    );
  }
  if (!choice.generate_password) {
    return ok(choice.password);
  }
  return vault.generatePassword({
    length: DEFAULT_PASSWORD_LENGTH,
    uppercase: true,
    lowercase: true,
    numbers: true,
    special: true,
  });
}

interface LoginInputs {
  readonly username?: string | undefined;
  readonly uris?: readonly string[] | undefined;
}

function loginFields(input: LoginInputs, password: string | undefined): NewLoginFields {
  return {
    ...(input.username !== undefined && { username: input.username }),
    ...(input.uris !== undefined && { uris: input.uris }),
    ...(password !== undefined && { password }),
  };
}

const itemOutput = z.strictObject({ item: itemSummarySchema });

const newItemInput = z.strictObject({
  type: z.enum(['login', 'secureNote']),
  name: z.string().min(1),
  folder_id: z.string().optional(),
  notes: z.string().optional(),
  favorite: z.boolean().default(false),
  username: z.string().optional(),
  uris: z.array(z.string()).optional(),
  ...passwordInputs,
});

const runCreateItem: ToolRun<typeof newItemInput, typeof itemOutput> = async (vault, input) => {
  const password = await resolvePassword(vault, input);
  if (!password.ok) {
    return password;
  }
  const item: NewItem = {
    type: input.type,
    name: input.name,
    favorite: input.favorite,
    ...(input.folder_id !== undefined && { folderId: input.folder_id }),
    ...(input.notes !== undefined && { notes: input.notes }),
    ...(input.type === 'login' && { login: loginFields(input, password.value) }),
  };
  const result = await vault.createItem(item);
  return result.ok ? ok({ item: toItemSummaryOutput(result.value) }) : result;
};

export const toolCreateItem: Tool = defineTool({
  name: 'create_item',
  description:
    'Creates a login or a secure note and returns its summary (id, name, type, folder; never the ' +
    'password or notes). For a login, set generate_password: true to have a strong password ' +
    'generated and stored without it ever being returned; an explicit password also needs the ' +
    'vault:reveal scope. Use list_folders for a folder_id.',
  annotations: { ...WRITE, title: 'Create item' },
  inputSchema: newItemInput,
  outputSchema: itemOutput,
  run: runCreateItem,
});

const updateInput = z.strictObject({
  item_id: itemIdSchema,
  name: z.string().min(1).optional(),
  username: z.string().optional(),
  uris: z.array(z.string()).optional(),
  notes: z.string().optional(),
  folder_id: z.string().nullable().optional(),
  favorite: z.boolean().optional(),
  ...passwordInputs,
});

const runUpdateItem: ToolRun<typeof updateInput, typeof itemOutput> = async (vault, input) => {
  const password = await resolvePassword(vault, input);
  if (!password.ok) {
    return password;
  }
  const login = loginFields(input, password.value);
  const patch: ItemPatch = {
    ...(input.name !== undefined && { name: input.name }),
    ...(input.notes !== undefined && { notes: input.notes }),
    ...(input.folder_id !== undefined && { folderId: input.folder_id }),
    ...(input.favorite !== undefined && { favorite: input.favorite }),
    ...(Object.keys(login).length > 0 && { login }),
  };
  const result = await vault.updateItem(input.item_id, patch);
  return result.ok ? ok({ item: toItemSummaryOutput(result.value) }) : result;
};

export const toolUpdateItem: Tool = defineTool({
  name: 'update_item',
  description:
    'Partially updates one item: name, username, URIs, notes, folder (null to clear), favourite ' +
    'flag and password. Only the fields given change. Set generate_password: true to rotate the ' +
    'password to a new generated one without seeing it; an explicit password also needs ' +
    'vault:reveal. Returns the updated summary, never secret values.',
  annotations: { ...WRITE, title: 'Update item' },
  inputSchema: updateInput,
  outputSchema: itemOutput,
  auditReference: (input) => ({ itemId: input.item_id }),
  run: runUpdateItem,
});

const trashInput = z.strictObject({ item_id: itemIdSchema });
const trashOutput = z.strictObject({ item_id: z.string(), trashed: z.literal(true) });

const runTrashItem: ToolRun<typeof trashInput, typeof trashOutput> = async (vault, input) => {
  const result = await vault.trashItem(input.item_id);
  return result.ok ? ok({ item_id: input.item_id, trashed: true as const }) : result;
};

export const toolTrashItem: Tool = defineTool({
  name: 'trash_item',
  description:
    'Moves one item to the trash (a soft delete the operator can undo in Bitwarden). There is no ' +
    'permanent delete. Returns the item id and confirmation.',
  annotations: { ...WRITE, destructiveHint: true, idempotentHint: true, title: 'Trash item' },
  inputSchema: trashInput,
  outputSchema: trashOutput,
  auditReference: (input) => ({ itemId: input.item_id }),
  run: runTrashItem,
});

const folderInput = z.strictObject({ name: z.string().min(1) });
const folderOutput = z.strictObject({ folder: folderSchema });

const runCreateFolder: ToolRun<typeof folderInput, typeof folderOutput> = async (vault, input) => {
  const result = await vault.createFolder(input.name);
  return result.ok ? ok({ folder: { id: result.value.id, name: result.value.name } }) : result;
};

export const toolCreateFolder: Tool = defineTool({
  name: 'create_folder',
  description:
    'Creates a folder and returns its id and name. Use list_folders to check for an existing one first.',
  annotations: { ...WRITE, title: 'Create folder' },
  inputSchema: folderInput,
  outputSchema: folderOutput,
  run: runCreateFolder,
});
