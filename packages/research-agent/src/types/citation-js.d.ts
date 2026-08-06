// SPDX-License-Identifier: Apache-2.0

declare module "@citation-js/core" {
	interface InputOptions {
		forceType: string;
		generateGraph: boolean;
		strict?: boolean;
	}

	export const plugins: {
		input: {
			chain(input: unknown, options: InputOptions): unknown[];
		};
		output: {
			format(name: string, data: unknown, ...options: unknown[]): unknown;
		};
		list(): string[];
	};
}

declare module "@citation-js/plugin-bibtex";
declare module "@citation-js/plugin-ris";
