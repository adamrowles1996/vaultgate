// Fast local feedback on staged files only. CI is the authoritative gate.
export default {
  '*.ts': ['eslint --fix --max-warnings=0', 'prettier --write', 'cspell --no-must-find-files'],
  '*.{mjs,js}': [
    'eslint --fix --max-warnings=0',
    'prettier --write',
    'cspell --no-must-find-files',
  ],
  '*.md': ['markdownlint-cli2 --fix', 'prettier --write', 'cspell --no-must-find-files'],
  '*.sh': ['shellcheck', 'shfmt --diff --indent 2 --case-indent'],
  '.github/workflows/*.yml': ['actionlint'],
  '*.{json,jsonc,yml,yaml}': ['prettier --write'],
  'package.json': ['sort-package-json'],
};
