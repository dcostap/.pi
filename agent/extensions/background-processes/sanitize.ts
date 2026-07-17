/** Remove terminal control sequences and unsafe controls from untrusted process output. */
export function sanitizeTerminalText(input: string): string {
	let output = "";
	const length = input.length;

	const consumeCsi = (start: number): number => {
		let index = start;
		while (index < length) {
			const code = input.charCodeAt(index++);
			if (code >= 0x40 && code <= 0x7e) break;
		}
		return index;
	};

	const consumeControlString = (start: number, allowBel: boolean): number => {
		let index = start;
		while (index < length) {
			const code = input.charCodeAt(index);
			if (allowBel && code === 0x07) return index + 1;
			if (code === 0x9c) return index + 1;
			if (code === 0x1b && input.charCodeAt(index + 1) === 0x5c) return index + 2;
			index++;
		}
		return index;
	};

	for (let index = 0; index < length; ) {
		const code = input.charCodeAt(index);
		if (code === 0x1b) {
			const next = input.charCodeAt(index + 1);
			if (next === 0x5b) index = consumeCsi(index + 2);
			else if (next === 0x5d) index = consumeControlString(index + 2, true);
			else if (next === 0x50 || next === 0x58 || next === 0x5e || next === 0x5f) {
				index = consumeControlString(index + 2, false);
			} else {
				index += 2;
				while (index < length) {
					const intermediate = input.charCodeAt(index);
					if (intermediate < 0x20 || intermediate > 0x2f) break;
					index++;
				}
				if (index < length) {
					const final = input.charCodeAt(index);
					if (final >= 0x30 && final <= 0x7e) index++;
				}
			}
			continue;
		}
		if (code === 0x9b) {
			index = consumeCsi(index + 1);
			continue;
		}
		if (code === 0x9d) {
			index = consumeControlString(index + 1, true);
			continue;
		}
		if (code === 0x90 || code === 0x98 || code === 0x9e || code === 0x9f) {
			index = consumeControlString(index + 1, false);
			continue;
		}
		if (code === 0x0a) {
			output += "\n";
			index++;
			continue;
		}
		if (code === 0x09) {
			output += "  ";
			index++;
			continue;
		}
		if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
			index++;
			continue;
		}
		output += input[index++];
	}

	return output;
}
