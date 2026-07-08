import {
	extensionIntroducer,
	imageSeparator,
	trailerByte,
	graphicControlExtensionLabel,
	commentExtensionLabel,
	plainTextExtensionLabel,
	appExtensionLabel,
	defaultMaximumPixelCount,
	defaultMaximumBlockCount,
	defaultMaximumDataSubBlockCount,
	defaultMaximumDataPayloadByteLength,
	uint8ArraySubarray,
	disposalMethodNames,
} from './constants.js';
import {requireCountWithinLimit, requireByteLengthWithinLimit, requirePixelCountWithinLimit} from './validate.js';
import {GIFByteReader} from './byte-stream.js';
import {decodeCompressedIndexStream} from './lzw.js';
import {decodeNetscapeLoopCount, isNetscapeLoopingAppExtension} from './loop-count.js';

export function decodeGIF(inputBytes, options = {}) {
	const {
		strict = true,
	} = options;

	const byteReader = new GIFByteReader(inputBytes);
	const header = readGIFHeader(byteReader, {strict});
	const stream = readGIFBlockStream(byteReader, {
		...header,
		strict,
	});

	if (strict && byteReader.offset !== byteReader.length) {
		throw new Error(`Found ${byteReader.length - byteReader.offset} trailing byte(s) after the GIF trailer`);
	}

	return {
		type: 'gif',
		version: header.version,
		width: header.logicalScreenWidth,
		height: header.logicalScreenHeight,
		backgroundColorIndex: header.backgroundColorIndex,
		globalColorTable: header.globalColorTable,
		...(stream.playCount !== undefined && {playCount: stream.playCount}),
		blocks: stream.blocks,
		imageBlocks: stream.imageBlocks,
	};
}

function readGIFHeader(byteReader, {strict}) {
	const signature = byteReader.readAsciiString(3);
	if (signature !== 'GIF') {
		throw new Error(`Expected GIF signature, got ${JSON.stringify(signature)}`);
	}

	const version = byteReader.readAsciiString(3);
	if (version !== '87a' && version !== '89a') {
		throw new Error(`Unsupported GIF version ${JSON.stringify(version)}`);
	}

	const logicalScreenWidth = byteReader.readUnsignedLittleEndian16();
	const logicalScreenHeight = byteReader.readUnsignedLittleEndian16();
	if (strict && (logicalScreenWidth === 0 || logicalScreenHeight === 0)) {
		throw new Error('Logical Screen dimensions must be non-zero in strict mode');
	}

	const packedLogicalScreenField = byteReader.readByte();
	const hasGlobalColorTable = (packedLogicalScreenField & 0b1000_0000) !== 0;
	const globalColorTableSizeField = packedLogicalScreenField & 0b0000_0111;
	const backgroundColorIndex = byteReader.readByte();
	// The GIF pixel-aspect-ratio byte is intentionally ignored. Modern GIFs are square-pixel images and exposing the raw legacy byte is not useful.
	byteReader.readByte();

	const globalColorTable = hasGlobalColorTable
		? readColorTable(byteReader, globalColorTableSizeField)
		: undefined;

	if (
		strict
		&& globalColorTable !== undefined
		&& backgroundColorIndex >= globalColorTable.length / 3
	) {
		throw new Error('Background color index must be inside the global color table in strict mode');
	}

	if (strict && globalColorTable === undefined && backgroundColorIndex !== 0) {
		throw new Error('Background color index must be zero when there is no global color table in strict mode');
	}

	return {
		version,
		logicalScreenWidth,
		logicalScreenHeight,
		backgroundColorIndex,
		globalColorTable,
	};
}

function readGIFBlockStream(byteReader, {version, logicalScreenWidth, logicalScreenHeight, globalColorTable, strict}) {
	const blocks = [];
	const imageBlocks = [];
	let pendingGraphicControlExtension;
	let playCount;
	let blockCount = 0;

	while (true) {
		const nextByte = byteReader.readByte();

		if (nextByte === trailerByte) {
			break;
		}

		blockCount += 1;
		requireCountWithinLimit(blockCount, defaultMaximumBlockCount, 'block count');

		if (nextByte === imageSeparator) {
			const imageBlock = readImageBlock({
				byteReader,
				logicalScreenWidth,
				logicalScreenHeight,
				globalColorTable,
				graphicControlExtension: pendingGraphicControlExtension,
				strict,
			});
			blocks.push(imageBlock);
			imageBlocks.push(imageBlock);
			pendingGraphicControlExtension = undefined;
			continue;
		}

		if (nextByte !== extensionIntroducer) {
			throw new Error(`Unexpected block introducer 0x${nextByte.toString(16).padStart(2, '0')} at byte offset ${byteReader.offset - 1}`);
		}

		const extensionLabel = byteReader.readByte();
		if (strict && version === '87a' && isGIF89aExtensionLabel(extensionLabel)) {
			throw new Error(`GIF87a streams cannot contain extension label 0x${extensionLabel.toString(16).padStart(2, '0')}`);
		}

		switch (extensionLabel) {
			case graphicControlExtensionLabel: {
				if (pendingGraphicControlExtension !== undefined && strict) {
					throw new Error('A second Graphic Control Extension appeared before a graphic rendering block');
				}

				pendingGraphicControlExtension = readGraphicControlExtension(byteReader, {strict});
				break;
			}

			case commentExtensionLabel: {
				const commentBlock = {
					type: 'commentExtension',
					data: readDataSubBlocks(byteReader),
				};
				blocks.push(commentBlock);
				break;
			}

			case plainTextExtensionLabel: {
				blocks.push(readUnknownExtension(byteReader, plainTextExtensionLabel));
				pendingGraphicControlExtension = undefined;
				break;
			}

			case appExtensionLabel: {
				const appBlock = readAppExtension(byteReader, {strict});
				blocks.push(appBlock);
				if (isNetscapeLoopingAppExtension(appBlock)) {
					playCount = decodeNetscapeLoopCount(appBlock.data[1] | (appBlock.data[2] << 8));
					appBlock.isNetscapeLoopingExtension = true;
					appBlock.playCount = playCount;
				}

				break;
			}

			default: {
				const unknownExtensionBlock = version === '87a'
					? readGIF87aUnknownExtension(byteReader, extensionLabel)
					: readUnknownExtension(byteReader, extensionLabel);
				blocks.push(unknownExtensionBlock);
				if (isGraphicRenderingExtensionLabel(extensionLabel)) {
					pendingGraphicControlExtension = undefined;
				}

				break;
			}
		}
	}

	if (pendingGraphicControlExtension !== undefined && strict) {
		throw new Error('A Graphic Control Extension was not followed by a graphic rendering block');
	}

	return {
		playCount,
		blocks,
		imageBlocks,
	};
}

function readImageBlock({byteReader, logicalScreenWidth, logicalScreenHeight, globalColorTable, graphicControlExtension, strict}) {
	const descriptor = readImageDescriptor(byteReader, {
		logicalScreenWidth,
		logicalScreenHeight,
		strict,
	});
	const {
		left,
		top,
		width,
		height,
		hasLocalColorTable,
		isInterlaced,
		colorTableSizeField,
	} = descriptor;
	const colorTable = hasLocalColorTable
		? readColorTable(byteReader, colorTableSizeField)
		: undefined;
	const activeColorTable = colorTable ?? globalColorTable;
	if (strict && activeColorTable === undefined) {
		throw new Error('Image block requires an active color table in strict mode');
	}

	validateTransparentColorIndex(graphicControlExtension, activeColorTable, {strict});

	const minimumCodeSize = byteReader.readByte();
	if (minimumCodeSize < 2 || minimumCodeSize > 8) {
		throw new Error(`Invalid minimum code size ${minimumCodeSize}; GIF requires a value between 2 and 8`);
	}

	const compressedData = readDataSubBlocks(byteReader);
	const expectedPixelCount = width * height;
	const colorTableEntryCount = strict && activeColorTable !== undefined ? activeColorTable.length / 3 : undefined;
	let indexedPixels = decodeCompressedIndexStream(compressedData, minimumCodeSize, expectedPixelCount, {
		strict,
		colorTableEntryCount,
	});
	if (isInterlaced) {
		indexedPixels = deinterlaceIndexedPixels(indexedPixels, width, height);
	}

	return {
		type: 'image',
		graphicControlExtension: graphicControlExtension === undefined ? undefined : {...graphicControlExtension},
		left,
		top,
		width,
		height,
		isInterlaced,
		colorTable,
		minimumCodeSize,
		pixels: indexedPixels,
	};
}

function readImageDescriptor(byteReader, {logicalScreenWidth, logicalScreenHeight, strict}) {
	const left = byteReader.readUnsignedLittleEndian16();
	const top = byteReader.readUnsignedLittleEndian16();
	const width = byteReader.readUnsignedLittleEndian16();
	const height = byteReader.readUnsignedLittleEndian16();

	if (strict && (width === 0 || height === 0)) {
		throw new Error('Image block dimensions must be non-zero in strict mode');
	}

	const packedImageField = byteReader.readByte();
	const hasLocalColorTable = (packedImageField & 0b1000_0000) !== 0;
	const isInterlaced = (packedImageField & 0b0100_0000) !== 0;
	const reservedBits = (packedImageField >> 3) & 0b11;
	if (strict && reservedBits !== 0) {
		throw new Error('Image Descriptor reserved bits must be zero');
	}

	if (left + width > logicalScreenWidth || top + height > logicalScreenHeight) {
		throw new Error('Image block extends beyond the logical screen bounds');
	}

	const colorTableSizeField = packedImageField & 0b0000_0111;

	requirePixelCountWithinLimit(width, height, defaultMaximumPixelCount, 'image block');

	return {
		left,
		top,
		width,
		height,
		hasLocalColorTable,
		isInterlaced,
		colorTableSizeField,
	};
}

function validateTransparentColorIndex(graphicControlExtension, activeColorTable, {strict}) {
	if (
		strict
		&& graphicControlExtension?.transparentColorIndex !== undefined
		&& activeColorTable !== undefined
		&& graphicControlExtension.transparentColorIndex >= activeColorTable.length / 3
	) {
		throw new Error('Transparent color index must be inside the active color table in strict mode');
	}
}

function readGraphicControlExtension(byteReader, {strict}) {
	const blockSize = byteReader.readByte();
	if (blockSize !== 4) {
		throw new Error(`Invalid Graphic Control Extension block size ${blockSize}; expected 4`);
	}

	const packedField = byteReader.readByte();
	const reservedBits = packedField >> 5;
	if (reservedBits !== 0 && strict) {
		throw new Error('Graphic Control Extension reserved bits must be zero');
	}

	const disposalMethodField = (packedField >> 2) & 0b111;
	if (strict && disposalMethodField >= disposalMethodNames.length) {
		throw new Error('Disposal methods 4-7 are reserved in the GIF89a specification');
	}

	// The GIF user-input flag is intentionally ignored because interactive decoder prompts are obsolete and not useful in JS encode/decode workflows.
	const isTransparencyFlag = (packedField & 0b1) !== 0;
	const delayInHundredthsOfASecond = byteReader.readUnsignedLittleEndian16();
	const transparentColorIndex = byteReader.readByte();
	const blockTerminator = byteReader.readByte();
	if (blockTerminator !== 0x00) {
		throw new Error('Graphic Control Extension is missing its block terminator');
	}

	return {
		disposalMethod: disposalMethodNames[disposalMethodField] ?? 'unspecified',
		delay: delayInHundredthsOfASecond / 100,
		transparentColorIndex: isTransparencyFlag ? transparentColorIndex : undefined,
	};
}

function readAppExtension(byteReader, {strict}) {
	const blockSize = byteReader.readByte();
	if (blockSize !== 11) {
		throw new Error(`Invalid Application Extension block size ${blockSize}; expected 11`);
	}

	const identifier = byteReader.readAsciiString(8);

	if (strict && /[^\u{20}-\u{7E}]/v.test(identifier)) {
		throw new Error('Application Identifier must use printable ASCII characters');
	}

	const authenticationCode = byteReader.readBytes(3);
	const data = readDataSubBlocks(byteReader);

	return {
		type: 'applicationExtension',
		identifier,
		authenticationCode,
		data,
	};
}

function isGIF89aExtensionLabel(extensionLabel) {
	return [
		graphicControlExtensionLabel,
		commentExtensionLabel,
		plainTextExtensionLabel,
		appExtensionLabel,
	].includes(extensionLabel);
}

function readUnknownExtension(byteReader, extensionLabel) {
	const fixedBlockSize = byteReader.readByte();
	const fixedData = byteReader.readBytes(fixedBlockSize);
	if (fixedBlockSize === 0) {
		return {
			type: 'unknownExtension',
			extensionLabel,
			fixedData,
			data: new Uint8Array(),
		};
	}

	const data = readDataSubBlocks(byteReader);
	return {
		type: 'unknownExtension',
		extensionLabel,
		fixedData,
		data,
	};
}

function readGIF87aUnknownExtension(byteReader, extensionLabel) {
	return {
		type: 'unknownExtension',
		extensionLabel,
		fixedData: new Uint8Array(),
		data: readDataSubBlocks(byteReader),
	};
}

function isGraphicRenderingExtensionLabel(extensionLabel) {
	// Unknown labels still delimit Graphic Control Extension scope according to the GIF89a label ranges.
	return extensionLabel <= 0x7F && extensionLabel !== trailerByte;
}

function readDataSubBlocks(byteReader) {
	let concatenatedData = new Uint8Array(1024);
	let totalLength = 0;
	let subBlockCount = 0;

	while (true) {
		const blockSize = byteReader.readByte();
		if (blockSize === 0) {
			break;
		}

		subBlockCount += 1;
		requireCountWithinLimit(subBlockCount, defaultMaximumDataSubBlockCount, 'data sub-block count');

		const nextTotalLength = totalLength + blockSize;
		requireByteLengthWithinLimit(nextTotalLength, defaultMaximumDataPayloadByteLength, 'data payload');
		if (nextTotalLength > concatenatedData.length) {
			const nextCapacity = Math.min(defaultMaximumDataPayloadByteLength, Math.max(nextTotalLength, concatenatedData.length * 2));
			const nextConcatenatedData = new Uint8Array(nextCapacity);
			nextConcatenatedData.set(uint8ArraySubarray.call(concatenatedData, 0, totalLength));
			concatenatedData = nextConcatenatedData;
		}

		byteReader.readBytesInto(concatenatedData, totalLength, blockSize);
		totalLength = nextTotalLength;
	}

	return concatenatedData.slice(0, totalLength);
}

function readColorTable(byteReader, sizeField) {
	const entryCount = 1 << (sizeField + 1);
	const byteLength = entryCount * 3;
	return byteReader.readBytes(byteLength);
}

function deinterlaceIndexedPixels(indexedPixels, width, height) {
	const deinterlacedPixels = new Uint8Array(indexedPixels.length);
	let sourceOffset = 0;
	for (const [startRow, rowStep] of [[0, 8], [4, 8], [2, 4], [1, 2]]) {
		for (let row = startRow; row < height; row += rowStep) {
			const destinationOffset = row * width;
			deinterlacedPixels.set(uint8ArraySubarray.call(indexedPixels, sourceOffset, sourceOffset + width), destinationOffset);
			sourceOffset += width;
		}
	}

	return deinterlacedPixels;
}
