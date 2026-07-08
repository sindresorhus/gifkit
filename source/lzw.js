export function decodeCompressedIndexStream(compressedData, minimumCodeSize, expectedPixelCount, {strict, colorTableEntryCount}) {
	const clearCode = 1 << minimumCodeSize;
	const endOfInformationCode = clearCode + 1;

	const context = {
		compressedData,
		clearCode,
		endOfInformationCode,
		minimumCodeSize,
		prefixCodes: new Int16Array(4096),
		suffixBytes: new Uint8Array(4096),
		outputStack: new Uint8Array(4097),
		decodedPixels: new Uint8Array(expectedPixelCount),
		codeSize: minimumCodeSize + 1,
		nextAvailableCode: clearCode + 2,
		bitBuffer: 0,
		bitCount: 0,
		dataOffset: 0,
		previousCode: -1,
		outputOffset: 0,
		firstByteOfCurrentString: 0,
		currentStackLength: 0,
		currentFirstByte: 0,
		colorTableEntryCount,
		hasReadAnyCode: false,
	};

	resetLzwDictionary(context);

	while (true) {
		const currentCode = readNextLzwCode(context);
		validateFirstLzwCode(context, currentCode, {strict});

		if (currentCode === context.clearCode) {
			resetLzwDictionary(context);
			continue;
		}

		if (currentCode === context.endOfInformationCode) {
			validateNoUnusedCompressedData(context, {strict});
			break;
		}

		expandLzwCode(context, currentCode);
		copyLzwStackToPixels(context, expectedPixelCount);
		addLzwDictionaryEntry(context);
		context.previousCode = currentCode;
	}

	if (context.outputOffset !== expectedPixelCount) {
		throw new Error(`Expected ${expectedPixelCount} pixel indices, decoded ${context.outputOffset}`);
	}

	return context.decodedPixels;
}

function resetLzwDictionary(context) {
	for (let index = 0; index < context.clearCode; index += 1) {
		context.prefixCodes[index] = -1;
		context.suffixBytes[index] = index;
	}

	context.codeSize = context.minimumCodeSize + 1;
	context.nextAvailableCode = context.clearCode + 2;
	context.previousCode = -1;
}

function readNextLzwCode(context) {
	while (context.bitCount < context.codeSize) {
		if (context.dataOffset >= context.compressedData.length) {
			throw new Error('Unexpected end of compressed image data before End of Information code');
		}

		context.bitBuffer |= context.compressedData[context.dataOffset] << context.bitCount;
		context.bitCount += 8;
		context.dataOffset += 1;
	}

	const currentCode = context.bitBuffer & ((1 << context.codeSize) - 1);
	context.bitBuffer >>= context.codeSize;
	context.bitCount -= context.codeSize;
	return currentCode;
}

function validateFirstLzwCode(context, currentCode, {strict}) {
	if (context.hasReadAnyCode) {
		return;
	}

	context.hasReadAnyCode = true;

	if (strict && currentCode !== context.clearCode) {
		throw new Error('LZW image data must start with a Clear code');
	}
}

function validateNoUnusedCompressedData(context, {strict}) {
	if (strict && context.dataOffset < context.compressedData.length) {
		throw new Error('Found unused compressed image data after the End of Information code');
	}
}

function expandLzwCode(context, currentCode) {
	if (currentCode > context.nextAvailableCode) {
		throw new Error(`Encountered invalid compressed code ${currentCode}`);
	}

	let stackLength = 0;
	let codeToExpand = currentCode;
	if (currentCode === context.nextAvailableCode) {
		if (context.previousCode === -1) {
			throw new Error('Encountered a dictionary-reference code before any previous code existed');
		}

		// GIF LZW's KwKwK case references the entry being created from the previous code plus its own first byte.
		context.outputStack[stackLength] = context.firstByteOfCurrentString;
		stackLength += 1;
		codeToExpand = context.previousCode;
	}

	while (codeToExpand > context.clearCode + 1) {
		context.outputStack[stackLength] = context.suffixBytes[codeToExpand];
		stackLength += 1;
		codeToExpand = context.prefixCodes[codeToExpand];

		if (stackLength >= context.outputStack.length) {
			throw new Error('Compressed code expansion overflowed the output stack');
		}
	}

	const firstByte = context.suffixBytes[codeToExpand];
	context.outputStack[stackLength] = firstByte;
	stackLength += 1;
	context.firstByteOfCurrentString = firstByte;
	context.currentStackLength = stackLength;
	context.currentFirstByte = firstByte;
}

function copyLzwStackToPixels(context, expectedPixelCount) {
	for (let stackIndex = context.currentStackLength - 1; stackIndex >= 0; stackIndex -= 1) {
		if (context.outputOffset >= expectedPixelCount) {
			throw new Error('Decompressed more pixels than the image dimensions allow');
		}

		const pixelIndex = context.outputStack[stackIndex];

		// Validate decoded palette indexes while copying LZW output so strict mode does not need a second full image pass.
		if (context.colorTableEntryCount !== undefined && pixelIndex >= context.colorTableEntryCount) {
			throw new Error(`Pixel ${context.outputOffset} uses palette index ${pixelIndex}, but the active color table only has ${context.colorTableEntryCount} entries`);
		}

		context.decodedPixels[context.outputOffset] = pixelIndex;
		context.outputOffset += 1;
	}
}

function addLzwDictionaryEntry(context) {
	if (context.previousCode === -1 || context.nextAvailableCode >= 4096) {
		return;
	}

	context.prefixCodes[context.nextAvailableCode] = context.previousCode;
	context.suffixBytes[context.nextAvailableCode] = context.currentFirstByte;
	context.nextAvailableCode += 1;
	if (context.nextAvailableCode === (1 << context.codeSize) && context.codeSize < 12) {
		context.codeSize += 1;
	}
}

export function encodeCompressedIndexStream(indexedPixels, minimumCodeSize) {
	const clearCode = 1 << minimumCodeSize;
	const endOfInformationCode = clearCode + 1;
	const codeSequence = [clearCode];

	if (indexedPixels.length === 0) {
		codeSequence.push(endOfInformationCode);
		return packCompressedCodeSequence(codeSequence, minimumCodeSize);
	}

	// Small GIFs should not pay for the dense 2 MiB lookup table; larger images usually make up that cost by avoiding Map hashing in the LZW hot path.
	if (indexedPixels.length < 4096) {
		return encodeCompressedIndexStreamWithMap(indexedPixels, minimumCodeSize);
	}

	return encodeCompressedIndexStreamWithDenseLookup(indexedPixels, minimumCodeSize);
}

function encodeCompressedIndexStreamWithMap(indexedPixels, minimumCodeSize) {
	const clearCode = 1 << minimumCodeSize;
	const endOfInformationCode = clearCode + 1;
	let nextAvailableCode = clearCode + 2;
	const codeLookup = new Map();
	const codeSequence = [clearCode];

	function resetDictionary() {
		codeLookup.clear();
		nextAvailableCode = clearCode + 2;
	}

	let currentCode = indexedPixels[0];
	for (let index = 1; index < indexedPixels.length; index += 1) {
		const nextPixelIndex = indexedPixels[index];
		const dictionaryKey = (currentCode << 8) | nextPixelIndex;

		const combinedCode = codeLookup.get(dictionaryKey);
		if (combinedCode !== undefined) {
			currentCode = combinedCode;
			continue;
		}

		codeSequence.push(currentCode);

		if (nextAvailableCode < 4096) {
			codeLookup.set(dictionaryKey, nextAvailableCode);
			nextAvailableCode += 1;
		} else {
			codeSequence.push(clearCode);
			resetDictionary();
		}

		currentCode = nextPixelIndex;
	}

	codeSequence.push(currentCode, endOfInformationCode);
	return packCompressedCodeSequence(codeSequence, minimumCodeSize);
}

function encodeCompressedIndexStreamWithDenseLookup(indexedPixels, minimumCodeSize) {
	const clearCode = 1 << minimumCodeSize;
	const endOfInformationCode = clearCode + 1;
	let nextAvailableCode = clearCode + 2;
	const codeLookup = new Uint16Array(4096 * 256);
	const touchedDictionaryKeys = new Uint32Array(4096);
	let touchedDictionaryKeyCount = 0;
	const codeSequence = [clearCode];

	function resetDictionary() {
		for (let index = 0; index < touchedDictionaryKeyCount; index += 1) {
			codeLookup[touchedDictionaryKeys[index]] = 0;
		}

		touchedDictionaryKeyCount = 0;
		nextAvailableCode = clearCode + 2;
	}

	let currentCode = indexedPixels[0];
	for (let index = 1; index < indexedPixels.length; index += 1) {
		const nextPixelIndex = indexedPixels[index];
		const dictionaryKey = (currentCode << 8) | nextPixelIndex;
		const combinedCode = codeLookup[dictionaryKey];
		if (combinedCode !== 0) {
			currentCode = combinedCode;
			continue;
		}

		codeSequence.push(currentCode);

		if (nextAvailableCode < 4096) {
			codeLookup[dictionaryKey] = nextAvailableCode;
			touchedDictionaryKeys[touchedDictionaryKeyCount] = dictionaryKey;
			touchedDictionaryKeyCount += 1;
			nextAvailableCode += 1;
		} else {
			codeSequence.push(clearCode);
			resetDictionary();
		}

		currentCode = nextPixelIndex;
	}

	codeSequence.push(currentCode, endOfInformationCode);
	return packCompressedCodeSequence(codeSequence, minimumCodeSize);
}

function packCompressedCodeSequence(codeSequence, minimumCodeSize) {
	const clearCode = 1 << minimumCodeSize;
	const endOfInformationCode = clearCode + 1;
	let codeSize = minimumCodeSize + 1;
	let nextAvailableCode = clearCode + 2;
	let previousCode;
	let bitBuffer = 0;
	let bitCount = 0;
	const packedBytes = [];

	for (const code of codeSequence) {
		bitBuffer |= code << bitCount;
		bitCount += codeSize;

		while (bitCount >= 8) {
			packedBytes.push(bitBuffer & 0xFF);
			bitBuffer >>= 8;
			bitCount -= 8;
		}

		if (code === clearCode) {
			codeSize = minimumCodeSize + 1;
			nextAvailableCode = clearCode + 2;
			previousCode = undefined;
			continue;
		}

		if (code === endOfInformationCode) {
			break;
		}

		if (previousCode !== undefined && nextAvailableCode < 4096) {
			nextAvailableCode += 1;

			if (nextAvailableCode === (1 << codeSize) && codeSize < 12) {
				codeSize += 1;
			}
		}

		previousCode = code;
	}

	if (bitCount > 0) {
		packedBytes.push(bitBuffer & 0xFF);
	}

	return Uint8Array.from(packedBytes);
}
