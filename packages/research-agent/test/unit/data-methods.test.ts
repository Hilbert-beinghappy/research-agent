// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { parseCsv } from "../../src/tools/analysis.ts";
import { segmentParagraphs } from "../../src/tools/qualitative.ts";

describe("deterministic data and material parsers", () => {
	it("parses quoted CSV fields and rejects malformed row widths", () => {
		expect(parseCsv('id,note,value\r\n1,"public, service",3\r\n2,"said ""yes""",4\r\n')).toEqual({
			headers: ["id", "note", "value"],
			rows: [
				["1", "public, service", "3"],
				["2", 'said "yes"', "4"],
			],
		});
		expect(() => parseCsv("id,value\n1\n")).toThrow("row 2");
		expect(() => parseCsv("id,id\n1,2\n")).toThrow("unique");
	});

	it("creates stable half-open paragraph locators", () => {
		const text = "  First response.  \n\nSecond response.\ncontinued.\n\n\tThird response.\t";
		const segments = segmentParagraphs(text);
		expect(segments.map(({ text: segment }) => segment)).toEqual([
			"First response.",
			"Second response.\ncontinued.",
			"Third response.",
		]);
		for (const segment of segments) {
			expect(text.slice(segment.charStart, segment.charEnd)).toBe(segment.text);
		}
	});
});
