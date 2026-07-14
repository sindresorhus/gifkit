import {
	asciiTextEncoder,
	disposalMethodNames,
	defaultMaximumDataPayloadByteLength,
	defaultMaximumPixelCount,
} from './constants.js';

const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const typedArrayBufferGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer').get;
const typedArrayByteOffsetGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteOffset').get;
const typedArrayByteLengthGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength').get;
const typedArrayNameGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, Symbol.toStringTag).get;

export function isUint8Array(value) {
	return typedArrayNameGetter.call(value) === 'Uint8Array';
}

export function isUint8ClampedArray(value) {
	return typedArrayNameGetter.call(value) === 'Uint8ClampedArray';
}

export function toUint8ArrayView(value) {
	return new Uint8Array(
		typedArrayBufferGetter.call(value),
		typedArrayByteOffsetGetter.call(value),
		typedArrayByteLengthGetter.call(value),
	);
}

function normalizeByteArray(value, fieldName) {
	const byteLength = value.length;
	const bytes = new Uint8Array(byteLength);

	let index = 0;
	while (index < byteLength) {
		bytes[index] = requireByte(value[index], `${fieldName}[${index}]`);
		index += 1;
	}

	return bytes;
}

export function areBytesEqual(leftBytes, rightBytes) {
	if (leftBytes.length !== rightBytes.length) {
		return false;
	}

	let index = 0;
	while (index < leftBytes.length) {
		if (leftBytes[index] !== rightBytes[index]) {
			return false;
		}

		index += 1;
	}

	return true;
}

function isPowerOfTwo(value) {
	return (value & (value - 1)) === 0;
}

export function requireIntegerInRange(value, minimum, maximum, fieldName) {
	if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
		throw new Error(`${fieldName} must be an integer between ${minimum} and ${maximum}, got ${value}`);
	}

	return value;
}

export function requireFiniteNumberInRange(value, minimum, maximum, fieldName) {
	if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
		throw new Error(`${fieldName} must be a number between ${minimum} and ${maximum}, got ${value}`);
	}

	return value;
}

export function requirePositiveFiniteNumber(value, fieldName) {
	if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
		throw new Error(`${fieldName} must be a number greater than 0, got ${value}`);
	}

	return value;
}

export function requireByte(value, fieldName) {
	return requireIntegerInRange(value, 0, 255, fieldName);
}

export function requireUnsigned16(value, fieldName) {
	return requireIntegerInRange(value, 0, 65_535, fieldName);
}

export function requireNonZeroUnsigned16(value, fieldName) {
	return requireIntegerInRange(value, 1, 65_535, fieldName);
}

export function requirePixelCountWithinLimit(width, height, maximumPixelCount, description) {
	const pixelCount = width * height;
	requirePixelCountValueWithinLimit(pixelCount, maximumPixelCount, description);
	return pixelCount;
}

export function requirePixelCountValueWithinLimit(pixelCount, maximumPixelCount, description) {
	if (pixelCount > maximumPixelCount) {
		throw new Error(`${description} has ${pixelCount} pixels, which exceeds the limit of ${maximumPixelCount}`);
	}
}

export function requireCountWithinLimit(count, maximumCount, description) {
	if (count > maximumCount) {
		throw new Error(`${description} ${count} exceeds the limit of ${maximumCount}`);
	}
}

export function requireByteLengthWithinLimit(byteLength, maximumByteLength, description) {
	if (byteLength > maximumByteLength) {
		throw new Error(`${description} has ${byteLength} bytes, which exceeds the limit of ${maximumByteLength}`);
	}
}

export function requireBlockObject(block) {
	if (!block || typeof block !== 'object') {
		throw new TypeError('Each block must be an object');
	}
}

export function normalizeColorTable(value, fieldName) {
	if (value === undefined) {
		return undefined;
	}

	if (isUint8Array(value)) {
		const bytes = toUint8ArrayView(value);
		validateColorTableBytes(bytes, fieldName);
		return bytes;
	}

	if (Array.isArray(value)) {
		const flatBytes = normalizeColorTableArray(value, fieldName);
		validateColorTableBytes(flatBytes, fieldName);
		return flatBytes;
	}

	throw new TypeError(`${fieldName} must be undefined, a Uint8Array, a flat byte array, or an array of RGB triplets`);
}

function normalizeColorTableArray(value, fieldName) {
	const colorTableLength = value.length;
	if (colorTableLength === 0) {
		throw new Error(`${fieldName} cannot be empty`);
	}

	if (colorTableLength > 768) {
		throw new Error(`${fieldName} cannot contain more than 768 flat bytes or 256 RGB triplets`);
	}

	const flatEntryCount = colorTableLength / 3;

	const canBeFlatByteArray = colorTableLength % 3 === 0
		&& flatEntryCount >= 2
		&& flatEntryCount <= 256
		&& isPowerOfTwo(flatEntryCount);

	const canBeTripletArray = colorTableLength >= 2
		&& colorTableLength <= 256
		&& isPowerOfTwo(colorTableLength);

	const firstElementDescriptor = canBeTripletArray && !canBeFlatByteArray
		? Object.getOwnPropertyDescriptor(value, 0)
		: undefined;

	const isTripletArray = firstElementDescriptor !== undefined
		&& 'value' in firstElementDescriptor
		&& Array.isArray(firstElementDescriptor.value);

	if (isTripletArray) {
		const flatArray = [];
		let paletteIndex = 0;
		while (paletteIndex < colorTableLength) {
			const element = value[paletteIndex];
			const triplet = normalizeSingleColorTriplet(element, `${fieldName}[${paletteIndex}]`);
			flatArray.push(triplet[0], triplet[1], triplet[2]);
			paletteIndex += 1;
		}

		return Uint8Array.from(flatArray);
	}

	if (!canBeFlatByteArray) {
		validateColorTableEntryCountFromFlatLength(colorTableLength, fieldName);
	}

	return normalizeByteArray(value, fieldName);
}

function validateColorTableBytes(flatBytes, fieldName) {
	if (flatBytes.length % 3 !== 0) {
		throw new Error(`${fieldName} length must be divisible by 3`);
	}

	const entryCount = flatBytes.length / 3;
	if (entryCount < 2 || entryCount > 256) {
		throw new Error(`${fieldName} must contain between 2 and 256 entries, got ${entryCount}`);
	}

	if (!isPowerOfTwo(entryCount)) {
		throw new Error(`${fieldName} must contain a power-of-two number of entries, got ${entryCount}`);
	}
}

function validateColorTableEntryCountFromFlatLength(byteLength, fieldName) {
	if (byteLength % 3 !== 0) {
		throw new Error(`${fieldName} length must be divisible by 3`);
	}

	const entryCount = byteLength / 3;
	if (entryCount < 2 || entryCount > 256) {
		throw new Error(`${fieldName} must contain between 2 and 256 entries, got ${entryCount}`);
	}

	throw new Error(`${fieldName} must contain a power-of-two number of entries, got ${entryCount}`);
}

export function normalizeSingleColorTriplet(value, fieldName) {
	if (!Array.isArray(value) || value.length !== 3) {
		throw new TypeError(`${fieldName} must be an array of exactly 3 bytes`);
	}

	return [
		requireByte(value[0], `${fieldName}[0]`),
		requireByte(value[1], `${fieldName}[1]`),
		requireByte(value[2], `${fieldName}[2]`),
	];
}

export function padColorTableToPowerOfTwo(colorTable) {
	const entryCount = colorTable.length / 3;
	if (entryCount === 0) {
		throw new Error('Color table must contain at least one entry');
	}

	let paddedEntryCount = 2;
	while (paddedEntryCount < entryCount) {
		paddedEntryCount *= 2;
	}

	if (paddedEntryCount > 256) {
		throw new Error('Color table cannot exceed 256 entries');
	}

	if (paddedEntryCount === entryCount) {
		return colorTable;
	}

	const paddedColorTable = new Uint8Array(paddedEntryCount * 3);
	paddedColorTable.set(colorTable);
	const lastTripletOffset = Math.max(0, colorTable.length - 3);
	for (let offset = colorTable.length; offset < paddedColorTable.length; offset += 3) {
		paddedColorTable[offset] = colorTable[lastTripletOffset];
		paddedColorTable[offset + 1] = colorTable[lastTripletOffset + 1];
		paddedColorTable[offset + 2] = colorTable[lastTripletOffset + 2];
	}

	return paddedColorTable;
}

export function calculateColorTableSizeField(colorTableEntryCount) {
	if (!Number.isSafeInteger(colorTableEntryCount) || colorTableEntryCount < 2 || colorTableEntryCount > 256) {
		throw new Error(`Color table must contain between 2 and 256 entries, got ${colorTableEntryCount}`);
	}

	if ((colorTableEntryCount & (colorTableEntryCount - 1)) !== 0) {
		throw new Error(`Color table entry count must be a power of two, got ${colorTableEntryCount}`);
	}

	return Math.round(Math.log2(colorTableEntryCount)) - 1;
}

export function deriveColorResolution(globalColorTable) {
	if (globalColorTable === undefined) {
		return 8;
	}

	const entryCount = globalColorTable.length / 3;
	return Math.max(1, Math.ceil(Math.log2(entryCount)));
}

export function deriveMinimumCodeSize(colorTableEntryCount) {
	const clampedEntryCount = Math.max(2, colorTableEntryCount);
	return Math.max(2, Math.ceil(Math.log2(clampedEntryCount)));
}

export function normalizeIndexedPixels(value, expectedLength, fieldName) {
	if (value === undefined) {
		return undefined;
	}

	let indexedPixels;
	if (isUint8Array(value)) {
		indexedPixels = toUint8ArrayView(value);
	} else if (Array.isArray(value)) {
		if (value.length !== expectedLength) {
			throw new Error(`${fieldName} length must be ${expectedLength}, got ${value.length}`);
		}

		indexedPixels = normalizeByteArray(value, fieldName);
	} else {
		throw new TypeError(`${fieldName} must be a Uint8Array or array of bytes`);
	}

	if (indexedPixels.length !== expectedLength) {
		throw new Error(`${fieldName} length must be ${expectedLength}, got ${indexedPixels.length}`);
	}

	return indexedPixels;
}

export function normalizeRedGreenBlueAlphaPixels(value, expectedLength, fieldName) {
	let pixels;
	if (isUint8Array(value) || isUint8ClampedArray(value)) {
		pixels = toUint8ArrayView(value);
	} else if (Array.isArray(value)) {
		if (value.length !== expectedLength) {
			throw new Error(`${fieldName} length must be ${expectedLength}, got ${value.length}`);
		}

		pixels = Uint8ClampedArray.from(normalizeByteArray(value, fieldName));
	} else {
		throw new TypeError(`${fieldName} must be a Uint8Array, Uint8ClampedArray, or array of bytes`);
	}

	if (pixels.length !== expectedLength) {
		throw new Error(`${fieldName} length must be ${expectedLength}, got ${pixels.length}`);
	}

	return pixels;
}

export function normalizeExtensionPayload(value, fieldName) {
	if (typeof value === 'string') {
		return normalizeAsciiPayloadString(value, fieldName);
	}

	if (isUint8Array(value)) {
		const bytes = toUint8ArrayView(value);
		requireByteLengthWithinLimit(bytes.length, defaultMaximumDataPayloadByteLength, fieldName);
		return bytes;
	}

	if (Array.isArray(value)) {
		requireByteLengthWithinLimit(value.length, defaultMaximumDataPayloadByteLength, fieldName);
		return normalizeByteArray(value, fieldName);
	}

	throw new TypeError(`${fieldName} must be a string, Uint8Array, or array of bytes`);
}

function normalizeAsciiPayloadString(value, fieldName) {
	requireByteLengthWithinLimit(value.length, defaultMaximumDataPayloadByteLength, fieldName);
	const bytes = new Uint8Array(value.length);
	for (let index = 0; index < value.length; index += 1) {
		const codeUnit = value.codePointAt(index);
		if (codeUnit > 0x7F) {
			throw new Error(`${fieldName} must contain only ASCII characters`);
		}

		bytes[index] = codeUnit;
	}

	return bytes;
}

export function normalizeFixedAsciiField(value, expectedLength, fieldName) {
	if (typeof value !== 'string') {
		throw new TypeError(`${fieldName} must be a string`);
	}

	if (value.length !== expectedLength) {
		throw new Error(`${fieldName} must be exactly ${expectedLength} ASCII bytes long`);
	}

	const encodedValue = asciiTextEncoder.encode(value);
	if (encodedValue.length !== expectedLength) {
		throw new Error(`${fieldName} must be exactly ${expectedLength} ASCII bytes long`);
	}

	for (const byte of encodedValue) {
		if (byte < 0x20 || byte > 0x7E) {
			throw new Error(`${fieldName} must contain only printable ASCII characters`);
		}
	}

	return value;
}

export function normalizeFixedByteField(value, expectedLength, fieldName) {
	if (typeof value === 'string') {
		if (value.length !== expectedLength) {
			throw new Error(`${fieldName} must be exactly ${expectedLength} bytes long`);
		}

		const encodedValue = asciiTextEncoder.encode(value);
		if (encodedValue.length !== expectedLength) {
			throw new Error(`${fieldName} must be exactly ${expectedLength} bytes long`);
		}

		return encodedValue;
	}

	if (isUint8Array(value)) {
		const bytes = toUint8ArrayView(value);
		if (bytes.length !== expectedLength) {
			throw new Error(`${fieldName} must be exactly ${expectedLength} bytes long`);
		}

		return bytes;
	}

	if (Array.isArray(value)) {
		if (value.length !== expectedLength) {
			throw new Error(`${fieldName} must be exactly ${expectedLength} bytes long`);
		}

		return normalizeByteArray(value, fieldName);
	}

	throw new TypeError(`${fieldName} must be a string, Uint8Array, or array of bytes`);
}

export function normalizeImageGeometry(block, {logicalScreenWidth, logicalScreenHeight}) {
	const left = requireUnsigned16(block.left ?? 0, 'image.left');
	const top = requireUnsigned16(block.top ?? 0, 'image.top');
	const width = requireNonZeroUnsigned16(block.width, 'image.width');
	const height = requireNonZeroUnsigned16(block.height, 'image.height');
	if (left + width > logicalScreenWidth || top + height > logicalScreenHeight) {
		throw new Error('Image block extends beyond the logical screen bounds');
	}

	requirePixelCountWithinLimit(width, height, defaultMaximumPixelCount, 'image block');

	return {
		left,
		top,
		width,
		height,
	};
}

function secondsToHundredthsOfASecond(seconds, fieldName) {
	const value = requireFiniteNumberInRange(seconds, 0, 655.35, fieldName);
	return requireUnsigned16(Math.round(value * 100), `${fieldName} in hundredths of a second`);
}

export function normalizeGraphicControlExtension(graphicControlExtension) {
	if (graphicControlExtension === undefined) {
		return undefined;
	}

	if (typeof graphicControlExtension !== 'object' || graphicControlExtension === null) {
		throw new TypeError('graphicControlExtension must be an object or undefined');
	}

	return {
		disposalMethod: normalizeDisposalMethod(graphicControlExtension.disposalMethod ?? 'unspecified'),
		delayInHundredthsOfASecond: secondsToHundredthsOfASecond(graphicControlExtension.delay ?? 0, 'graphicControlExtension.delay'),
		transparentColorIndex: graphicControlExtension.transparentColorIndex === undefined
			? undefined
			: requireByte(graphicControlExtension.transparentColorIndex, 'graphicControlExtension.transparentColorIndex'),
	};
}

function normalizeDisposalMethod(disposalMethod) {
	if (!disposalMethodNames.includes(disposalMethod)) {
		throw new Error(`graphicControlExtension.disposalMethod must be one of ${disposalMethodNames.map(value => JSON.stringify(value)).join(', ')}, got ${JSON.stringify(disposalMethod)}`);
	}

	return disposalMethod;
}

export function disposalMethodByte(disposalMethod) {
	return disposalMethodNames.indexOf(disposalMethod);
}
