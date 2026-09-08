import eslint from "@eslint/js";
import typescriptEslint from "typescript-eslint";

export default [
	{
		ignores: ["coverage/**", "dist/**", "node_modules/**", "tmp/**"],
	},
	eslint.configs.recommended,
	...typescriptEslint.configs.recommended,
];
