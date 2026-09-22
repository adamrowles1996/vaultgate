// Fast local feedback on staged files only. CI is the authoritative gate.
export default {
  '*.ts': ['eslint --fix --max-warnings=0', 'prettier --write'],
  '*.{mjs,js}': ['eslint --fix --max-warnings=0', 'prettier --write'],
  '*.{json,md,yml,yaml}': ['prettier --write'],
};
