import {
	trailerByte,
	extensionIntroducer,
	imageSeparator,
	graphicControlExtensionLabel,
	commentExtensionLabel,
	appExtensionLabel,
	netscapeLoopingAppIdentifier,
	netscapeLoopingAppAuthenticationCodeBytes,
	defaultMaximumBlockCount,
	defaultMaximumPixelCount,
	defaultMaximumIndexedImagePixelCount,
	defaultMaximumEncodeWorkCost,
	defaultMaximumDataPayloadByteLength,
	uint8ArraySubarray,
} from './constants.js';
import {
	isUint8Array,
	toUint8ArrayView,
	requireBlockObject,
	requireByte,
	requireUnsigned16,
	requireNonZeroUnsigned16,
	requirePixelCountWithinLimit,
	requirePixelCountValueWithinLimit,
	requireCountWithinLimit,
	requireByteLengthWithinLimit,
	normalizeColorTable,
	normalizeIndexedPixels,
	normalizeRedGreenBlueAlphaPixels,
	normalizeGraphicControlExtension,
	normalizeExtensionPayload,
	normalizeFixedAsciiField,
	normalizeFixedByteField,
	normalizeImageGeometry,
	areBytesEqual,
	calculateColorTableSizeField,
	deriveColorResolution,
	deriveMinimumCodeSize,
	disposalMethodByte,
} from './validate.js';
import {GIFByteWriter} from './byte-stream.js';
import {encodeCompressedIndexStream} from './lzw.js';
import {
	rejectRenamedLoopCount,
	encodeNetscapeLoopCount,
	encodeExplicitNetscapeLoopCount,
	containsNetscapeLoopingAppExtension,
	createNetscapeLoopingAppExtension,
} from './loop-count.js';
import {normalizeRGBAImageData} from './quantize.js';

export function encodeGIF(gif) {
	const normalizedGif = normalizeGIFForEncoding(gif);
	const byteWriter = new GIFByteWriter();

	byteWriter.writeAsciiString('GIF');
	byteWriter.writeAsciiString(normalizedGif.version);
	writeGIFHeader(byteWriter, normalizedGif);
	writeGIFBlocks(byteWriter, normalizedGif);
	byteWriter.writeByte(trailerByte);
	return byteWriter.toUint8Array();
}

function normalizeGIFForEncoding(gif) {
	if (!gif || typeof gif !== 'object') {
		throw new TypeError('Expected a GIF description object');
	}

	const logicalScreenWidth = requireNonZeroUnsigned16(gif.width, 'width');
	const logicalScreenHeight = requireNonZeroUnsigned16(gif.height, 'height');
	const globalColorTable = normalizeColorTable(gif.globalColorTable, 'globalColorTable');
	const backgroundColorIndex = requireByte(gif.backgroundColorIndex ?? 0, 'backgroundColorIndex');
	rejectRenamedLoopCount(gif);
	if (globalColorTable === undefined && backgroundColorIndex !== 0) {
		throw new Error('Background color index must be zero when there is no global color table');
	}

	if (
		globalColorTable !== undefined
		&& backgroundColorIndex >= globalColorTable.length / 3
	) {
		throw new Error('Background color index must be inside the global color table');
	}

	const loopCount = gif.playCount === undefined || gif.playCount === 1
		? undefined
		: encodeNetscapeLoopCount(gif.playCount, 'playCount');
	const blocks = normalizeBlocksForEncoding(gif, globalColorTable, {
		loopCount,
	});

	return {
		version: '89a',
		logicalScreenWidth,
		logicalScreenHeight,
		backgroundColorIndex,
		globalColorTable,
		blocks,
	};
}

function normalizeBlocksForEncoding(gif, globalColorTable, {loopCount}) {
	if (gif.imageBlocks !== undefined) {
		throw new Error('imageBlocks is not supported when encoding; use blocks');
	}

	let sourceBlocks;

	if (gif.blocks === undefined) {
		sourceBlocks = [];
	} else if (Array.isArray(gif.blocks)) {
		sourceBlocks = gif.blocks;
	} else {
		throw new TypeError('blocks must be an array');
	}

	const sourceBlockCount = sourceBlocks.length;
	requireCountWithinLimit(sourceBlockCount, defaultMaximumBlockCount, 'block count');
	validateEncodeWorkCost(sourceBlocks, sourceBlockCount);
	const blocks = [];
	let index = 0;
	while (index < sourceBlockCount) {
		blocks.push(normalizeBlock(sourceBlocks[index], globalColorTable));
		index += 1;
	}

	if (loopCount === undefined || containsNetscapeLoopingAppExtension(blocks)) {
		requireCountWithinLimit(countEncodedStreamBlocks(blocks), defaultMaximumBlockCount, 'block count');
		return blocks;
	}

	const blocksWithLoopExtension = [
		createNetscapeLoopingAppExtension(loopCount),
		...blocks,
	];
	requireCountWithinLimit(countEncodedStreamBlocks(blocksWithLoopExtension), defaultMaximumBlockCount, 'block count');
	return blocksWithLoopExtension;
}

function countEncodedStreamBlocks(blocks) {
	let blockCount = 0;
	for (const block of blocks) {
		blockCount += 1;

		if (
			block.type === 'image'
			&& (
				block.graphicControlExtension !== undefined
				|| (
					block.indexedPixels === undefined
					&& block.pixels !== undefined
				)
			)
		) {
			blockCount += 1;
		}
	}

	return blockCount;
}

function validateEncodeWorkCost(blocks, blockCount = blocks.length) {
	let workCost = 0;
	let index = 0;
	while (index < blockCount) {
		const block = blocks[index];
		if (!block || typeof block !== 'object') {
			index += 1;
			continue;
		}

		switch (block.type) {
			case 'commentExtension': {
				workCost += getPayloadInputLength(block.data ?? '');
				break;
			}

			case 'applicationExtension': {
				workCost += getPayloadInputLength(block.data ?? new Uint8Array());
				break;
			}

			case 'image':
			case 'rgbaImage': {
				const {width, height} = block;
				if (Number.isSafeInteger(width) && Number.isSafeInteger(height) && width > 0 && height > 0) {
					workCost += width * height;
				}

				break;
			}

			default: {
				break;
			}
		}

		requireCountWithinLimit(workCost, defaultMaximumEncodeWorkCost, 'encode work cost');
		index += 1;
	}

	return workCost;
}

function getPayloadInputLength(value) {
	if (isUint8Array(value)) {
		return toUint8ArrayView(value).length;
	}

	if (typeof value === 'string' || Array.isArray(value)) {
		return value.length;
	}

	return 0;
}

function writeGIFHeader(byteWriter, gif) {
	const {
		logicalScreenWidth,
		logicalScreenHeight,
		backgroundColorIndex,
		globalColorTable,
	} = gif;
	byteWriter.writeUnsignedLittleEndian16(logicalScreenWidth);
	byteWriter.writeUnsignedLittleEndian16(logicalScreenHeight);

	const globalColorTableSizeField = globalColorTable === undefined ? 0 : calculateColorTableSizeField(globalColorTable.length / 3);
	const packedLogicalScreenField
		= (globalColorTable === undefined ? 0 : 0b1000_0000)
			| ((deriveColorResolution(globalColorTable) - 1) << 4)
			| globalColorTableSizeField;

	byteWriter.writeByte(packedLogicalScreenField);
	byteWriter.writeByte(backgroundColorIndex);
	byteWriter.writeByte(0);

	if (globalColorTable !== undefined) {
		writeColorTable(byteWriter, globalColorTable);
	}
}

function writeGIFBlocks(byteWriter, gif) {
	const {
		logicalScreenWidth,
		logicalScreenHeight,
		globalColorTable,
	} = gif;

	for (const block of gif.blocks) {
		switch (block.type) {
			case 'commentExtension': {
				writeCommentExtension(byteWriter, block);
				break;
			}

			case 'applicationExtension': {
				writeAppExtension(byteWriter, block);
				break;
			}

			case 'image': {
				writeImageBlock(byteWriter, block, {
					logicalScreenWidth,
					logicalScreenHeight,
					globalColorTable,
				});
				break;
			}

			default: {
				throw new Error(`Unsupported block type ${JSON.stringify(block.type)}`);
			}
		}
	}
}

function writeImageBlock(byteWriter, block, {logicalScreenWidth, logicalScreenHeight, globalColorTable}) {
	const geometry = normalizeImageGeometry(block, {
		logicalScreenWidth,
		logicalScreenHeight,
	});
	const imageData = normalizeImageDataForEncoding(block, geometry, globalColorTable);

	if (imageData.graphicControlExtension !== undefined) {
		writeGraphicControlExtension(byteWriter, imageData.graphicControlExtension);
	}

	writeEncodedImageBlock(byteWriter, block, {
		...geometry,
		...imageData,
	});
}

function normalizeImageDataForEncoding(block, {width, height}, globalColorTable) {
	let colorTable = normalizeColorTable(block.colorTable, 'image.colorTable');
	let indexedPixels = normalizeIndexedPixels(block.indexedPixels, width * height, 'image.pixels');
	let graphicControlExtension = normalizeGraphicControlExtension(block.graphicControlExtension);

	if (indexedPixels === undefined && block.pixels !== undefined) {
		requirePixelCountValueWithinLimit(width * height, defaultMaximumIndexedImagePixelCount, 'RGBA image data');
		const pixels = normalizeRedGreenBlueAlphaPixels(block.pixels, width * height * 4, 'image.pixels');
		const indexedImageData = normalizeRGBAImageData(pixels, block, graphicControlExtension);
		indexedPixels = indexedImageData.indexedPixels;
		colorTable = indexedImageData.colorTable;
		graphicControlExtension = indexedImageData.graphicControlExtension;
	}

	if (indexedPixels === undefined) {
		throw new Error('An image block requires pixels');
	}

	const activeColorTable = colorTable ?? globalColorTable;
	if (activeColorTable === undefined) {
		throw new Error('An image block requires a colorTable or a globalColorTable');
	}

	validateIndexedPixelsAgainstColorTable(indexedPixels, activeColorTable, graphicControlExtension?.transparentColorIndex);

	let minimumCodeSize = deriveMinimumCodeSize(activeColorTable.length / 3);
	if (minimumCodeSize < 2) {
		minimumCodeSize = 2;
	}

	return {
		colorTable,
		indexedPixels,
		minimumCodeSize,
		graphicControlExtension,
	};
}

function writeEncodedImageBlock(byteWriter, block, {left, top, width, height, colorTable, indexedPixels, minimumCodeSize}) {
	const pixelsToEncode = block.isInterlaced ? interlaceIndexedPixels(indexedPixels, width, height) : indexedPixels;
	const compressedData = encodeCompressedIndexStream(pixelsToEncode, minimumCodeSize);

	byteWriter.writeByte(imageSeparator);
	byteWriter.writeUnsignedLittleEndian16(left);
	byteWriter.writeUnsignedLittleEndian16(top);
	byteWriter.writeUnsignedLittleEndian16(width);
	byteWriter.writeUnsignedLittleEndian16(height);

	const packedImageField
		= (colorTable === undefined ? 0 : 0b1000_0000)
			| (block.isInterlaced ? 0b0100_0000 : 0)
			| (colorTable === undefined ? 0 : calculateColorTableSizeField(colorTable.length / 3));

	byteWriter.writeByte(packedImageField);
	if (colorTable !== undefined) {
		writeColorTable(byteWriter, colorTable);
	}

	byteWriter.writeByte(minimumCodeSize);
	writeDataSubBlocks(byteWriter, compressedData);
}

function writeGraphicControlExtension(byteWriter, graphicControlExtension) {
	if (graphicControlExtension === undefined) {
		return;
	}

	const packedField
		= (disposalMethodByte(graphicControlExtension.disposalMethod) << 2)
			| (graphicControlExtension.transparentColorIndex === undefined ? 0 : 0b1);

	byteWriter.writeByte(extensionIntroducer);
	byteWriter.writeByte(graphicControlExtensionLabel);
	byteWriter.writeByte(4);
	byteWriter.writeByte(packedField);
	byteWriter.writeUnsignedLittleEndian16(graphicControlExtension.delayInHundredthsOfASecond);
	byteWriter.writeByte(graphicControlExtension.transparentColorIndex ?? 0);
	byteWriter.writeByte(0x00);
}

function writeCommentExtension(byteWriter, block) {
	const data = normalizeExtensionPayload(block.data, 'commentExtension.data');
	byteWriter.writeByte(extensionIntroducer);
	byteWriter.writeByte(commentExtensionLabel);
	writeDataSubBlocks(byteWriter, data);
}

function writeAppExtension(byteWriter, block) {
	const identifier = normalizeFixedAsciiField(block.identifier, 8, 'applicationExtension.identifier');
	const authenticationCode = normalizeFixedByteField(block.authenticationCode, 3, 'applicationExtension.authenticationCode');
	const data = normalizeExtensionPayload(block.data, 'applicationExtension.data');

	byteWriter.writeByte(extensionIntroducer);
	byteWriter.writeByte(appExtensionLabel);
	byteWriter.writeByte(11);
	byteWriter.writeAsciiString(identifier);
	byteWriter.writeBytes(authenticationCode);
	writeDataSubBlocks(byteWriter, data);
}

function writeDataSubBlocks(byteWriter, data) {
	requireByteLengthWithinLimit(data.length, defaultMaximumDataPayloadByteLength, 'data payload');

	for (let offset = 0; offset < data.length; offset += 255) {
		const chunkLength = Math.min(255, data.length - offset);
		byteWriter.writeByte(chunkLength);
		byteWriter.writeBytes(uint8ArraySubarray.call(data, offset, offset + chunkLength));
	}

	byteWriter.writeByte(0x00);
}

function writeColorTable(byteWriter, colorTable) {
	const normalizedColorTable = normalizeColorTable(colorTable, 'colorTable');
	if (normalizedColorTable === undefined) {
		throw new Error('Expected a color table');
	}

	byteWriter.writeBytes(normalizedColorTable);
}

function interlaceIndexedPixels(indexedPixels, width, height) {
	const interlacedPixels = new Uint8Array(indexedPixels.length);
	let destinationOffset = 0;
	for (const [startRow, rowStep] of [[0, 8], [4, 8], [2, 4], [1, 2]]) {
		for (let row = startRow; row < height; row += rowStep) {
			const sourceOffset = row * width;
			interlacedPixels.set(uint8ArraySubarray.call(indexedPixels, sourceOffset, sourceOffset + width), destinationOffset);
			destinationOffset += width;
		}
	}

	return interlacedPixels;
}

function validateIndexedPixelsAgainstColorTable(indexedPixels, colorTable, transparentColorIndex) {
	const colorTableEntryCount = colorTable.length / 3;
	let pixelOffset = 0;
	while (pixelOffset < indexedPixels.length) {
		const pixelIndex = indexedPixels[pixelOffset];
		if (pixelIndex >= colorTableEntryCount) {
			throw new Error(`Pixel ${pixelOffset} uses palette index ${pixelIndex}, but the active color table only has ${colorTableEntryCount} entries`);
		}

		pixelOffset += 1;
	}

	if (transparentColorIndex !== undefined && transparentColorIndex >= colorTableEntryCount) {
		throw new Error(`Transparent color index ${transparentColorIndex} exceeds the active color table`);
	}
}

function normalizeBlock(block, globalColorTable) {
	requireBlockObject(block);

	switch (block.type) {
		case 'commentExtension': {
			return normalizeCommentExtensionBlock(block);
		}

		case 'applicationExtension': {
			return normalizeAppExtensionBlock(block);
		}

		case 'image':
		case 'rgbaImage': {
			return normalizeImageBlock(block, globalColorTable);
		}

		default: {
			throw new Error(`Unsupported block type ${JSON.stringify(block.type)}`);
		}
	}
}

function normalizeCommentExtensionBlock(block) {
	return {
		type: 'commentExtension',
		data: normalizeExtensionPayload(block.data ?? '', 'commentExtension.data'),
	};
}

function normalizeAppExtensionBlock(block) {
	const authenticationCode = normalizeFixedByteField(block.authenticationCode, 3, 'applicationExtension.authenticationCode');
	const identifier = normalizeFixedAsciiField(block.identifier, 8, 'applicationExtension.identifier');
	rejectRenamedLoopCount(block);

	const loopCount = block.playCount === undefined
		? undefined
		: encodeExplicitNetscapeLoopCount(block.playCount, 'applicationExtension.playCount');

	const data = block.data ?? (
		identifier === netscapeLoopingAppIdentifier
		&& areBytesEqual(authenticationCode, netscapeLoopingAppAuthenticationCodeBytes)
		&& loopCount !== undefined
			? Uint8Array.of(0x01, loopCount & 0xFF, loopCount >> 8)
			: new Uint8Array()
	);

	return {
		type: 'applicationExtension',
		identifier,
		authenticationCode,
		data: normalizeExtensionPayload(data, 'applicationExtension.data'),
	};
}

function normalizeImageBlock(block, globalColorTable) {
	const isRGBAImage = block.type === 'rgbaImage';
	const width = requireNonZeroUnsigned16(block.width, 'image.width');
	const height = requireNonZeroUnsigned16(block.height, 'image.height');

	requirePixelCountWithinLimit(width, height, defaultMaximumPixelCount, 'image block');

	const colorTable = isRGBAImage ? undefined : normalizeColorTable(block.colorTable, 'image.colorTable');

	const normalizedImageBlock = {
		type: 'image',
		graphicControlExtension: block.graphicControlExtension,
		left: requireUnsigned16(block.left ?? 0, 'image.left'),
		top: requireUnsigned16(block.top ?? 0, 'image.top'),
		width,
		height,
		isInterlaced: Boolean(block.isInterlaced),
		colorTable,
		indexedPixels: isRGBAImage ? undefined : block.pixels,
	};

	if (!isRGBAImage && normalizedImageBlock.colorTable === undefined && globalColorTable === undefined) {
		throw new Error('An image block requires a color table or a global color table');
	}

	if (isRGBAImage) {
		normalizedImageBlock.pixels = block.pixels;

		if (block.transparentColor !== undefined) {
			normalizedImageBlock.transparentColor = block.transparentColor;
		}
	}

	return normalizedImageBlock;
}
