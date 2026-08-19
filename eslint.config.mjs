import js from '@eslint/js';
import perfectionist from 'eslint-plugin-perfectionist';
import prettierRecommended from 'eslint-plugin-prettier/recommended';
import ts from 'typescript-eslint';

export default ts.config(
    js.configs.recommended,
    ...ts.configs.recommended,
    perfectionist.configs['recommended-alphabetical'],
    prettierRecommended,
    {
        rules: {
            'prettier/prettier': 'warn',
        },
    },
    {
        ignores: ['**/node_modules/**'],
    },
);
