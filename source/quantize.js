import {defaultMaximumIndexedImagePixelCount} from './constants.js';
import {
	isUint8Array,
	isUint8ClampedArray,
	toUint8ArrayView,
	requirePixelCountValueWithinLimit,
	normalizeSingleColorTriplet,
	padColorTableToPowerOfTwo,
} from './validate.js';

export function indexedImage(pixels, options = {}) {
	const {
		transparentColor = [0, 0, 0],
	} = options;

	if (!isUint8Array(pixels) && !isUint8ClampedArray(pixels)) {
		throw new TypeError('Expected pixels to be a Uint8Array or Uint8ClampedArray');
	}

	const redGreenBlueAlphaBytes = toUint8ArrayView(pixels);
	if (redGreenBlueAlphaBytes.length % 4 !== 0) {
		throw new Error('pixels length must be divisible by 4');
	}

	requirePixelCountValueWithinLimit(redGreenBlueAlphaBytes.length / 4, defaultMaximumIndexedImagePixelCount, 'pixels');
	const [transparentRed, transparentGreen, transparentBlue] = normalizeSingleColorTriplet(transparentColor, 'transparentColor');
	const paletteLookup = new Map();
	const palette = [];
	const indexedPixels = new Uint8Array(redGreenBlueAlphaBytes.length / 4);
	let transparentColorIndex;

	for (let pixelOffset = 0, pixelIndex = 0; pixelOffset < redGreenBlueAlphaBytes.length; pixelOffset += 4, pixelIndex += 1) {
		const red = redGreenBlueAlphaBytes[pixelOffset];
		const green = redGreenBlueAlphaBytes[pixelOffset + 1];
		const blue = redGreenBlueAlphaBytes[pixelOffset + 2];
		const alpha = redGreenBlueAlphaBytes[pixelOffset + 3];

		if (alpha !== 0 && alpha !== 255) {
			throw new Error(`Pixel ${pixelIndex} has alpha ${alpha}; GIF only supports fully transparent or fully opaque pixels`);
		}

		// All fully transparent pixels share one palette entry, kept separate from any opaque pixel even when its RGB bytes match the transparent color.
		if (alpha === 0) {
			if (transparentColorIndex === undefined) {
				transparentColorIndex = palette.length / 3;
				palette.push(transparentRed, transparentGreen, transparentBlue);
			}

			indexedPixels[pixelIndex] = transparentColorIndex;
			continue;
		}

		const lookupKey = `${red},${green},${blue}`;
		let paletteIndex = paletteLookup.get(lookupKey);
		if (paletteIndex === undefined) {
			paletteIndex = palette.length / 3;

			if (paletteIndex >= 256) {
				throw new Error('The image uses more than 256 palette entries');
			}

			palette.push(red, green, blue);
			paletteLookup.set(lookupKey, paletteIndex);
		}

		indexedPixels[pixelIndex] = paletteIndex;
	}

	const colorTable = padColorTableToPowerOfTwo(Uint8Array.from(palette));

	return {
		pixels: indexedPixels,
		colorTable,
		transparentColorIndex,
	};
}

export function normalizeRGBAImageData(pixels, block, graphicControlExtension) {
	const indexedImageData = indexedImage(pixels, {
		transparentColor: block.transparentColor ?? [0, 0, 0],
	});

	const normalizedGraphicControlExtension = indexedImageData.transparentColorIndex !== undefined || graphicControlExtension !== undefined
		? {
			disposalMethod: graphicControlExtension?.disposalMethod ?? 'unspecified',
			delayInHundredthsOfASecond: graphicControlExtension?.delayInHundredthsOfASecond ?? 0,
			transparentColorIndex: indexedImageData.transparentColorIndex,
		}
		: undefined;

	return {
		indexedPixels: indexedImageData.pixels,
		colorTable: indexedImageData.colorTable,
		graphicControlExtension: normalizedGraphicControlExtension,
	};
}

export function buildQuantizedIndexedImage(pixels, {quality}) {
	const redGreenBlueAlphaBytes = toUint8ArrayView(pixels);
	requirePixelCountValueWithinLimit(redGreenBlueAlphaBytes.length / 4, defaultMaximumIndexedImagePixelCount, 'pixels');
	const hasTransparency = hasTransparentPixels(redGreenBlueAlphaBytes);
	const colorBits = quantizationBitsForQuality(quality, hasTransparency ? 255 : 256);
	const paletteLookup = new Map();
	const palette = [];
	const indexedPixels = new Uint8Array(redGreenBlueAlphaBytes.length / 4);
	let transparentColorIndex;

	for (let pixelOffset = 0, pixelIndex = 0; pixelOffset < redGreenBlueAlphaBytes.length; pixelOffset += 4, pixelIndex += 1) {
		const red = redGreenBlueAlphaBytes[pixelOffset];
		const green = redGreenBlueAlphaBytes[pixelOffset + 1];
		const blue = redGreenBlueAlphaBytes[pixelOffset + 2];
		const alpha = redGreenBlueAlphaBytes[pixelOffset + 3];

		if (alpha === 0) {
			if (transparentColorIndex === undefined) {
				transparentColorIndex = palette.length / 3;
				palette.push(0, 0, 0);
			}

			indexedPixels[pixelIndex] = transparentColorIndex;
			continue;
		}

		const quantizedRed = quantizeColorChannel(red, colorBits.red);
		const quantizedGreen = quantizeColorChannel(green, colorBits.green);
		const quantizedBlue = quantizeColorChannel(blue, colorBits.blue);
		const lookupKey = `${quantizedRed},${quantizedGreen},${quantizedBlue}`;

		let paletteIndex = paletteLookup.get(lookupKey);
		if (paletteIndex === undefined) {
			paletteIndex = palette.length / 3;
			palette.push(quantizedRed, quantizedGreen, quantizedBlue);
			paletteLookup.set(lookupKey, paletteIndex);
		}

		indexedPixels[pixelIndex] = paletteIndex;
	}

	return {
		pixels: indexedPixels,
		colorTable: padColorTableToPowerOfTwo(Uint8Array.from(palette)),
		transparentColorIndex,
	};
}

function hasTransparentPixels(redGreenBlueAlphaBytes) {
	for (let offset = 3; offset < redGreenBlueAlphaBytes.length; offset += 4) {
		if (redGreenBlueAlphaBytes[offset] === 0) {
			return true;
		}
	}

	return false;
}

function quantizationBitsForQuality(quality, maximumColorCount) {
	const targetColorCount = Math.max(2, Math.min(maximumColorCount, Math.round(2 + (quality * (maximumColorCount - 2)))));
	let bitCount = Math.floor(Math.log2(targetColorCount));
	const bits = [0, 0, 0];
	let channelIndex = 0;
	while (bitCount > 0) {
		bits[channelIndex] += 1;
		channelIndex = (channelIndex + 1) % bits.length;
		bitCount -= 1;
	}

	return {
		red: bits[0],
		green: bits[1],
		blue: bits[2],
	};
}

function quantizeColorChannel(value, bitCount) {
	if (bitCount >= 8) {
		return value;
	}

	if (bitCount === 0) {
		return 0;
	}

	const maximumValue = (1 << bitCount) - 1;
	return Math.round(Math.round(value * maximumValue / 255) * 255 / maximumValue);
}
