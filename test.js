import assert from 'node:assert/strict';
import {Buffer} from 'node:buffer';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import vm from 'node:vm';
import {test} from 'node:test';
import {Jimp} from 'jimp';
import {temporaryDirectory} from 'tempy';
import {
	indexedImage as createIndexedImage,
	decodeAnimatedGIF,
	decodeGIF,
	encodeAnimatedGIF,
	encodeGIF,
	renderGIFFrameSequence,
	renderGIFFrames,
} from './index.js';

const generatedFixtureDirectory = temporaryDirectory({prefix: 'gifkit'});
const fixtureDirectory = 'fixtures';
const hasPillow = (() => {
	try {
		execFileSync('python3', ['-c', 'import PIL'], {stdio: 'ignore'});
		return true;
	} catch {
		return false;
	}
})();
const hasImageMagick = (() => {
	try {
		execFileSync('magick', ['-version'], {stdio: 'ignore'});
		return true;
	} catch {
		return false;
	}
})();

const gifSignature = [0x47, 0x49, 0x46];
const gif87aVersion = [0x38, 0x37, 0x61];
const gif89aVersion = [0x38, 0x39, 0x61];
const blackWhiteGlobalColorTable = rgbColorTable([0, 0, 0], [255, 255, 255]);
const blackRedGreenBlueGlobalColorTable = rgbColorTable([0, 0, 0], [255, 0, 0], [0, 255, 0], [0, 0, 255]);
const onePixelIndexZeroImageData = [
	0x02,
	0x02,
	0x44,
	0x01,
	0x00,
];

function bytes(...values) {
	return Uint8Array.from(values);
}

function asciiBytes(string) {
	return [...string].map(character => character.codePointAt(0));
}

function rgbColorTable(...colors) {
	return colors.flat();
}

function logicalScreenBytes({
	width = 1,
	height = 1,
	packedField = 0x80,
	backgroundColorIndex = 0,
	pixelAspectRatio = 0,
} = {}) {
	return [
		width & 0xFF,
		width >> 8,
		height & 0xFF,
		height >> 8,
		packedField,
		backgroundColorIndex,
		pixelAspectRatio,
	];
}

function minimalGifBytes({
	version = gif89aVersion,
	width = 1,
	height = 1,
	packedField = 0x80,
	backgroundColorIndex = 0,
	pixelAspectRatio = 0,
	globalColorTable = blackWhiteGlobalColorTable,
	beforeImage = [],
	imageDescriptorPackedField = 0,
	colorTable = [],
	imageData = onePixelIndexZeroImageData,
	trailingBytes = [],
} = {}) {
	return bytes(
		...gifSignature,
		...version,
		...logicalScreenBytes({
			width,
			height,
			packedField,
			backgroundColorIndex,
			pixelAspectRatio,
		}),
		...globalColorTable,
		...beforeImage,
		0x2C,
		0x00,
		0x00,
		0x00,
		0x00,
		width & 0xFF,
		width >> 8,
		height & 0xFF,
		height >> 8,
		imageDescriptorPackedField,
		...colorTable,
		...imageData,
		0x3B,
		...trailingBytes,
	);
}

function graphicControlExtensionBytes({
	packedField = 0,
	delayTime = 0,
	transparentColorIndex = 0,
	blockTerminator = 0,
} = {}) {
	return [
		0x21,
		0xF9,
		0x04,
		packedField,
		delayTime & 0xFF,
		delayTime >> 8,
		transparentColorIndex,
		blockTerminator,
	];
}

function commentExtensionBytes(data) {
	return [
		0x21,
		0xFE,
		...dataSubBlocks(data),
	];
}

function appExtensionBytes({identifier, authenticationCode, data}) {
	const authenticationCodeBytes = typeof authenticationCode === 'string'
		? asciiBytes(authenticationCode)
		: authenticationCode;
	return [
		0x21,
		0xFF,
		0x0B,
		...asciiBytes(identifier),
		...authenticationCodeBytes,
		...dataSubBlocks(data),
	];
}

function plainTextExtensionBytes(data, {
	textForegroundColorIndex = 1,
	textBackgroundColorIndex = 0,
} = {}) {
	return [
		0x21,
		0x01,
		0x0C,
		0x01,
		0x00,
		0x02,
		0x00,
		0x03,
		0x00,
		0x04,
		0x00,
		0x08,
		0x10,
		textForegroundColorIndex,
		textBackgroundColorIndex,
		...dataSubBlocks(data),
	];
}

function dataSubBlocks(data, chunkSize = 255) {
	const result = [];
	for (let offset = 0; offset < data.length; offset += chunkSize) {
		const chunk = data.slice(offset, offset + chunkSize);
		result.push(chunk.length, ...chunk);
	}

	result.push(0);
	return result;
}

function packLzwCodeSequence(codeSequence, minimumCodeSize) {
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

	return packedBytes;
}

function imageDataFromLzwCodes({minimumCodeSize = 2, codeSequence}) {
	return [
		minimumCodeSize,
		...dataSubBlocks(packLzwCodeSequence(codeSequence, minimumCodeSize)),
	];
}

function extractFirstImageData(gifBytes) {
	let offset = 6;
	const logicalScreenPackedField = gifBytes[offset + 4];
	offset += 7;

	if ((logicalScreenPackedField & 0x80) !== 0) {
		offset += 3 * (1 << ((logicalScreenPackedField & 0b111) + 1));
	}

	if (gifBytes[offset] !== 0x2C) {
		throw new Error(`Expected first image descriptor at byte offset ${offset}`);
	}

	offset += 9;
	const imagePackedField = gifBytes[offset];
	offset += 1;

	if ((imagePackedField & 0x80) !== 0) {
		offset += 3 * (1 << ((imagePackedField & 0b111) + 1));
	}

	const minimumCodeSize = gifBytes[offset];
	offset += 1;

	const compressedData = [];
	while (true) {
		const blockSize = gifBytes[offset];
		offset += 1;
		if (blockSize === 0) {
			break;
		}

		compressedData.push(...gifBytes.subarray(offset, offset + blockSize));
		offset += blockSize;
	}

	return {
		minimumCodeSize,
		compressedData: Uint8Array.from(compressedData),
	};
}

function countLzwClearCodes({minimumCodeSize, compressedData}) {
	const clearCode = 1 << minimumCodeSize;
	const endOfInformationCode = clearCode + 1;
	let codeSize = minimumCodeSize + 1;
	let nextAvailableCode = clearCode + 2;
	let previousCode;
	let bitBuffer = 0;
	let bitCount = 0;
	let offset = 0;
	let clearCodeCount = 0;

	while (true) {
		while (bitCount < codeSize && offset < compressedData.length) {
			bitBuffer |= compressedData[offset] << bitCount;
			bitCount += 8;
			offset += 1;
		}

		if (bitCount < codeSize) {
			break;
		}

		const code = bitBuffer & ((1 << codeSize) - 1);
		bitBuffer >>= codeSize;
		bitCount -= codeSize;

		if (code === clearCode) {
			clearCodeCount += 1;
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

	return clearCodeCount;
}

function grayscaleColorTable() {
	return Uint8Array.from({length: 256 * 3}, (_, index) => Math.floor(index / 3));
}

function indexedPixelsToGrayscaleRedGreenBlueAlphaPixels(indexedPixels) {
	const pixels = [];
	for (const pixel of indexedPixels) {
		pixels.push(pixel, pixel, pixel, 255);
	}

	return pixels;
}

function createSeededRandom(seed) {
	let state = seed >>> 0;

	return () => {
		state = ((state * 1_664_525) + 1_013_904_223) >>> 0;
		return state / 0x1_00_00_00_00;
	};
}

function createRandomIndexedPixels({width, height, colorCount, seed}) {
	const random = createSeededRandom(seed);
	return Uint8Array.from({length: width * height}, () => Math.floor(random() * colorCount));
}

function colorTableWithEntryCount(entryCount) {
	const colorTable = new Uint8Array(entryCount * 3);
	for (let index = 0; index < entryCount; index += 1) {
		const offset = index * 3;
		colorTable[offset] = (index * 47) % 256;
		colorTable[offset + 1] = ((index * 97) + 31) % 256;
		colorTable[offset + 2] = ((index * 193) + 17) % 256;
	}

	return colorTable;
}

function indexedPixelsToRedGreenBlueAlphaPixels(indexedPixels, colorTable) {
	const pixels = [];
	for (const pixel of indexedPixels) {
		const colorOffset = pixel * 3;
		pixels.push(
			colorTable[colorOffset],
			colorTable[colorOffset + 1],
			colorTable[colorOffset + 2],
			255,
		);
	}

	return pixels;
}

function extractRedGreenBluePixels(pixels) {
	const redGreenBluePixels = [];
	for (let index = 0; index < pixels.length; index += 4) {
		redGreenBluePixels.push(
			pixels[index],
			pixels[index + 1],
			pixels[index + 2],
		);
	}

	return redGreenBluePixels;
}

function getTopLevelGIFBlocks(gifBytes) {
	function skipDataSubBlocks(offset) {
		while (true) {
			if (offset >= gifBytes.length) {
				throw new Error('Unexpected end of GIF data sub-blocks');
			}

			const blockSize = gifBytes[offset];
			offset += 1;
			if (blockSize === 0) {
				return offset;
			}

			offset += blockSize;
		}
	}

	const blocks = [];
	let offset = 6;
	const logicalScreenPackedField = gifBytes[offset + 4];
	offset += 7;

	if ((logicalScreenPackedField & 0x80) !== 0) {
		offset += 3 * (1 << ((logicalScreenPackedField & 0b111) + 1));
	}

	while (offset < gifBytes.length) {
		const blockIntroducer = gifBytes[offset];
		offset += 1;

		if (blockIntroducer === 0x3B) {
			blocks.push({kind: 'trailer'});
			break;
		}

		if (blockIntroducer === 0x2C) {
			blocks.push({
				kind: 'image',
				imageDescriptorPacket: [...gifBytes.slice(offset - 1, offset + 9)],
			});
			offset += 8;
			const imagePackedField = gifBytes[offset];
			offset += 1;

			if ((imagePackedField & 0x80) !== 0) {
				offset += 3 * (1 << ((imagePackedField & 0b111) + 1));
			}

			offset += 1;
			offset = skipDataSubBlocks(offset);
			continue;
		}

		if (blockIntroducer !== 0x21) {
			throw new Error(`Unexpected GIF block introducer ${blockIntroducer}`);
		}

		const extensionLabel = gifBytes[offset];
		offset += 1;

		if (extensionLabel === 0xF9) {
			blocks.push({
				kind: 'graphicControlExtension',
				graphicControlExtensionPacket: [...gifBytes.slice(offset - 2, offset + 6)],
			});
			offset += 6;
			continue;
		}

		if (extensionLabel === 0x01) {
			blocks.push({kind: 'plainTextExtension'});
			offset += 13;
			offset = skipDataSubBlocks(offset);
			continue;
		}

		if (extensionLabel === 0xFE) {
			blocks.push({kind: 'commentExtension'});
			offset = skipDataSubBlocks(offset);
			continue;
		}

		if (extensionLabel === 0xFF) {
			blocks.push({kind: 'applicationExtension'});
			offset += 12;
			offset = skipDataSubBlocks(offset);
			continue;
		}

		blocks.push({kind: 'unknownExtension'});
		const fixedBlockSize = gifBytes[offset];
		offset += 1 + fixedBlockSize;
		offset = skipDataSubBlocks(offset);
	}

	return blocks;
}

function extractGraphicControlExtensionPackets(gifBytes) {
	return getTopLevelGIFBlocks(gifBytes)
		.flatMap(block => block.graphicControlExtensionPacket === undefined ? [] : [block.graphicControlExtensionPacket]);
}

function countGraphicControlExtensionBlocks(gifBytes) {
	return extractGraphicControlExtensionPackets(gifBytes).length;
}

function getTopLevelGIFBlockKinds(gifBytes) {
	return getTopLevelGIFBlocks(gifBytes).map(block => block.kind);
}

function findByteSequence(gifBytes, sequence) {
	for (let offset = 0; offset <= gifBytes.length - sequence.length; offset += 1) {
		let isMatches = true;
		for (const [index, byte] of sequence.entries()) {
			if (gifBytes[offset + index] !== byte) {
				isMatches = false;
				break;
			}
		}

		if (isMatches) {
			return offset;
		}
	}

	return -1;
}

function redGreenBlueAlphaPixelBytes(...pixels) {
	return pixels.flat();
}

function writeFile(fileName, fileBytes) {
	const filePath = path.join(generatedFixtureDirectory, fileName);
	fs.writeFileSync(filePath, fileBytes);
	return filePath;
}

function readFixture(fileName) {
	return fs.readFileSync(path.join(fixtureDirectory, fileName));
}

function readGifWithPillow(filePath) {
	const pythonProgram = `
import json
import sys
from PIL import Image, ImageSequence

image = Image.open(sys.argv[1])
frames = []
for frame in ImageSequence.Iterator(image):
	frames.append(list(frame.convert('RGBA').tobytes()))
output = {
	'size': list(image.size),
	'loop': image.info.get('loop'),
	'frames': frames,
}
print(json.dumps(output))
`;
	return JSON.parse(execFileSync('python3', ['-c', pythonProgram, filePath], {encoding: 'utf8'}));
}

function readGifWithImageMagick(filePath, {width, height}) {
	const frameByteLength = width * height * 4;
	const output = execFileSync('magick', [
		filePath,
		'-coalesce',
		'-depth',
		'8',
		'rgba:-',
	]);

	if (output.length % frameByteLength !== 0) {
		throw new Error(`ImageMagick returned ${output.length} byte(s), which is not divisible by the expected ${frameByteLength} bytes per frame`);
	}

	const frames = [];
	for (let offset = 0; offset < output.length; offset += frameByteLength) {
		frames.push([...output.subarray(offset, offset + frameByteLength)]);
	}

	return frames;
}

function createGifWithPillow(filePath) {
	const pythonProgram = `
from PIL import Image

frame1 = Image.new('P', (3, 2), 1)
frame1.putpalette([
	0, 0, 0,
	255, 0, 0,
	0, 255, 0,
	0, 0, 255,
] + [0, 0, 0] * 252)

frame2 = Image.new('P', (3, 2), 0)
frame2.putpalette(frame1.getpalette())
frame2.putdata([
	0, 3, 0,
	0, 0, 0,
])
frame2.info['transparency'] = 0
frame2.info['disposal'] = 2

frame3 = Image.new('P', (3, 2), 0)
frame3.putpalette(frame1.getpalette())
frame3.putdata([
	0, 2, 0,
	0, 0, 0,
])
frame3.info['transparency'] = 0
frame3.info['disposal'] = 1

import sys

frame1.save(
	sys.argv[1],
	save_all=True,
	append_images=[frame2, frame3],
	loop=0,
	duration=[5, 6, 7],
	disposal=[1, 2, 1],
)
`;
	execFileSync('python3', ['-c', pythonProgram, filePath], {encoding: 'utf8'});
}

function createGifWithImageMagick(filePath) {
	execFileSync('magick', [
		'-size',
		'3x2',
		'xc:none',
		'-fill',
		'red',
		'-draw',
		'point 0,0',
		'-fill',
		'lime',
		'-draw',
		'point 1,0',
		'-fill',
		'blue',
		'-draw',
		'point 2,1',
		filePath,
	]);
}

function createAnimatedGifWithImageMagick(filePath) {
	execFileSync('magick', [
		'-size',
		'3x2',
		'xc:red',
		'-delay',
		'5',
		'-size',
		'3x2',
		'xc:blue',
		'-delay',
		'6',
		'-loop',
		'2',
		filePath,
	]);
}

test('decodes the GIF89a reference block layout from literal bytes', () => {
	const decoded = decodeGIF(minimalGifBytes());
	assert.equal(decoded.type, 'gif');
	assert.equal(decoded.version, '89a');
	assert.equal(decoded.width, 1);
	assert.equal(decoded.height, 1);
	assert.deepEqual([...decoded.globalColorTable], blackWhiteGlobalColorTable);
	assert.equal(decoded.blocks.length, 1);
	assert.deepEqual([...decoded.imageBlocks[0].pixels], [0]);
});

test('decodes GIF87a logical screen and color table without image blocks', () => {
	const decoded = decodeGIF(bytes(
		...gifSignature,
		...gif87aVersion,
		...logicalScreenBytes({
			width: 2,
			height: 3,
			packedField: 0x91,
			backgroundColorIndex: 1,
			pixelAspectRatio: 49,
		}),
		...blackRedGreenBlueGlobalColorTable,
		0x3B,
	));
	assert.equal(decoded.version, '87a');
	assert.equal(decoded.width, 2);
	assert.equal(decoded.height, 3);
	assert.equal(decoded.backgroundColorIndex, 1);
	assert.deepEqual([...decoded.globalColorTable], blackRedGreenBlueGlobalColorTable);
	assert.deepEqual(decoded.blocks, []);
	assert.deepEqual(decoded.imageBlocks, []);
	assert.equal('colorResolution' in decoded, false);
	assert.equal('isGlobalColorTableSorted' in decoded, false);
	assert.equal('pixelAspectRatio' in decoded, false);
});

test('ignores legacy logical screen sort, color resolution, and pixel aspect metadata', () => {
	const decoded = decodeGIF(minimalGifBytes({
		packedField: 0b1111_1000,
		pixelAspectRatio: 49,
		globalColorTable: blackWhiteGlobalColorTable,
	}));
	assert.equal(decoded.globalColorTable.length, 6);
	assert.equal('colorResolution' in decoded, false);
	assert.equal('isGlobalColorTableSorted' in decoded, false);
	assert.equal('pixelAspectRatio' in decoded, false);
});

test('decodes image blocks with local color tables', () => {
	const decoded = decodeGIF(minimalGifBytes({
		packedField: 0,
		globalColorTable: [],
		imageDescriptorPackedField: 0x80,
		colorTable: blackWhiteGlobalColorTable,
	}));
	assert.equal(decoded.globalColorTable, undefined);
	assert.deepEqual([...decoded.imageBlocks[0].colorTable], blackWhiteGlobalColorTable);
	assert.deepEqual([...decoded.imageBlocks[0].pixels], [0]);
});

test('decodes transparent and pixel indexes against local color tables in strict mode', () => {
	const decoded = decodeGIF(minimalGifBytes({
		globalColorTable: blackWhiteGlobalColorTable,
		imageDescriptorPackedField: 0b1000_0001,
		colorTable: blackRedGreenBlueGlobalColorTable,
		beforeImage: graphicControlExtensionBytes({
			packedField: 1,
			transparentColorIndex: 3,
		}),
		imageData: imageDataFromLzwCodes({
			codeSequence: [
				4,
				3,
				5,
			],
		}),
	}));

	assert.equal(decoded.imageBlocks[0].graphicControlExtension.transparentColorIndex, 3);
	assert.deepEqual([...decoded.imageBlocks[0].pixels], [3]);
});

test('rejects image blocks without an active color table in strict mode', () => {
	const gif = minimalGifBytes({
		packedField: 0,
		globalColorTable: [],
	});

	assert.throws(() => decodeGIF(gif), {message: /active color table/v});
	assert.deepEqual([...decodeGIF(gif, {strict: false}).imageBlocks[0].pixels], [0]);
});

test('rejects image blocks with graphic control metadata but no active color table in strict mode', () => {
	const gif = minimalGifBytes({
		packedField: 0,
		globalColorTable: [],
		beforeImage: graphicControlExtensionBytes({
			packedField: 1,
			transparentColorIndex: 0,
			delayTime: 4,
		}),
	});

	assert.throws(() => decodeGIF(gif), {message: /active color table/v});
	const decoded = decodeGIF(gif, {strict: false});
	assert.equal(decoded.imageBlocks[0].graphicControlExtension.delay, 0.04);
	assert.equal(decoded.imageBlocks[0].graphicControlExtension.transparentColorIndex, 0);
	assert.deepEqual([...decoded.imageBlocks[0].pixels], [0]);
});

test('decodes comment extension sub-blocks as one payload', () => {
	const commentPayload = asciiBytes('hello world');
	const decoded = decodeGIF(minimalGifBytes({
		beforeImage: commentExtensionBytes(commentPayload),
	}));
	assert.equal(decoded.blocks[0].type, 'commentExtension');
	assert.deepEqual([...decoded.blocks[0].data], commentPayload);
});

test('decodes empty comment extension before an image as one frame', () => {
	const decoded = decodeGIF(minimalGifBytes({
		beforeImage: [
			0x21, 0xFE, 0x00,
		],
	}));
	assert.equal(decoded.blocks[0].type, 'commentExtension');
	assert.deepEqual([...decoded.blocks[0].data], []);
	assert.equal(decoded.imageBlocks.length, 1);
});

test('decodes multiple comment blocks as separate blocks in stream order', () => {
	const firstCommentPayload = asciiBytes('first');
	const secondCommentPayload = asciiBytes('second');
	const decoded = decodeGIF(minimalGifBytes({
		beforeImage: [
			...commentExtensionBytes(firstCommentPayload),
			...commentExtensionBytes(secondCommentPayload),
		],
	}));
	assert.equal(decoded.blocks[0].type, 'commentExtension');
	assert.equal(decoded.blocks[1].type, 'commentExtension');
	assert.deepEqual([...decoded.blocks[0].data], firstCommentPayload);
	assert.deepEqual([...decoded.blocks[1].data], secondCommentPayload);
	assert.equal(decoded.blocks[2].type, 'image');
});

test('decodes application extension fields and payload', () => {
	const decoded = decodeGIF(minimalGifBytes({
		beforeImage: appExtensionBytes({
			identifier: 'APPNAME1',
			authenticationCode: 'abc',
			data: [1, 2, 3, 4],
		}),
	}));
	assert.equal(decoded.blocks[0].type, 'applicationExtension');
	assert.equal(decoded.blocks[0].identifier, 'APPNAME1');
	assert.deepEqual([...decoded.blocks[0].authenticationCode], asciiBytes('abc'));
	assert.deepEqual([...decoded.blocks[0].data], [1, 2, 3, 4]);
});

test('preserves binary application authentication code bytes', () => {
	const authenticationCodeBytes = [0x00, 0x80, 0xFF];
	const decoded = decodeGIF(minimalGifBytes({
		beforeImage: appExtensionBytes({
			identifier: 'APPBIN01',
			authenticationCode: authenticationCodeBytes,
			data: [0x41],
		}),
	}));
	assert.deepEqual([...decoded.blocks[0].authenticationCode], authenticationCodeBytes);

	const encodableGIF = {
		width: decoded.width,
		height: decoded.height,
		backgroundColorIndex: decoded.backgroundColorIndex,
		globalColorTable: decoded.globalColorTable,
		blocks: decoded.blocks,
	};
	const redecoded = decodeGIF(encodeGIF(encodableGIF));
	assert.deepEqual([...redecoded.blocks[0].authenticationCode], authenticationCodeBytes);
});

test('decodes XMP and ICC application extensions as ordinary application blocks', () => {
	const xmpPayload = asciiBytes('<x:xmpmeta>metadata</x:xmpmeta>');
	const decoded = decodeGIF(minimalGifBytes({
		beforeImage: [
			...appExtensionBytes({
				identifier: 'XMP Data',
				authenticationCode: 'XMP',
				data: xmpPayload,
			}),
			...appExtensionBytes({
				identifier: 'ICCRGBG1',
				authenticationCode: '012',
				data: [1, 1, 0xDE, 0xAD, 0xBE, 0xEF],
			}),
		],
	}));
	assert.equal(decoded.blocks[0].identifier, 'XMP Data');
	assert.deepEqual([...decoded.blocks[0].authenticationCode], asciiBytes('XMP'));
	assert.deepEqual([...decoded.blocks[0].data], xmpPayload);
	assert.equal(decoded.blocks[1].identifier, 'ICCRGBG1');
	assert.deepEqual([...decoded.blocks[1].data], [1, 1, 0xDE, 0xAD, 0xBE, 0xEF]);
});

test('decodes Netscape looping extension into playCount', () => {
	const decoded = decodeGIF(minimalGifBytes({
		beforeImage: appExtensionBytes({
			identifier: 'NETSCAPE',
			authenticationCode: '2.0',
			data: [1, 5, 0],
		}),
	}));
	assert.equal(decoded.playCount, 6);
	assert.equal('loopCount' in decoded, false);
	assert.equal(decoded.blocks[0].isNetscapeLoopingExtension, true);
	assert.equal(decoded.blocks[0].playCount, 6);
	assert.equal('loopCount' in decoded.blocks[0], false);
});

test('does not treat short Netscape-like application data as play count metadata', () => {
	const decoded = decodeGIF(minimalGifBytes({
		beforeImage: appExtensionBytes({
			identifier: 'NETSCAPE',
			authenticationCode: '2.0',
			data: [1, 5],
		}),
	}));

	assert.equal(decoded.playCount, undefined);
	assert.equal('playCount' in decoded, false);
	assert.equal(decoded.blocks[0].isNetscapeLoopingExtension, undefined);
	assert.equal(decoded.blocks[0].playCount, undefined);
	assert.deepEqual([...decoded.blocks[0].data], [1, 5]);
});

test('decodes Netscape looping extension from longer application data', () => {
	const decoded = decodeGIF(minimalGifBytes({
		beforeImage: appExtensionBytes({
			identifier: 'NETSCAPE',
			authenticationCode: '2.0',
			data: [1, 5, 0, 99],
		}),
	}));

	assert.equal(decoded.playCount, 6);
	assert.equal(decoded.blocks[0].isNetscapeLoopingExtension, true);
	assert.equal(decoded.blocks[0].playCount, 6);
	assert.deepEqual([...decoded.blocks[0].data], [1, 5, 0, 99]);
});

test('decodes plain text extensions as unknown extensions', () => {
	const gif = minimalGifBytes({
		beforeImage: [
			...graphicControlExtensionBytes({
				packedField: 0b0000_1001,
				delayTime: 12,
				transparentColorIndex: 1,
			}),
			...plainTextExtensionBytes(asciiBytes('Text')),
		],
	});

	const decoded = decodeGIF(gif);
	assert.equal(decoded.blocks[0].type, 'unknownExtension');
	assert.equal(decoded.blocks[0].extensionLabel, 0x01);
	assert.deepEqual([...decoded.blocks[0].fixedData], [
		1,
		0,
		2,
		0,
		3,
		0,
		4,
		0,
		8,
		16,
		1,
		0,
	]);
	assert.deepEqual([...decoded.blocks[0].data], asciiBytes('Text'));
	assert.equal(decoded.imageBlocks[0].graphicControlExtension, undefined);
});

test('ignores obsolete user-input flag while decoding graphic control extensions', () => {
	const decoded = decodeGIF(minimalGifBytes({
		beforeImage: graphicControlExtensionBytes({
			packedField: 0b0000_0010,
			delayTime: 7,
		}),
	}));

	assert.deepEqual(decoded.imageBlocks[0].graphicControlExtension, {
		disposalMethod: 'unspecified',
		delay: 0.07,
		transparentColorIndex: undefined,
	});
});

test('decodes unknown extension labels', () => {
	const gif = minimalGifBytes({
		beforeImage: [
			0x21,
			0x7F,
			0x02,
			0xAA,
			0xBB,
			0x03,
			0x01,
			0x02,
			0x03,
			0x00,
		],
	});
	const decoded = decodeGIF(gif);
	assert.equal(decoded.blocks[0].type, 'unknownExtension');
	assert.equal(decoded.blocks[0].extensionLabel, 0x7F);
	assert.deepEqual([...decoded.blocks[0].fixedData], [0xAA, 0xBB]);
	assert.deepEqual([...decoded.blocks[0].data], [1, 2, 3]);
});

test('decodes empty unknown extensions', () => {
	const gif = bytes(
		...gifSignature,
		...gif89aVersion,
		...logicalScreenBytes({packedField: 0}),
		0x21,
		0x7F,
		0x00,
		0x3B,
	);
	const decoded = decodeGIF(gif);

	assert.equal(decoded.blocks[0].type, 'unknownExtension');
	assert.equal(decoded.blocks[0].extensionLabel, 0x7F);
	assert.deepEqual([...decoded.blocks[0].fixedData], []);
	assert.deepEqual([...decoded.blocks[0].data], []);
});

test('decodes GIF87a generic extensions in loose mode', () => {
	const gif = bytes(
		...gifSignature,
		...gif87aVersion,
		...logicalScreenBytes({packedField: 0}),
		0x21,
		0x7F,
		0x02,
		0xAA,
		0xBB,
		0x03,
		0x01,
		0x02,
		0x03,
		0x00,
		0x3B,
	);

	const decoded = decodeGIF(gif, {strict: false});
	assert.equal(decoded.version, '87a');
	assert.equal(decoded.blocks[0].type, 'unknownExtension');
	assert.equal(decoded.blocks[0].extensionLabel, 0x7F);
	assert.deepEqual([...decoded.blocks[0].fixedData], []);
	assert.deepEqual([...decoded.blocks[0].data], [0xAA, 0xBB, 0x01, 0x02, 0x03]);
});

test('ignores unknown extensions while rendering image frames', () => {
	const decoded = decodeGIF(minimalGifBytes({
		beforeImage: [
			0x21,
			0xFA,
			0x01,
			0xCC,
			0x02,
			0xDD,
			0xEE,
			0x00,
		],
	}), {strict: false});
	const rendered = renderGIFFrames(decoded);

	assert.equal(decoded.blocks[0].type, 'unknownExtension');
	assert.equal(rendered.frames.length, 1);
	assert.deepEqual([...rendered.frames[0].pixels], [
		0,
		0,
		0,
		255,
	]);
});

test('ignores non-rendering extension blocks while rendering image frames', () => {
	const rendered = renderGIFFrames({
		width: 1,
		height: 1,
		globalColorTable: blackWhiteGlobalColorTable,
		blocks: [
			{
				type: 'commentExtension',
				data: 'hello',
			},
			{
				type: 'applicationExtension',
				identifier: 'APPNAME1',
				authenticationCode: 'abc',
				data: [1, 2, 3],
			},
			{
				type: 'image',
				width: 1,
				height: 1,
				pixels: [1],
			},
		],
	});

	assert.equal(rendered.frames.length, 1);
	assert.deepEqual([...rendered.frames[0].pixels], [
		255,
		255,
		255,
		255,
	]);
});

test('uses unknown extension label ranges to delimit graphic control scope', () => {
	const unknownGraphicRenderingExtension = [
		0x21,
		0x7F,
		0x01,
		0xAA,
		0x00,
	];
	const decoded = decodeGIF(minimalGifBytes({
		beforeImage: [
			...graphicControlExtensionBytes({delayTime: 7}),
			...unknownGraphicRenderingExtension,
		],
	}));
	assert.equal(decoded.blocks[0].type, 'unknownExtension');
	assert.equal(decoded.blocks[1].graphicControlExtension, undefined);

	const unknownSpecialPurposeExtension = [
		0x21,
		0xFA,
		0x01,
		0xBB,
		0x00,
	];
	const specialPurposeDecoded = decodeGIF(minimalGifBytes({
		beforeImage: [
			...graphicControlExtensionBytes({delayTime: 8}),
			...unknownSpecialPurposeExtension,
		],
	}), {strict: false});
	assert.equal(specialPurposeDecoded.blocks[1].graphicControlExtension.delay, 0.08);

	const unknownTrailerLabelExtension = [
		0x21,
		0x3B,
		0x01,
		0xCC,
		0x00,
	];
	const trailerLabelDecoded = decodeGIF(minimalGifBytes({
		beforeImage: [
			...graphicControlExtensionBytes({delayTime: 9}),
			...unknownTrailerLabelExtension,
		],
	}), {strict: false});
	assert.equal(trailerLabelDecoded.blocks[1].graphicControlExtension.delay, 0.09);
});

test('decodes a simple 10x10 indexed pattern adapted from Rust image-gif samples', () => {
	const indexedPixels = [
		1,
		1,
		1,
		1,
		1,
		2,
		2,
		2,
		2,
		2,
		1,
		1,
		1,
		1,
		1,
		2,
		2,
		2,
		2,
		2,
		1,
		1,
		1,
		1,
		1,
		2,
		2,
		2,
		2,
		2,
		1,
		1,
		1,
		0,
		0,
		0,
		0,
		2,
		2,
		2,
		1,
		1,
		1,
		0,
		0,
		0,
		0,
		2,
		2,
		2,
		2,
		2,
		2,
		0,
		0,
		0,
		0,
		1,
		1,
		1,
		2,
		2,
		2,
		0,
		0,
		0,
		0,
		1,
		1,
		1,
		2,
		2,
		2,
		2,
		2,
		1,
		1,
		1,
		1,
		1,
		2,
		2,
		2,
		2,
		2,
		1,
		1,
		1,
		1,
		1,
		2,
		2,
		2,
		2,
		2,
		1,
		1,
		1,
		1,
		1,
	];
	const encoded = encodeGIF({
		width: 10,
		height: 10,
		globalColorTable: blackRedGreenBlueGlobalColorTable,
		blocks: [{
			type: 'image',
			width: 10,
			height: 10,
			pixels: indexedPixels,
		}],
	});
	assert.deepEqual([...decodeGIF(encoded).imageBlocks[0].pixels], indexedPixels);
});

test('decodes LZW clear codes in the middle of an image stream', () => {
	const decoded = decodeGIF(minimalGifBytes({
		width: 4,
		height: 1,
		imageData: imageDataFromLzwCodes({
			codeSequence: [
				4,
				0,
				1,
				4,
				1,
				0,
				5,
			],
		}),
	}));
	assert.deepEqual([...decoded.imageBlocks[0].pixels], [0, 1, 1, 0]);
});

test('rejects LZW streams that decompress more pixels than the image dimensions allow', () => {
	assert.throws(() => decodeGIF(minimalGifBytes({
		width: 1,
		height: 1,
		imageData: imageDataFromLzwCodes({
			codeSequence: [
				4,
				0,
				1,
				5,
			],
		}),
	})), {message: /Decompressed more pixels than the image dimensions allow/v});
});

test('requires LZW image data to start with a clear code in strict mode', () => {
	const gif = minimalGifBytes({
		width: 2,
		height: 1,
		imageData: imageDataFromLzwCodes({
			codeSequence: [
				0,
				1,
				5,
			],
		}),
	});
	assert.throws(() => decodeGIF(gif), {message: /must start with a Clear code/v});
	assert.deepEqual([...decodeGIF(gif, {strict: false}).imageBlocks[0].pixels], [0, 1]);
});

test('decodes LZW dictionary-reference code equal to the next available code', () => {
	const decoded = decodeGIF(minimalGifBytes({
		width: 3,
		height: 1,
		imageData: imageDataFromLzwCodes({
			codeSequence: [
				4,
				1,
				6,
				5,
			],
		}),
	}));
	assert.deepEqual([...decoded.imageBlocks[0].pixels], [1, 1, 1]);
});

test('rejects invalid LZW dictionary-reference code before any previous code exists', () => {
	assert.throws(() => decodeGIF(minimalGifBytes({
		width: 1,
		height: 1,
		imageData: imageDataFromLzwCodes({
			codeSequence: [
				4,
				6,
				5,
			],
		}),
	})), {message: /before any previous code existed/v});
});

test('rejects invalid LZW dictionary-reference code above the next available code', () => {
	assert.throws(() => decodeGIF(minimalGifBytes({
		width: 1,
		height: 1,
		imageData: imageDataFromLzwCodes({
			codeSequence: [
				4,
				0,
				7,
				5,
			],
		}),
	})), {message: /Encountered invalid compressed code 7/v});
});

test('rejects unused compressed image data after the LZW End of Information code in strict mode', () => {
	const gif = minimalGifBytes({
		imageData: [
			0x02,
			0x03,
			0x44,
			0x01,
			0x00,
			0x00,
		],
	});
	assert.throws(() => decodeGIF(gif), {message: /unused compressed image data/v});
	assert.deepEqual([...decodeGIF(gif, {strict: false}).imageBlocks[0].pixels], [0]);
});

test('decodes LZW code-size boundary transitions', () => {
	const indexedPixels = [
		0,
		1,
		2,
		3,
		0,
		1,
		2,
		3,
		0,
		1,
		2,
		3,
		0,
		1,
		2,
		3,
	];
	const decoded = decodeGIF(minimalGifBytes({
		width: indexedPixels.length,
		height: 1,
		packedField: 0x81,
		globalColorTable: blackRedGreenBlueGlobalColorTable,
		imageData: [
			0x02,
			0x0A,
			0x44,
			0x34,
			0x10,
			0x32,
			0x10,
			0x32,
			0x40,
			0x10,
			0xA3,
			0x00,
			0x00,
		],
	}));
	assert.deepEqual([...decoded.imageBlocks[0].pixels], indexedPixels);
});

test('rejects reset-only LZW streams without stalling', () => {
	const repeatedClearCodes = Array.from({length: 1024}, () => 4);
	assert.throws(() => decodeGIF(minimalGifBytes({
		imageData: imageDataFromLzwCodes({
			codeSequence: [
				...repeatedClearCodes,
				5,
			],
		}),
	})), {message: /Expected 1 pixel indices, decoded 0/v});
});

test('decodes deferred-clear LZW streams after the dictionary is full', () => {
	const width = 5000;
	const indexedPixels = Uint8Array.from({length: width}, (_, index) => index % 256);
	const clearCode = 256;
	const endOfInformationCode = 257;
	const codeSequence = [
		clearCode,
		...indexedPixels,
		endOfInformationCode,
	];
	const decoded = decodeGIF(minimalGifBytes({
		width,
		height: 1,
		packedField: 0x87,
		globalColorTable: grayscaleColorTable(),
		imageData: imageDataFromLzwCodes({
			minimumCodeSize: 8,
			codeSequence,
		}),
	}));
	assert.deepEqual([...decoded.imageBlocks[0].pixels], [...indexedPixels]);
});

function createSingleFrameGIF() {
	return encodeGIF({
		width: 2,
		height: 2,
		globalColorTable: Uint8Array.from([
			0,
			0,
			0,
			255,
			255,
			255,
		]),
		blocks: [{
			type: 'image',
			width: 2,
			height: 2,
			pixels: Uint8Array.from([0, 1, 1, 0]),
		}],
	});
}

test('encodes and decodes a single-frame GIF', () => {
	const encoded = createSingleFrameGIF();
	const decoded = decodeGIF(encoded);
	assert.equal(decoded.version, '89a');
	assert.deepEqual([...decoded.imageBlocks[0].pixels], [0, 1, 1, 0]);
});

test('encoded single-frame GIF matches Pillow decoding', () => {
	if (!hasPillow) {
		return;
	}

	const encoded = createSingleFrameGIF();
	const pillow = readGifWithPillow(writeFile('single-frame.gif', encoded));
	assert.deepEqual(pillow.size, [2, 2]);
	assert.equal(pillow.frames.length, 1);
});

test('encoded single-frame GIF matches ImageMagick decoding', () => {
	if (!hasImageMagick) {
		return;
	}

	const encoded = createSingleFrameGIF();
	assert.deepEqual(readGifWithImageMagick(writeFile('single-frame-imagemagick.gif', encoded), {
		width: 2,
		height: 2,
	}), [[
		0,
		0,
		0,
		255,
		255,
		255,
		255,
		255,
		255,
		255,
		255,
		255,
		0,
		0,
		0,
		255,
	]]);
});

test('decoded byte fields do not alias the input GIF buffer', () => {
	const encoded = encodeGIF({
		width: 1,
		height: 1,
		globalColorTable: rgbColorTable([0, 0, 0], [255, 0, 0]),
		blocks: [{
			type: 'image',
			width: 1,
			height: 1,
			pixels: [1],
		}],
	});
	const decoded = decodeGIF(encoded);
	const renderedBeforeMutation = renderGIFFrames(decoded);

	encoded[16] = 0;
	encoded[17] = 255;
	encoded[18] = 0;

	assert.deepEqual([...decoded.globalColorTable], [0, 0, 0, 255, 0, 0]);
	assert.deepEqual([...renderedBeforeMutation.frames[0].pixels], [255, 0, 0, 255]);
	assert.deepEqual([...renderGIFFrames(decoded).frames[0].pixels], [255, 0, 0, 255]);
});

test('decoded byte fields do not alias Buffer input', () => {
	const encoded = Buffer.from(encodeGIF({
		width: 1,
		height: 1,
		globalColorTable: rgbColorTable([0, 0, 0], [255, 0, 0]),
		blocks: [{
			type: 'image',
			width: 1,
			height: 1,
			pixels: [1],
		}],
	}));
	const decoded = decodeGIF(encoded);

	encoded[16] = 0;
	encoded[17] = 255;
	encoded[18] = 0;

	assert.deepEqual([...decoded.globalColorTable], [0, 0, 0, 255, 0, 0]);
	assert.deepEqual([...renderGIFFrames(decoded).frames[0].pixels], [255, 0, 0, 255]);
});

test('decoding does not trust custom input subarray methods', () => {
	const encoded = encodeGIF({
		width: 1,
		height: 1,
		globalColorTable: blackWhiteGlobalColorTable,
		blocks: [{
			type: 'image',
			width: 1,
			height: 1,
			pixels: [1],
		}],
	});
	encoded.subarray = () => {
		throw new Error('custom subarray called');
	};

	assert.equal(decodeGIF(encoded).width, 1);
});

test('accepts cross-realm byte arrays for public byte inputs', () => {
	const encoded = encodeGIF({
		width: 1,
		height: 1,
		globalColorTable: blackWhiteGlobalColorTable,
		blocks: [{
			type: 'image',
			width: 1,
			height: 1,
			pixels: [1],
		}],
	});
	const crossRealmGIFBytes = vm.runInNewContext('Uint8Array.from(bytes)', {bytes: [...encoded]});
	const crossRealmColorTable = vm.runInNewContext('new Uint8Array([0, 0, 0, 255, 255, 255])');
	const crossRealmIndexedPixels = vm.runInNewContext('new Uint8Array([1])');
	const crossRealmRedGreenBlueAlphaPixels = vm.runInNewContext('new Uint8ClampedArray([0, 0, 0, 0])');

	assert.equal(decodeGIF(crossRealmGIFBytes).width, 1);
	assert.deepEqual([...decodeGIF(encodeGIF({
		width: 1,
		height: 1,
		globalColorTable: crossRealmColorTable,
		blocks: [{
			type: 'image',
			width: 1,
			height: 1,
			pixels: crossRealmIndexedPixels,
		}],
	})).imageBlocks[0].pixels], [1]);
	assert.equal(createIndexedImage(crossRealmRedGreenBlueAlphaPixels).transparentColorIndex, 0);
});

test('rejects malformed encode block lists', () => {
	assert.throws(() => encodeGIF({
		width: 1,
		height: 1,
		blocks: 'bad',
	}), {message: /blocks must be an array/v});

	assert.throws(() => encodeGIF({
		width: 1,
		height: 1,
		imageBlocks: [{
			type: 'image',
			width: 1,
			height: 1,
			pixels: [1],
		}],
	}), {message: /imageBlocks is not supported when encoding; use blocks/v});

	assert.throws(() => encodeGIF({
		width: 1,
		height: 1,
		globalColorTable: blackWhiteGlobalColorTable,
		blocks: [],
		imageBlocks: [{
			type: 'image',
			width: 1,
			height: 1,
			pixels: [1],
		}],
	}), {message: /imageBlocks is not supported when encoding; use blocks/v});
});

test('encodes image-free global color table streams allowed by the GIF spec', () => {
	const encoded = encodeGIF({
		width: 1,
		height: 1,
		globalColorTable: blackWhiteGlobalColorTable,
		blocks: [],
	});
	const decoded = decodeGIF(encoded);
	assert.deepEqual([...encoded.slice(0, 6)], [...gifSignature, ...gif89aVersion]);
	assert.deepEqual([...decoded.globalColorTable], blackWhiteGlobalColorTable);
	assert.deepEqual(decoded.blocks, []);
	assert.deepEqual(decoded.imageBlocks, []);
});

test('encodes supported logical-screen metadata fields', () => {
	const encoded = encodeGIF({
		width: 2,
		height: 1,
		globalColorTable: blackRedGreenBlueGlobalColorTable,
		backgroundColorIndex: 2,
		blocks: [{
			type: 'image',
			width: 2,
			height: 1,
			pixels: [1, 3],
		}],
	});
	const decoded = decodeGIF(encoded);

	assert.deepEqual([...encoded.slice(6, 13)], [
		2,
		0,
		1,
		0,
		0b1001_0001,
		2,
		0,
	]);
	assert.equal(decoded.backgroundColorIndex, 2);
	assert.equal('pixelAspectRatio' in decoded, false);
	assert.equal('colorResolution' in decoded, false);
	assert.equal('isGlobalColorTableSorted' in decoded, false);
	assert.deepEqual([...decoded.imageBlocks[0].pixels], [1, 3]);
});

test('encodes RGB triplet color tables', () => {
	const decoded = decodeGIF(encodeGIF({
		width: 2,
		height: 1,
		globalColorTable: [
			[0, 0, 0],
			[255, 0, 0],
			[0, 255, 0],
			[0, 0, 255],
		],
		blocks: [{
			type: 'image',
			width: 2,
			height: 1,
			pixels: [1, 3],
		}],
	}));

	assert.deepEqual([...decoded.globalColorTable], blackRedGreenBlueGlobalColorTable);
	assert.deepEqual([...decoded.imageBlocks[0].pixels], [1, 3]);
});

test('rejects non-zero background color indexes without global color tables', () => {
	const gif = bytes(
		...gifSignature,
		...gif89aVersion,
		...logicalScreenBytes({
			packedField: 0,
			backgroundColorIndex: 1,
		}),
		0x3B,
	);
	assert.throws(() => decodeGIF(gif), {message: /Background color index must be zero/v});
	assert.equal(decodeGIF(gif, {strict: false}).backgroundColorIndex, 1);

	assert.throws(() => encodeGIF({
		width: 1,
		height: 1,
		backgroundColorIndex: 1,
		blocks: [],
	}), {message: /Background color index must be zero/v});
});

test('rejects background color indexes outside the global color table while encoding', () => {
	assert.throws(() => encodeGIF({
		width: 1,
		height: 1,
		globalColorTable: blackWhiteGlobalColorTable,
		backgroundColorIndex: 2,
		blocks: [],
	}), {message: /Background color index must be inside the global color table/v});
});

test('rejects invalid logical-screen metadata while encoding', () => {
	assert.throws(() => encodeGIF({
		width: 1,
		height: 1,
		globalColorTable: blackWhiteGlobalColorTable,
		backgroundColorIndex: 256,
		blocks: [{
			type: 'unsupported',
		}],
	}), {message: /backgroundColorIndex must be an integer between 0 and 255/v});

	assert.throws(() => encodeGIF({
		width: 1,
		height: 1,
		globalColorTable: blackWhiteGlobalColorTable,
		playCount: 65_537,
		blocks: [{
			type: 'image',
			width: 1,
			height: 1,
			pixels: [2],
		}],
	}), {message: /playCount must be an integer between 1 and 65536/v});
});

test('rejects plain text extensions while encoding', () => {
	assert.throws(() => encodeGIF({
		width: 1,
		height: 1,
		blocks: [{
			type: 'plainTextExtension',
			textGridWidth: 1,
			textGridHeight: 1,
			characterCellWidth: 8,
			characterCellHeight: 8,
			textForegroundColorIndex: 0,
			textBackgroundColorIndex: 0,
			data: 'x',
		}],
	}), {message: /Unsupported block type "plainTextExtension"/v});
});

test('encodes GIF89a', () => {
	const encoded = encodeGIF({
		width: 1,
		height: 1,
		globalColorTable: blackWhiteGlobalColorTable,
		blocks: [{
			type: 'image',
			width: 1,
			height: 1,
			pixels: [1],
		}],
	});
	assert.deepEqual([...encoded.slice(0, 6)], [...gifSignature, ...gif89aVersion]);
});

test('encodes extension and graphic control data as GIF89a', () => {
	for (const block of [
		{
			type: 'commentExtension',
			data: 'hello',
		},
		{
			type: 'applicationExtension',
			identifier: 'APPNAME1',
			authenticationCode: '123',
			data: [],
		},
	]) {
		const encoded = encodeGIF({
			width: 1,
			height: 1,
			globalColorTable: blackWhiteGlobalColorTable,
			blocks: [
				block,
				{
					type: 'image',
					width: 1,
					height: 1,
					pixels: [1],
				},
			],
		});
		assert.deepEqual([...encoded.slice(0, 6)], [...gifSignature, ...gif89aVersion]);
	}

	const encoded = encodeGIF({
		width: 1,
		height: 1,
		globalColorTable: blackWhiteGlobalColorTable,
		blocks: [{
			type: 'image',
			width: 1,
			height: 1,
			graphicControlExtension: {
				delay: 0.01,
			},
			pixels: [1],
		}],
	});
	assert.deepEqual([...encoded.slice(0, 6)], [...gifSignature, ...gif89aVersion]);
});

test('encodes opaque RGBA images as GIF89a', () => {
	const encoded = encodeGIF({
		width: 1,
		height: 1,
		blocks: [{
			type: 'rgbaImage',
			width: 1,
			height: 1,
			pixels: redGreenBlueAlphaPixelBytes([255, 0, 0, 255]),
		}],
	});

	assert.deepEqual([...encoded.slice(0, 6)], [...gifSignature, ...gif89aVersion]);
	assert.equal(decodeGIF(encoded).imageBlocks[0].graphicControlExtension, undefined);
});

test('rejects GIF87a streams that contain GIF89a extension blocks in strict mode', () => {
	const cases = [
		{
			beforeImage: graphicControlExtensionBytes(),
			blockType: 'image',
		},
		{
			beforeImage: commentExtensionBytes([0x41]),
			blockType: 'commentExtension',
		},
		{
			beforeImage: plainTextExtensionBytes([0x41]),
			blockType: 'unknownExtension',
		},
		{
			beforeImage: appExtensionBytes({
				identifier: 'APPNAME1',
				authenticationCode: 'abc',
				data: [0x41],
			}),
			blockType: 'applicationExtension',
		},
	];

	for (const {beforeImage, blockType, options = {strict: false}} of cases) {
		const gif = minimalGifBytes({
			version: gif87aVersion,
			beforeImage,
		});

		assert.throws(() => decodeGIF(gif), {message: /GIF87a streams cannot contain extension label/v});
		assert.equal(decodeGIF(gif, options).blocks[0].type, blockType);
	}
});

test('preserves frame metadata through decode and re-encode', () => {
	const original = {
		width: 4,
		height: 3,
		globalColorTable: blackRedGreenBlueGlobalColorTable,
		playCount: 7,
		blocks: [
			{
				type: 'commentExtension',
				data: 'hello',
			},
			{
				type: 'image',
				left: 0,
				top: 0,
				width: 4,
				height: 3,
				graphicControlExtension: {
					disposalMethod: 'keep',
					delay: 0.1,
					transparentColorIndex: 0,
				},
				pixels: [
					1,
					1,
					1,
					1,
					1,
					2,
					2,
					1,
					1,
					1,
					1,
					1,
				],
			},
			{
				type: 'image',
				left: 1,
				top: 1,
				width: 2,
				height: 1,
				isInterlaced: true,
				colorTable: rgbColorTable([0, 0, 0], [255, 255, 0]),
				graphicControlExtension: {
					disposalMethod: 'restoreBackground',
					delay: 0.2,
				},
				pixels: [1, 1],
			},
		],
	};
	const decoded = decodeGIF(encodeGIF(original));
	const {imageBlocks, ...encodableGIF} = decoded;
	const redecoded = decodeGIF(encodeGIF(encodableGIF));
	assert.equal(redecoded.width, decoded.width);
	assert.equal(redecoded.height, decoded.height);
	assert.equal(redecoded.playCount, decoded.playCount);
	assert.deepEqual([...redecoded.globalColorTable], [...decoded.globalColorTable]);
	assert.equal(redecoded.imageBlocks.length, decoded.imageBlocks.length);

	for (let index = 0; index < decoded.imageBlocks.length; index += 1) {
		const reference = decoded.imageBlocks[index];
		const actual = redecoded.imageBlocks[index];
		assert.equal(actual.left, reference.left);
		assert.equal(actual.top, reference.top);
		assert.equal(actual.width, reference.width);
		assert.equal(actual.height, reference.height);
		assert.equal(actual.isInterlaced, reference.isInterlaced);
		assert.deepEqual(actual.graphicControlExtension, reference.graphicControlExtension);
		assert.deepEqual([...actual.pixels], [...reference.pixels]);
		assert.deepEqual(actual.colorTable && [...actual.colorTable], reference.colorTable && [...reference.colorTable]);
	}
});

test('encodes image geometry exactly and infers minimum code size', () => {
	const encoded = encodeGIF({
		width: 4,
		height: 3,
		globalColorTable: blackRedGreenBlueGlobalColorTable,
		blocks: [{
			type: 'image',
			left: 1,
			top: 2,
			width: 2,
			height: 1,
			pixels: [1, 3],
		}],
	});
	const decoded = decodeGIF(encoded);
	const imageBlock = getTopLevelGIFBlocks(encoded).find(block => block.kind === 'image');

	assert.notEqual(imageBlock, undefined);
	assert.deepEqual(imageBlock.imageDescriptorPacket, [
		0x2C,
		1,
		0,
		2,
		0,
		2,
		0,
		1,
		0,
		0,
	]);
	assert.equal(extractFirstImageData(encoded).minimumCodeSize, 2);
	assert.equal(decoded.imageBlocks[0].left, 1);
	assert.equal(decoded.imageBlocks[0].top, 2);
	assert.equal(decoded.imageBlocks[0].width, 2);
	assert.equal(decoded.imageBlocks[0].height, 1);
	assert.equal(decoded.imageBlocks[0].minimumCodeSize, 2);
	assert.deepEqual([...decoded.imageBlocks[0].pixels], [1, 3]);
});

test('ignores image color table sort flag while encoding and decoding', () => {
	const encoded = encodeGIF({
		width: 1,
		height: 1,
		blocks: [{
			type: 'image',
			width: 1,
			height: 1,
			colorTable: blackWhiteGlobalColorTable,
			pixels: [1],
		}],
	});
	const decoded = decodeGIF(encoded);
	const imageBlock = getTopLevelGIFBlocks(encoded).find(block => block.kind === 'image');

	assert.notEqual(imageBlock, undefined);
	assert.equal(imageBlock.imageDescriptorPacket[9], 0b1000_0000);
	assert.equal('isColorTableSorted' in decoded.imageBlocks[0], false);
	assert.deepEqual([...decoded.imageBlocks[0].colorTable], blackWhiteGlobalColorTable);
});

test('encodes playCount as a Netscape application extension when missing', () => {
	const encoded = encodeGIF({
		width: 1,
		height: 1,
		globalColorTable: blackWhiteGlobalColorTable,
		playCount: 12,
		blocks: [{
			type: 'image',
			width: 1,
			height: 1,
			pixels: [1],
		}],
	});
	const decoded = decodeGIF(encoded);

	assert.notEqual(findByteSequence(encoded, [
		0x21,
		0xFF,
		0x0B,
		...asciiBytes('NETSCAPE'),
		...asciiBytes('2.0'),
		0x03,
		0x01,
		11,
		0,
		0,
	]), -1);
	assert.equal(decoded.playCount, 12);
	assert.equal(decoded.blocks[0].type, 'applicationExtension');
	assert.equal(decoded.blocks[0].identifier, 'NETSCAPE');
	assert.deepEqual([...decoded.blocks[0].authenticationCode], asciiBytes('2.0'));
});

test('encodes forever playCount as a Netscape loop count of zero', () => {
	const encoded = encodeGIF({
		width: 1,
		height: 1,
		globalColorTable: blackWhiteGlobalColorTable,
		playCount: 'forever',
		blocks: [{
			type: 'image',
			width: 1,
			height: 1,
			pixels: [1],
		}],
	});

	assert.notEqual(findByteSequence(encoded, [
		0x03,
		0x01,
		0,
		0,
		0,
	]), -1);
	assert.equal(decodeGIF(encoded).playCount, 'forever');
});

test('omits Netscape loop extension for playCount of one', () => {
	const encoded = encodeGIF({
		width: 1,
		height: 1,
		globalColorTable: blackWhiteGlobalColorTable,
		playCount: 1,
		blocks: [{
			type: 'image',
			width: 1,
			height: 1,
			pixels: [1],
		}],
	});

	assert.deepEqual(getTopLevelGIFBlockKinds(encoded), [
		'image',
		'trailer',
	]);
	assert.equal(decodeGIF(encoded).playCount, undefined);
});

test('round-trips the maximum finite playCount as little-endian Netscape bytes', () => {
	// 65536 is the largest finite play count. It must encode as loop count 0xFF 0xFF and decode back without sign or byte-order errors.
	const encoded = encodeGIF({
		width: 1,
		height: 1,
		globalColorTable: blackWhiteGlobalColorTable,
		playCount: 65_536,
		blocks: [{
			type: 'image',
			width: 1,
			height: 1,
			pixels: [1],
		}],
	});

	assert.notEqual(findByteSequence(encoded, [
		0x03,
		0x01,
		0xFF,
		0xFF,
		0x00,
	]), -1);
	assert.equal(decodeGIF(encoded).playCount, 65_536);
});

test('encodes playCount for image-free streams', () => {
	const encoded = encodeGIF({
		width: 1,
		height: 1,
		globalColorTable: blackWhiteGlobalColorTable,
		playCount: 4,
		blocks: [],
	});
	const decoded = decodeGIF(encoded);

	assert.deepEqual(getTopLevelGIFBlockKinds(encoded), [
		'applicationExtension',
		'trailer',
	]);
	assert.equal(decoded.playCount, 4);
	assert.equal(decoded.blocks[0].type, 'applicationExtension');
});

test('encodes playCount before generated RGBA transparency metadata', () => {
	const encoded = encodeGIF({
		width: 1,
		height: 1,
		playCount: 2,
		blocks: [{
			type: 'rgbaImage',
			width: 1,
			height: 1,
			pixels: redGreenBlueAlphaPixelBytes([0, 0, 0, 0]),
		}],
	});
	const decoded = decodeGIF(encoded);

	assert.deepEqual(getTopLevelGIFBlockKinds(encoded), [
		'applicationExtension',
		'graphicControlExtension',
		'image',
		'trailer',
	]);
	assert.equal(decoded.blocks[0].type, 'applicationExtension');
	assert.equal(decoded.blocks[1].type, 'image');
	assert.equal(decoded.playCount, 2);
	assert.equal(decoded.imageBlocks[0].graphicControlExtension.transparentColorIndex, 0);
});

test('does not duplicate an existing Netscape looping extension', () => {
	const encoded = encodeGIF({
		width: 1,
		height: 1,
		globalColorTable: blackWhiteGlobalColorTable,
		playCount: 12,
		blocks: [
			{
				type: 'applicationExtension',
				identifier: 'NETSCAPE',
				authenticationCode: '2.0',
				data: [1, 3, 0],
			},
			{
				type: 'image',
				width: 1,
				height: 1,
				pixels: [1],
			},
		],
	});
	const decoded = decodeGIF(encoded);
	assert.equal(decoded.playCount, 4);
	assert.equal(decoded.blocks.filter(block => block.type === 'applicationExtension').length, 1);
});

test('does not duplicate byte-exact existing Netscape looping extension', () => {
	const encoded = encodeGIF({
		width: 1,
		height: 1,
		globalColorTable: blackWhiteGlobalColorTable,
		playCount: 12,
		blocks: [
			{
				type: 'applicationExtension',
				identifier: 'NETSCAPE',
				authenticationCode: asciiBytes('2.0'),
				data: [1, 4, 0],
			},
			{
				type: 'image',
				width: 1,
				height: 1,
				pixels: [1],
			},
		],
	});
	const decoded = decodeGIF(encoded);

	assert.equal(decoded.playCount, 5);
	assert.equal(decoded.blocks.filter(block => block.type === 'applicationExtension').length, 1);
	assert.deepEqual(getTopLevelGIFBlockKinds(encoded), [
		'applicationExtension',
		'image',
		'trailer',
	]);
});

test('uses byte Netscape authentication codes for loop detection', () => {
	const byteExactLoopExtension = encodeGIF({
		width: 1,
		height: 1,
		globalColorTable: blackWhiteGlobalColorTable,
		playCount: 12,
		blocks: [
			{
				type: 'applicationExtension',
				identifier: 'NETSCAPE',
				authenticationCode: asciiBytes('2.0'),
				data: [1, 5, 0],
			},
			{
				type: 'image',
				width: 1,
				height: 1,
				pixels: [1],
			},
		],
	});
	const nonLoopByteExtension = encodeGIF({
		width: 1,
		height: 1,
		globalColorTable: blackWhiteGlobalColorTable,
		playCount: 12,
		blocks: [
			{
				type: 'applicationExtension',
				identifier: 'NETSCAPE',
				authenticationCode: asciiBytes('1.0'),
				data: [1, 5, 0],
			},
			{
				type: 'image',
				width: 1,
				height: 1,
				pixels: [1],
			},
		],
	});

	assert.equal(decodeGIF(byteExactLoopExtension).playCount, 6);
	assert.equal(decodeGIF(byteExactLoopExtension).blocks.filter(block => block.type === 'applicationExtension').length, 1);
	assert.equal(decodeGIF(nonLoopByteExtension).playCount, 12);
	assert.equal(decodeGIF(nonLoopByteExtension).blocks.filter(block => block.type === 'applicationExtension').length, 2);
});

test('adds loop extension before non-loop Netscape application extensions', () => {
	const encoded = encodeGIF({
		width: 1,
		height: 1,
		globalColorTable: blackWhiteGlobalColorTable,
		playCount: 9,
		blocks: [
			{
				type: 'applicationExtension',
				identifier: 'NETSCAPE',
				authenticationCode: '1.0',
				data: [1, 2, 0],
			},
			{
				type: 'image',
				width: 1,
				height: 1,
				pixels: [1],
			},
		],
	});
	const decoded = decodeGIF(encoded);

	assert.equal(decoded.playCount, 9);
	assert.equal(decoded.blocks.filter(block => block.type === 'applicationExtension').length, 2);
	assert.equal(decoded.blocks[0].isNetscapeLoopingExtension, true);
	assert.equal(decoded.blocks[1].isNetscapeLoopingExtension, undefined);
	assert.deepEqual(getTopLevelGIFBlockKinds(encoded), [
		'applicationExtension',
		'applicationExtension',
		'image',
		'trailer',
	]);
});

test('preserves existing Netscape looping extension before generated RGBA transparency', () => {
	const encoded = encodeGIF({
		width: 1,
		height: 1,
		playCount: 12,
		blocks: [
			{
				type: 'applicationExtension',
				identifier: 'NETSCAPE',
				authenticationCode: '2.0',
				data: [1, 5, 0],
			},
			{
				type: 'rgbaImage',
				width: 1,
				height: 1,
				pixels: redGreenBlueAlphaPixelBytes([0, 0, 0, 0]),
			},
		],
	});
	const decoded = decodeGIF(encoded);

	assert.deepEqual(getTopLevelGIFBlockKinds(encoded), [
		'applicationExtension',
		'graphicControlExtension',
		'image',
		'trailer',
	]);
	assert.equal(decoded.playCount, 6);
	assert.equal(decoded.blocks[0].playCount, 6);
	assert.equal(decoded.blocks[1].graphicControlExtension.transparentColorIndex, 0);
});

test('encodes long extension payloads as multiple data sub-blocks', () => {
	const data = Uint8Array.from({length: 300}, (_, index) => index % 256);
	const encoded = encodeGIF({
		width: 1,
		height: 1,
		globalColorTable: blackWhiteGlobalColorTable,
		blocks: [
			{
				type: 'commentExtension',
				data,
			},
			{
				type: 'image',
				width: 1,
				height: 1,
				pixels: [1],
			},
		],
	});
	const commentOffset = findByteSequence(encoded, [0x21, 0xFE]);
	assert.notEqual(commentOffset, -1);
	assert.equal(encoded[commentOffset + 2], 255);
	assert.equal(encoded[commentOffset + 258], 45);
	assert.deepEqual([...decodeGIF(encoded).blocks[0].data], [...data]);
});

test('encodes string comments and binary application authentication codes', () => {
	const encoded = encodeGIF({
		width: 2,
		height: 1,
		globalColorTable: blackWhiteGlobalColorTable,
		blocks: [
			{
				type: 'commentExtension',
				data: 'hello',
			},
			{
				type: 'applicationExtension',
				identifier: 'APPBIN01',
				authenticationCode: [0, 128, 255],
				data: Uint8Array.from([1, 2, 3]),
			},
			{
				type: 'image',
				width: 2,
				height: 1,
				pixels: [0, 1],
			},
		],
	});
	const decoded = decodeGIF(encoded);
	const appExtensionOffset = findByteSequence(encoded, [0x21, 0xFF, 0x0B]);

	assert.deepEqual(getTopLevelGIFBlockKinds(encoded), [
		'commentExtension',
		'applicationExtension',
		'image',
		'trailer',
	]);
	assert.notEqual(appExtensionOffset, -1);
	assert.deepEqual([...encoded.slice(appExtensionOffset + 3, appExtensionOffset + 14)], [
		...asciiBytes('APPBIN01'),
		0,
		128,
		255,
	]);
	assert.deepEqual([...decoded.blocks[0].data], asciiBytes('hello'));
	assert.deepEqual([...decoded.blocks[1].authenticationCode], [0, 128, 255]);
	assert.deepEqual([...decoded.blocks[1].data], [1, 2, 3]);
	assert.deepEqual([...decoded.imageBlocks[0].pixels], [0, 1]);
});

test('encodes default empty extension payloads', () => {
	const decoded = decodeGIF(encodeGIF({
		width: 1,
		height: 1,
		globalColorTable: blackWhiteGlobalColorTable,
		blocks: [
			{
				type: 'commentExtension',
			},
			{
				type: 'applicationExtension',
				identifier: 'APPNAME1',
				authenticationCode: 'abc',
			},
		],
	}));

	assert.equal(decoded.blocks[0].type, 'commentExtension');
	assert.deepEqual([...decoded.blocks[0].data], []);
	assert.equal(decoded.blocks[1].type, 'applicationExtension');
	assert.deepEqual([...decoded.blocks[1].data], []);
});

test('encodes Netscape application extension playCount metadata', () => {
	const decoded = decodeGIF(encodeGIF({
		width: 1,
		height: 1,
		blocks: [{
			type: 'applicationExtension',
			identifier: 'NETSCAPE',
			authenticationCode: '2.0',
			playCount: 7,
		}],
	}));

	assert.equal(decoded.playCount, 7);
	assert.equal(decoded.blocks[0].isNetscapeLoopingExtension, true);
	assert.deepEqual([...decoded.blocks[0].data], [1, 6, 0]);
});

test('rejects unrepresentable Netscape application extension playCount of one', () => {
	assert.throws(() => encodeGIF({
		width: 1,
		height: 1,
		blocks: [{
			type: 'applicationExtension',
			identifier: 'NETSCAPE',
			authenticationCode: '2.0',
			playCount: 1,
		}],
	}), {message: /applicationExtension\.playCount must be an integer between 2 and 65536/v});
});

test('rejects non-ASCII extension payload strings while encoding', () => {
	assert.throws(() => encodeGIF({
		width: 1,
		height: 1,
		globalColorTable: blackWhiteGlobalColorTable,
		blocks: [{
			type: 'commentExtension',
			data: 'hé',
		}],
	}), {message: /commentExtension\.data must contain only ASCII characters/v});

	assert.throws(() => encodeGIF({
		width: 1,
		height: 1,
		globalColorTable: blackWhiteGlobalColorTable,
		blocks: [{
			type: 'plainTextExtension',
			text: 'é',
		}],
	}), {message: /Unsupported block type "plainTextExtension"/v});
});

test('rejects sparse byte arrays while encoding', () => {
	const sparsePayload = [];
	sparsePayload.length = 1;
	assert.throws(() => encodeGIF({
		width: 1,
		height: 1,
		globalColorTable: blackWhiteGlobalColorTable,
		blocks: [{
			type: 'commentExtension',
			data: sparsePayload,
		}],
	}), {message: /commentExtension\.data\[0\] must be an integer between 0 and 255/v});

	const sparseAuthenticationCodeBytes = [];
	sparseAuthenticationCodeBytes.length = 3;
	assert.throws(() => encodeGIF({
		width: 1,
		height: 1,
		globalColorTable: blackWhiteGlobalColorTable,
		blocks: [{
			type: 'applicationExtension',
			identifier: 'APPNAME1',
			authenticationCode: sparseAuthenticationCodeBytes,
		}],
	}), {message: /applicationExtension\.authenticationCode\[0\] must be an integer between 0 and 255/v});

	const sparseColorTable = [];
	sparseColorTable.length = 6;
	assert.throws(() => encodeGIF({
		width: 1,
		height: 1,
		globalColorTable: sparseColorTable,
		blocks: [],
	}), {message: /globalColorTable\[0\] must be an integer between 0 and 255/v});

	const sparseIndexedPixels = [];
	sparseIndexedPixels.length = 1;
	assert.throws(() => encodeGIF({
		width: 1,
		height: 1,
		globalColorTable: blackWhiteGlobalColorTable,
		blocks: [{
			type: 'image',
			width: 1,
			height: 1,
			pixels: sparseIndexedPixels,
		}],
	}), {message: /image\.pixels\[0\] must be an integer between 0 and 255/v});

	const sparseRedGreenBlueAlphaPixels = [];
	sparseRedGreenBlueAlphaPixels.length = 4;
	assert.throws(() => encodeGIF({
		width: 1,
		height: 1,
		blocks: [{
			type: 'rgbaImage',
			width: 1,
			height: 1,
			pixels: sparseRedGreenBlueAlphaPixels,
		}],
	}), {message: /image\.pixels\[0\] must be an integer between 0 and 255/v});
});

test('does not trust custom byte-array iterators while encoding', () => {
	class SpoofedLengthUint8Array extends Uint8Array {
		get length() {
			return 4;
		}
	}

	const sparsePayload = [];
	sparsePayload.length = 1;
	sparsePayload.entries = function * () {};

	assert.throws(() => encodeGIF({
		width: 1,
		height: 1,
		globalColorTable: blackWhiteGlobalColorTable,
		blocks: [{
			type: 'commentExtension',
			data: sparsePayload,
		}],
	}), {message: /commentExtension\.data\[0\] must be an integer between 0 and 255/v});

	const shrinkingPayload = [];
	shrinkingPayload.length = 2;
	Object.defineProperty(shrinkingPayload, 0, {
		get() {
			shrinkingPayload.length = 1;
			return 7;
		},
	});

	assert.throws(() => encodeGIF({
		width: 1,
		height: 1,
		globalColorTable: blackWhiteGlobalColorTable,
		blocks: [{
			type: 'commentExtension',
			data: shrinkingPayload,
		}],
	}), {message: /commentExtension\.data\[1\] must be an integer between 0 and 255/v});

	const typedPayload = Uint8Array.of(65);
	typedPayload.subarray = () => Uint8Array.of(66);
	assert.deepEqual([...decodeGIF(encodeGIF({
		width: 1,
		height: 1,
		globalColorTable: blackWhiteGlobalColorTable,
		blocks: [{
			type: 'commentExtension',
			data: typedPayload,
		}],
	})).blocks[0].data], [65]);

	const typedPayloadWithSpoofedLength = new SpoofedLengthUint8Array([65]);
	assert.deepEqual([...decodeGIF(encodeGIF({
		width: 1,
		height: 1,
		globalColorTable: blackWhiteGlobalColorTable,
		blocks: [{
			type: 'commentExtension',
			data: typedPayloadWithSpoofedLength,
		}],
	})).blocks[0].data], [65]);

	class SpoofedAccessorsUint8Array extends Uint8Array {
		get buffer() {
			return Uint8Array.of(66, 67, 68, 69).buffer;
		}

		get byteOffset() {
			return 1;
		}

		get byteLength() {
			return 4;
		}

		get length() {
			return 4;
		}
	}

	const typedPayloadWithSpoofedAccessors = new SpoofedAccessorsUint8Array([65]);
	assert.deepEqual([...decodeGIF(encodeGIF({
		width: 1,
		height: 1,
		globalColorTable: blackWhiteGlobalColorTable,
		blocks: [{
			type: 'commentExtension',
			data: typedPayloadWithSpoofedAccessors,
		}],
	})).blocks[0].data], [65]);

	class LargeSpoofedLengthUint8Array extends Uint8Array {
		get length() {
			return 100_000_001;
		}
	}

	const typedPayloadWithLargeSpoofedLength = new LargeSpoofedLengthUint8Array([65]);
	assert.deepEqual([...decodeGIF(encodeGIF({
		width: 1,
		height: 1,
		globalColorTable: blackWhiteGlobalColorTable,
		blocks: [{
			type: 'commentExtension',
			data: typedPayloadWithLargeSpoofedLength,
		}],
	})).blocks[0].data], [65]);

	const typedColorTableWithSpoofedLength = new SpoofedLengthUint8Array([0, 0, 0]);
	assert.throws(() => encodeGIF({
		width: 1,
		height: 1,
		globalColorTable: typedColorTableWithSpoofedLength,
		blocks: [],
	}), {message: /globalColorTable must contain between 2 and 256 entries, got 1/v});

	const indexedPixels = new Uint8Array([2]);
	indexedPixels.entries = function * () {
		yield [0, 0];
	};

	assert.throws(() => encodeGIF({
		width: 1,
		height: 1,
		globalColorTable: blackWhiteGlobalColorTable,
		blocks: [{
			type: 'image',
			width: 1,
			height: 1,
			pixels: indexedPixels,
		}],
	}), {message: 'Pixel 0 uses palette index 2, but the active color table only has 2 entries'});

	class SpoofedIndexedPixelsLengthUint8Array extends Uint8Array {
		get length() {
			return 1;
		}
	}

	const indexedPixelsWithSpoofedLength = new SpoofedIndexedPixelsLengthUint8Array([]);
	assert.throws(() => encodeGIF({
		width: 1,
		height: 1,
		globalColorTable: blackWhiteGlobalColorTable,
		blocks: [{
			type: 'image',
			width: 1,
			height: 1,
			pixels: indexedPixelsWithSpoofedLength,
		}],
	}), {message: 'image.pixels length must be 1, got 0'});
});

test('rejects invalid playCount while encoding', () => {
	assert.throws(() => encodeGIF({
		width: 1,
		height: 1,
		globalColorTable: blackWhiteGlobalColorTable,
		playCount: null,
		blocks: [{
			type: 'image',
			width: 1,
			height: 1,
			pixels: [1],
		}],
	}), {message: /playCount must be an integer between 1 and 65536/v});

	assert.throws(() => encodeGIF({
		width: 1,
		height: 1,
		globalColorTable: blackWhiteGlobalColorTable,
		playCount: 0,
		blocks: [{
			type: 'image',
			width: 1,
			height: 1,
			pixels: [1],
		}],
	}), {message: /playCount must be an integer between 1 and 65536/v});

	assert.throws(() => encodeGIF({
		width: 1,
		height: 1,
		globalColorTable: blackWhiteGlobalColorTable,
		loopCount: 0,
		blocks: [{
			type: 'image',
			width: 1,
			height: 1,
			pixels: [1],
		}],
	}), {message: /loopCount has been renamed to playCount/v});
});

test('encodes every valid power-of-two palette size from 2 to 256', () => {
	const palette = Uint8Array.from({length: 256 * 3}, (_, index) => index % 256);
	for (const entryCount of [2, 4, 8, 16, 32, 64, 128, 256]) {
		const globalColorTable = palette.slice(0, entryCount * 3);
		const colorTable = palette.slice((256 - entryCount) * 3);
		const encoded = encodeGIF({
			width: 1,
			height: 1,
			globalColorTable,
			blocks: [
				{
					type: 'image',
					width: 1,
					height: 1,
					pixels: [entryCount - 1],
				},
				{
					type: 'image',
					width: 1,
					height: 1,
					colorTable,
					pixels: [entryCount - 1],
				},
			],
		});
		const decoded = decodeGIF(encoded);
		assert.deepEqual([...decoded.globalColorTable], [...globalColorTable]);
		assert.equal(decoded.imageBlocks[0].colorTable, undefined);
		assert.deepEqual([...decoded.imageBlocks[1].colorTable], [...colorTable]);
	}
});

test('supports all 256 palette indices', () => {
	const colorTable = grayscaleColorTable();
	const indexedPixels = Uint8Array.from({length: 256}, (_, index) => index);
	const decoded = decodeGIF(encodeGIF({
		width: 256,
		height: 1,
		globalColorTable: colorTable,
		blocks: [{
			type: 'image',
			width: 256,
			height: 1,
			pixels: indexedPixels,
		}],
	}));
	assert.deepEqual([...decoded.imageBlocks[0].pixels], [...indexedPixels]);
	assert.deepEqual([...decoded.globalColorTable], [...colorTable]);
});

test('round-trips the small and dense LZW encoder paths', () => {
	for (const pixelCount of [4095, 4096]) {
		const indexedPixels = createRandomIndexedPixels({
			width: pixelCount,
			height: 1,
			colorCount: 16,
			seed: pixelCount,
		});
		const decoded = decodeGIF(encodeGIF({
			width: pixelCount,
			height: 1,
			globalColorTable: colorTableWithEntryCount(16),
			blocks: [{
				type: 'image',
				width: pixelCount,
				height: 1,
				pixels: indexedPixels,
			}],
		}));

		assert.deepEqual([...decoded.imageBlocks[0].pixels], [...indexedPixels]);
	}
});

const largeIndexedImageWidth = 257;
const largeIndexedImageHeight = 257;

function createLargeIndexedImagePixels() {
	return Uint8Array.from({length: largeIndexedImageWidth * largeIndexedImageHeight}, (_, index) => ((index * 73) + (Math.floor(index / largeIndexedImageWidth) * 19) + Math.floor(index / 17)) % 256);
}

function encodeLargeIndexedImageGIF(indexedPixels) {
	return encodeGIF({
		width: largeIndexedImageWidth,
		height: largeIndexedImageHeight,
		globalColorTable: grayscaleColorTable(),
		blocks: [{
			type: 'image',
			width: largeIndexedImageWidth,
			height: largeIndexedImageHeight,
			pixels: indexedPixels,
		}],
	});
}

test('round-trips a large indexed image that grows the LZW dictionary', () => {
	const indexedPixels = createLargeIndexedImagePixels();
	const decoded = decodeGIF(encodeLargeIndexedImageGIF(indexedPixels));
	assert.deepEqual([...decoded.imageBlocks[0].pixels], [...indexedPixels]);
});

test('large indexed image with a full LZW dictionary matches ImageMagick decoding', () => {
	if (!hasImageMagick) {
		return;
	}

	const indexedPixels = createLargeIndexedImagePixels();
	const encoded = encodeLargeIndexedImageGIF(indexedPixels);
	assert.deepEqual(readGifWithImageMagick(writeFile('large-lzw-dictionary-imagemagick.gif', encoded), {
		width: largeIndexedImageWidth,
		height: largeIndexedImageHeight,
	}), [indexedPixelsToGrayscaleRedGreenBlueAlphaPixels(indexedPixels)]);
});

test('round-trips after the LZW dictionary fills and resets', () => {
	const width = 8192;
	const height = 1;
	const indexedPixels = createRandomIndexedPixels({
		width,
		height,
		colorCount: 256,
		seed: 42,
	});
	const encoded = encodeGIF({
		width,
		height,
		globalColorTable: grayscaleColorTable(),
		blocks: [{
			type: 'image',
			width,
			height,
			pixels: indexedPixels,
		}],
	});
	const firstImageData = extractFirstImageData(encoded);
	assert.ok(countLzwClearCodes(firstImageData) > 1);
	assert.deepEqual([...decodeGIF(encoded).imageBlocks[0].pixels], [...indexedPixels]);
});

const randomizedIndexedImageCases = [
	{
		width: 1, height: 1, colorCount: 2, seed: 1, isInterlaced: false,
	},
	{
		width: 2, height: 7, colorCount: 4, seed: 2, isInterlaced: true,
	},
	{
		width: 13, height: 5, colorCount: 8, seed: 3, isInterlaced: false,
	},
	{
		width: 17, height: 19, colorCount: 16, seed: 4, isInterlaced: true,
	},
	{
		width: 31, height: 11, colorCount: 32, seed: 5, isInterlaced: false,
	},
	{
		width: 23, height: 29, colorCount: 64, seed: 6, isInterlaced: true,
	},
	{
		width: 37, height: 17, colorCount: 128, seed: 7, isInterlaced: false,
	},
	{
		width: 29, height: 31, colorCount: 256, seed: 8, isInterlaced: true,
	},
];

test('round-trips deterministic randomized indexed images', () => {
	for (const testCase of randomizedIndexedImageCases) {
		const colorTable = colorTableWithEntryCount(testCase.colorCount);
		const indexedPixels = createRandomIndexedPixels(testCase);
		const encoded = encodeGIF({
			width: testCase.width,
			height: testCase.height,
			globalColorTable: colorTable,
			blocks: [{
				type: 'image',
				width: testCase.width,
				height: testCase.height,
				isInterlaced: testCase.isInterlaced,
				pixels: indexedPixels,
			}],
		});
		const decoded = decodeGIF(encoded);
		assert.equal(decoded.width, testCase.width);
		assert.equal(decoded.height, testCase.height);
		assert.equal(decoded.imageBlocks[0].isInterlaced, testCase.isInterlaced);
		assert.deepEqual([...decoded.imageBlocks[0].pixels], [...indexedPixels]);
	}
});

test('deterministic randomized indexed images match ImageMagick decoding', () => {
	if (!hasImageMagick) {
		return;
	}

	for (const testCase of randomizedIndexedImageCases) {
		const colorTable = colorTableWithEntryCount(testCase.colorCount);
		const indexedPixels = createRandomIndexedPixels(testCase);
		const encoded = encodeGIF({
			width: testCase.width,
			height: testCase.height,
			globalColorTable: colorTable,
			blocks: [{
				type: 'image',
				width: testCase.width,
				height: testCase.height,
				isInterlaced: testCase.isInterlaced,
				pixels: indexedPixels,
			}],
		});
		assert.deepEqual(readGifWithImageMagick(writeFile(`randomized-${testCase.seed}.gif`, encoded), {
			width: testCase.width,
			height: testCase.height,
		}), [indexedPixelsToRedGreenBlueAlphaPixels(indexedPixels, colorTable)]);
	}
});

test('builds an indexed image from RGBA pixels', () => {
	const indexedImage = createIndexedImage(Uint8ClampedArray.from([
		255,
		0,
		0,
		255,
		0,
		0,
		0,
		0,
		0,
		255,
		0,
		255,
		0,
		0,
		0,
		0,
	]));
	assert.equal(indexedImage.transparentColorIndex, 1);
	assert.deepEqual([...indexedImage.pixels], [0, 1, 2, 1]);
	assert.deepEqual([...indexedImage.colorTable], [
		255,
		0,
		0,
		0,
		0,
		0,
		0,
		255,
		0,
		0,
		255,
		0,
	]);
});

test('encodes animated GIFs from RGBA frames with fps, playCount, and quality', () => {
	const encoded = encodeAnimatedGIF([
		Uint8ClampedArray.from(redGreenBlueAlphaPixelBytes(
			[255, 0, 0, 255],
			[0, 255, 0, 255],
		)),
		Uint8ClampedArray.from(redGreenBlueAlphaPixelBytes(
			[0, 0, 255, 255],
			[255, 255, 0, 255],
		)),
	], {
		width: 2,
		height: 1,
		fps: 14,
		playCount: 5,
		quality: 0.7,
	});
	const decoded = decodeGIF(encoded);

	assert.equal(decoded.version, '89a');
	assert.equal(decoded.playCount, 5);
	assert.equal(decoded.imageBlocks.length, 2);
	assert.deepEqual(decoded.imageBlocks.map(imageBlock => imageBlock.graphicControlExtension.delay), [0.07, 0.07]);
	assert.equal(decoded.imageBlocks[0].colorTable.length <= 256 * 3, true);
	assert.equal(decoded.imageBlocks[1].colorTable.length <= 256 * 3, true);
});

test('decodes animated GIFs to RGBA frames with delays', () => {
	const encoded = encodeAnimatedGIF([
		{
			pixels: redGreenBlueAlphaPixelBytes([255, 0, 0, 255]),
			delay: 0.1,
		},
		{
			pixels: redGreenBlueAlphaPixelBytes([0, 255, 0, 255]),
			delay: 0.2,
		},
	], {
		width: 1,
		height: 1,
		playCount: 4,
	});
	const animation = decodeAnimatedGIF(encoded);

	assert.equal(animation.width, 1);
	assert.equal(animation.height, 1);
	assert.equal(animation.playCount, 4);
	assert.deepEqual(animation.frames.map(frame => frame.delay), [0.1, 0.2]);
	assert.deepEqual(animation.frames.map(frame => [...frame.pixels]), [
		[255, 0, 0, 255],
		[0, 255, 0, 255],
	]);
	assert.equal(animation.frames[0].pixels instanceof Uint8ClampedArray, true);
});

test('decodes animated GIFs with transparent background by default', () => {
	const encoded = encodeGIF({
		width: 1,
		height: 1,
		globalColorTable: blackWhiteGlobalColorTable,
		backgroundColorIndex: 1,
		blocks: [{
			type: 'rgbaImage',
			width: 1,
			height: 1,
			pixels: redGreenBlueAlphaPixelBytes([0, 0, 0, 0]),
		}],
	});

	assert.deepEqual([...decodeAnimatedGIF(encoded).frames[0].pixels], [0, 0, 0, 0]);
	assert.deepEqual([...decodeAnimatedGIF(encoded, {background: 'gif'}).frames[0].pixels], [255, 255, 255, 255]);
});

test('decodeAnimatedGIF ignores unsupported initialPixels option', () => {
	const encoded = encodeGIF({
		width: 2,
		height: 1,
		globalColorTable: blackRedGreenBlueGlobalColorTable,
		blocks: [{
			type: 'image',
			width: 1,
			height: 1,
			pixels: [1],
		}],
	});
	const animation = decodeAnimatedGIF(encoded, {
		initialPixels: redGreenBlueAlphaPixelBytes(
			[0, 255, 0, 255],
			[0, 255, 0, 255],
		),
	});

	assert.deepEqual([...animation.frames[0].pixels], redGreenBlueAlphaPixelBytes(
		[255, 0, 0, 255],
		[0, 0, 0, 0],
	));
});

test('decodes animated GIFs with invalid transparent color indexes loosely', () => {
	const gif = minimalGifBytes({
		beforeImage: graphicControlExtensionBytes({
			packedField: 0b0000_0001,
			transparentColorIndex: 2,
		}),
		imageData: imageDataFromLzwCodes({
			codeSequence: [
				4,
				2,
				5,
			],
			minimumCodeSize: 2,
		}),
	});
	const animation = decodeAnimatedGIF(gif, {strict: false});

	assert.deepEqual([...animation.frames[0].pixels], [0, 0, 0, 0]);
});

test('encodes animated GIFs with per-frame delays', () => {
	const encoded = encodeAnimatedGIF([
		{
			pixels: redGreenBlueAlphaPixelBytes([255, 0, 0, 255]),
			delay: 0.1,
		},
		{
			pixels: redGreenBlueAlphaPixelBytes([0, 255, 0, 255]),
			delay: 0.2,
		},
	], {
		width: 1,
		height: 1,
		playCount: 2,
		quality: 0.7,
	});
	const decoded = decodeGIF(encoded);

	assert.equal(decoded.playCount, 2);
	assert.deepEqual(decoded.imageBlocks.map(imageBlock => imageBlock.graphicControlExtension.delay), [0.1, 0.2]);
});

test('encodes animated GIF frame objects with Uint8ClampedArray pixels', () => {
	const encoded = encodeAnimatedGIF([
		{
			pixels: Uint8ClampedArray.from(redGreenBlueAlphaPixelBytes(
				[255, 0, 0, 255],
				[0, 0, 0, 0],
			)),
			delay: 0.12,
		},
	], {
		width: 2,
		height: 1,
		quality: 0.7,
	});
	const decoded = decodeGIF(encoded);

	assert.equal(decoded.imageBlocks[0].graphicControlExtension.delay, 0.12);
	assert.equal(decoded.imageBlocks[0].graphicControlExtension.transparentColorIndex, 1);
	assert.deepEqual([...renderGIFFrames(decoded, {background: 'transparent'}).frames[0].pixels], [
		255,
		0,
		0,
		255,
		0,
		0,
		0,
		0,
	]);
});

test('encodes animated GIFs with zero-delay frames', () => {
	const encoded = encodeAnimatedGIF([
		{
			pixels: Uint8ClampedArray.from(redGreenBlueAlphaPixelBytes([255, 0, 0, 255])),
			delay: 0,
		},
	], {
		width: 1,
		height: 1,
	});
	const decoded = decodeAnimatedGIF(encoded);

	assert.equal(decoded.frames[0].delay, 0);
});

test('round-trips the maximum frame delay without precision loss', () => {
	// 655.35 seconds is exactly 65535 hundredths, the largest delay GIF can store. Math.round(655.35 * 100) must land on 65535, not 65534.
	const decoded = decodeAnimatedGIF(encodeAnimatedGIF([
		{
			pixels: redGreenBlueAlphaPixelBytes([1, 2, 3, 255]),
			delay: 655.35,
		},
	], {
		width: 1,
		height: 1,
	}));

	assert.equal(decoded.frames[0].delay, 655.35);
});

test('encodes animated GIFs with exact colors when quality is 1', () => {
	const encoded = encodeAnimatedGIF([
		Uint8ClampedArray.from(redGreenBlueAlphaPixelBytes(
			[12, 34, 56, 255],
			[78, 90, 123, 255],
		)),
	], {
		width: 2,
		height: 1,
		fps: 10,
		quality: 1,
	});
	const rendered = renderGIFFrames(decodeGIF(encoded));

	assert.deepEqual([...rendered.frames[0].pixels], redGreenBlueAlphaPixelBytes(
		[12, 34, 56, 255],
		[78, 90, 123, 255],
	));
});

test('encodes animated GIFs with quantized colors by default', () => {
	const pixels = [];
	for (let index = 0; index < 257; index += 1) {
		pixels.push(index & 0xFF, index >> 8, index % 251, 255);
	}

	const encoded = encodeAnimatedGIF([
		Uint8ClampedArray.from(pixels),
	], {
		width: 257,
		height: 1,
		fps: 10,
	});
	const decoded = decodeGIF(encoded);

	assert.equal(decoded.imageBlocks[0].colorTable.length <= 256 * 3, true);
});

test('encodes animated GIF transparency when quantizing', () => {
	const encoded = encodeAnimatedGIF([
		Uint8ClampedArray.from(redGreenBlueAlphaPixelBytes(
			[200, 10, 10, 255],
			[10, 200, 10, 0],
		)),
	], {
		width: 2,
		height: 1,
		fps: 10,
		quality: 0,
	});
	const decoded = decodeGIF(encoded);
	const rendered = renderGIFFrames(decoded, {background: 'transparent'});

	assert.notEqual(decoded.imageBlocks[0].graphicControlExtension.transparentColorIndex, undefined);
	assert.equal(rendered.frames[0].pixels[3], 255);
	assert.equal(rendered.frames[0].pixels[7], 0);
});

test('rejects mixed animated GIF timing options', () => {
	assert.throws(() => encodeAnimatedGIF([
		{
			pixels: redGreenBlueAlphaPixelBytes([255, 0, 0, 255]),
			delay: 0.1,
		},
	], {
		width: 1,
		height: 1,
		fps: 10,
	}), {message: /fps cannot be combined/v});

	assert.throws(() => encodeAnimatedGIF([
		Uint8ClampedArray.from(redGreenBlueAlphaPixelBytes([255, 0, 0, 255])),
	], {
		width: 1,
		height: 1,
	}), {message: /fps is required/v});

	assert.throws(() => encodeAnimatedGIF([
		Uint8ClampedArray.from(redGreenBlueAlphaPixelBytes([255, 0, 0, 255])),
	], {
		width: 1,
		height: 1,
		fps: 0,
	}), {message: /fps must be a number greater than 0/v});

	assert.throws(() => encodeAnimatedGIF([
		Uint8ClampedArray.from(redGreenBlueAlphaPixelBytes([255, 0, 0, 255])),
	], {
		width: 1,
		height: 1,
		fps: 10,
		quality: 2,
	}), {message: /quality must be a number between 0 and 1/v});

	assert.throws(() => encodeAnimatedGIF([
		{
			delay: 0.1,
		},
	], {
		width: 1,
		height: 1,
	}), {message: /frames\[0\] must be a Uint8Array, Uint8ClampedArray, or array of bytes/v});

	assert.throws(() => encodeAnimatedGIF([
		{
			pixels: Uint8ClampedArray.from(redGreenBlueAlphaPixelBytes([255, 0, 0, 255])),
			delay: -1,
		},
	], {
		width: 1,
		height: 1,
	}), {message: /frames\[0\]\.delay must be a number between 0 and 655.35/v});

	assert.throws(() => encodeAnimatedGIF([
		Uint8ClampedArray.from(redGreenBlueAlphaPixelBytes([255, 0, 0, 255])),
	], {
		width: 1,
		height: 1,
		fps: 10,
		playCount: null,
	}), {message: /playCount must be an integer between 1 and 65536/v});

	assert.throws(() => encodeAnimatedGIF([
		Uint8ClampedArray.from(redGreenBlueAlphaPixelBytes([255, 0, 0, 255])),
	], {
		width: 1,
		height: 1,
		fps: 10,
		loopCount: 0,
	}), {message: /loopCount has been renamed to playCount/v});
});

test('builds an indexed image for one opaque color', () => {
	const indexedImage = createIndexedImage(Uint8ClampedArray.from([
		12,
		34,
		56,
		255,
		12,
		34,
		56,
		255,
	]));

	assert.equal(indexedImage.transparentColorIndex, undefined);
	assert.deepEqual([...indexedImage.pixels], [0, 0]);
	assert.deepEqual([...indexedImage.colorTable], [
		12,
		34,
		56,
		12,
		34,
		56,
	]);
});

test('builds an indexed image for only transparent pixels', () => {
	const indexedImage = createIndexedImage(Uint8ClampedArray.from([
		9,
		8,
		7,
		0,
		1,
		2,
		3,
		0,
	]), {
		transparentColor: [4, 5, 6],
	});

	assert.equal(indexedImage.transparentColorIndex, 0);
	assert.deepEqual([...indexedImage.pixels], [0, 0]);
	assert.deepEqual([...indexedImage.colorTable], [
		4,
		5,
		6,
		4,
		5,
		6,
	]);
});

test('encodes transparent RGBA pixels with transparency metadata', () => {
	const encoded = encodeGIF({
		width: 2,
		height: 1,
		blocks: [{
			type: 'rgbaImage',
			width: 2,
			height: 1,
			pixels: redGreenBlueAlphaPixelBytes(
				[255, 0, 0, 255],
				[0, 0, 0, 0],
			),
		}],
	});
	const decoded = decodeGIF(encoded);

	assert.deepEqual([...encoded.slice(0, 6)], [...gifSignature, ...gif89aVersion]);
	assert.equal(countGraphicControlExtensionBlocks(encoded), 1);
	assert.deepEqual(extractGraphicControlExtensionPackets(encoded), [[
		0x21,
		0xF9,
		0x04,
		0x01,
		0x00,
		0x00,
		0x01,
		0x00,
	]]);
	assert.equal(decoded.imageBlocks[0].graphicControlExtension.transparentColorIndex, 1);
	assert.deepEqual([...renderGIFFrames(decoded, {background: 'transparent'}).frames[0].pixels], [
		255,
		0,
		0,
		255,
		0,
		0,
		0,
		0,
	]);
});

test('uses intrinsic RGBA typed array length for transparency detection', () => {
	class SpoofedLengthUint8Array extends Uint8Array {
		get length() {
			return 0;
		}
	}

	const encoded = encodeGIF({
		width: 1,
		height: 1,
		blocks: [{
			type: 'rgbaImage',
			width: 1,
			height: 1,
			pixels: new SpoofedLengthUint8Array([0, 0, 0, 0]),
		}],
	});
	const decoded = decodeGIF(encoded);

	assert.deepEqual([...encoded.slice(0, 6)], [...gifSignature, ...gif89aVersion]);
	assert.equal(decoded.imageBlocks[0].graphicControlExtension.transparentColorIndex, 0);
});

test('preserves explicit graphic control metadata when RGBA pixels add transparency', () => {
	const decoded = decodeGIF(encodeGIF({
		width: 2,
		height: 1,
		blocks: [{
			type: 'rgbaImage',
			width: 2,
			height: 1,
			graphicControlExtension: {
				disposalMethod: 'restoreBackground',
				delay: 0.13,
			},
			pixels: redGreenBlueAlphaPixelBytes(
				[0, 0, 255, 255],
				[0, 0, 0, 0],
			),
		}],
	}));

	assert.deepEqual(decoded.imageBlocks[0].graphicControlExtension, {
		disposalMethod: 'restoreBackground',
		delay: 0.13,
		transparentColorIndex: 1,
	});
});

test('RGBA pixels own encoded transparency metadata', () => {
	const decoded = decodeGIF(encodeGIF({
		width: 1,
		height: 1,
		blocks: [{
			type: 'rgbaImage',
			width: 1,
			height: 1,
			graphicControlExtension: {
				disposalMethod: 'restoreBackground',
				delay: 0.13,
				transparentColorIndex: 0,
			},
			pixels: redGreenBlueAlphaPixelBytes([255, 0, 0, 255]),
		}],
	}));
	const rendered = renderGIFFrames(decoded, {background: 'transparent'});

	assert.deepEqual(decoded.imageBlocks[0].graphicControlExtension, {
		disposalMethod: 'restoreBackground',
		delay: 0.13,
		transparentColorIndex: undefined,
	});
	assert.deepEqual([...rendered.frames[0].pixels], [
		255,
		0,
		0,
		255,
	]);
});

test('encodes multiple transparent RGBA images with separate graphic control extensions', () => {
	const encoded = encodeGIF({
		width: 2,
		height: 1,
		blocks: [
			{
				type: 'rgbaImage',
				width: 1,
				height: 1,
				graphicControlExtension: {
					delay: 0.04,
				},
				pixels: redGreenBlueAlphaPixelBytes([0, 0, 0, 0]),
			},
			{
				type: 'rgbaImage',
				left: 1,
				width: 1,
				height: 1,
				graphicControlExtension: {
					delay: 0.09,
				},
				pixels: redGreenBlueAlphaPixelBytes([255, 0, 0, 0]),
			},
		],
	});
	const decoded = decodeGIF(encoded);

	assert.equal(countGraphicControlExtensionBlocks(encoded), 2);
	assert.equal(decoded.imageBlocks[0].graphicControlExtension.delay, 0.04);
	assert.equal(decoded.imageBlocks[1].graphicControlExtension.delay, 0.09);
	assert.equal(decoded.imageBlocks[0].graphicControlExtension.transparentColorIndex, 0);
	assert.equal(decoded.imageBlocks[1].graphicControlExtension.transparentColorIndex, 0);
});

test('does not leak generated RGBA transparency across image blocks', () => {
	const decoded = decodeGIF(encodeGIF({
		width: 2,
		height: 1,
		blocks: [
			{
				type: 'rgbaImage',
				width: 1,
				height: 1,
				pixels: redGreenBlueAlphaPixelBytes([0, 0, 0, 0]),
			},
			{
				type: 'image',
				left: 1,
				width: 1,
				height: 1,
				colorTable: blackWhiteGlobalColorTable,
				pixels: [1],
			},
		],
	}));

	assert.equal(decoded.imageBlocks[0].graphicControlExtension.transparentColorIndex, 0);
	assert.equal(decoded.imageBlocks[1].graphicControlExtension, undefined);
});

test('encodes explicit RGBA graphic control fields into the generated extension', () => {
	const encoded = encodeGIF({
		width: 1,
		height: 1,
		blocks: [{
			type: 'rgbaImage',
			width: 1,
			height: 1,
			graphicControlExtension: {
				disposalMethod: 'restorePrevious',
				delay: 5.13,
			},
			pixels: redGreenBlueAlphaPixelBytes([0, 0, 0, 0]),
		}],
	});

	assert.deepEqual(extractGraphicControlExtensionPackets(encoded), [[
		0x21,
		0xF9,
		0x04,
		0b0000_1101,
		0x01,
		0x02,
		0x00,
		0x00,
	]]);
});

test('counts graphic control extensions across mixed extension and image blocks', () => {
	const encoded = encodeGIF({
		width: 1,
		height: 1,
		globalColorTable: blackWhiteGlobalColorTable,
		blocks: [
			{
				type: 'commentExtension',
				data: Uint8Array.from([0x21, 0xF9, 0x04]),
			},
			{
				type: 'applicationExtension',
				identifier: 'APPNAME1',
				authenticationCode: '123',
				data: Uint8Array.from([0x21, 0xF9]),
			},
			{
				type: 'image',
				width: 1,
				height: 1,
				graphicControlExtension: {
					delay: 0.01,
				},
				pixels: [1],
			},
			{
				type: 'rgbaImage',
				width: 1,
				height: 1,
				pixels: redGreenBlueAlphaPixelBytes([0, 0, 0, 0]),
			},
		],
	});

	assert.equal(countGraphicControlExtensionBlocks(encoded), 2);
});

test('uses transparentColor for the transparent RGBA palette entry', () => {
	const indexedImage = createIndexedImage(Uint8ClampedArray.from([
		0,
		0,
		0,
		0,
	]), {
		transparentColor: [7, 8, 9],
	});

	assert.equal(indexedImage.transparentColorIndex, 0);
	assert.deepEqual([...indexedImage.colorTable.slice(0, 3)], [
		7,
		8,
		9,
	]);
});

test('uses image transparentColor option when encoding RGBA pixels', () => {
	const decoded = decodeGIF(encodeGIF({
		width: 1,
		height: 1,
		blocks: [{
			type: 'rgbaImage',
			width: 1,
			height: 1,
			transparentColor: [11, 22, 33],
			pixels: redGreenBlueAlphaPixelBytes([0, 0, 0, 0]),
		}],
	}));

	assert.deepEqual([...decoded.imageBlocks[0].colorTable.slice(0, 3)], [
		11,
		22,
		33,
	]);
	assert.equal(decoded.imageBlocks[0].graphicControlExtension.transparentColorIndex, 0);
});

test('ignores transparentColor when indexed pixels are present', () => {
	const decoded = decodeGIF(encodeGIF({
		width: 1,
		height: 1,
		globalColorTable: blackWhiteGlobalColorTable,
		blocks: [{
			type: 'image',
			width: 1,
			height: 1,
			transparentColor: [11, 22, 33],
			pixels: [1],
		}],
	}));

	assert.equal(decoded.imageBlocks[0].colorTable, undefined);
	assert.equal(decoded.imageBlocks[0].graphicControlExtension, undefined);
});

test('rejects invalid transparentColor while encoding RGBA pixels', () => {
	assert.throws(() => encodeGIF({
		width: 1,
		height: 1,
		blocks: [{
			type: 'rgbaImage',
			width: 1,
			height: 1,
			transparentColor: [0, 0, 256],
			pixels: redGreenBlueAlphaPixelBytes([0, 0, 0, 0]),
		}],
	}), {message: /transparentColor/v});
});

test('keeps transparent and opaque pixels separate when their RGB bytes match', () => {
	const indexedImage = createIndexedImage(Uint8ClampedArray.from(redGreenBlueAlphaPixelBytes(
		[1, 2, 3, 0],
		[1, 2, 3, 255],
	)), {
		transparentColor: [1, 2, 3],
	});

	assert.equal(indexedImage.transparentColorIndex, 0);
	assert.deepEqual([...indexedImage.pixels], [0, 1]);
	assert.deepEqual([...indexedImage.colorTable], [
		1,
		2,
		3,
		1,
		2,
		3,
	]);
});

test('reuses one transparent palette index for multiple transparent RGB values', () => {
	const indexedImage = createIndexedImage(Uint8ClampedArray.from(redGreenBlueAlphaPixelBytes(
		[255, 0, 0, 0],
		[0, 255, 0, 0],
		[0, 0, 255, 255],
	)));

	assert.equal(indexedImage.transparentColorIndex, 0);
	assert.deepEqual([...indexedImage.pixels], [0, 0, 1]);
});

test('accepts Uint8Array RGBA input', () => {
	const indexedImage = createIndexedImage(Uint8Array.from(redGreenBlueAlphaPixelBytes(
		[5, 6, 7, 255],
		[0, 0, 0, 0],
	)));

	assert.deepEqual([...indexedImage.pixels], [0, 1]);
	assert.equal(indexedImage.transparentColorIndex, 1);
});

test('encodes array RGBA input', () => {
	const decoded = decodeGIF(encodeGIF({
		width: 2,
		height: 1,
		blocks: [{
			type: 'rgbaImage',
			width: 2,
			height: 1,
			pixels: redGreenBlueAlphaPixelBytes(
				[8, 9, 10, 255],
				[0, 0, 0, 0],
			),
		}],
	}));

	assert.deepEqual([...decoded.imageBlocks[0].pixels], [0, 1]);
	assert.equal(decoded.imageBlocks[0].graphicControlExtension.transparentColorIndex, 1);
});

test('renders multiple RGBA frames after encode and decode', () => {
	const encoded = encodeGIF({
		width: 2,
		height: 1,
		blocks: [
			{
				type: 'rgbaImage',
				width: 2,
				height: 1,
				pixels: redGreenBlueAlphaPixelBytes(
					[255, 0, 0, 255],
					[0, 0, 0, 0],
				),
			},
			{
				type: 'rgbaImage',
				width: 2,
				height: 1,
				pixels: redGreenBlueAlphaPixelBytes(
					[0, 0, 0, 0],
					[0, 255, 0, 255],
				),
			},
		],
	});
	const rendered = renderGIFFrames(decodeGIF(encoded), {background: 'transparent'});

	assert.deepEqual(rendered.frames.map(frame => [...frame.pixels]), [
		[
			255,
			0,
			0,
			255,
			0,
			0,
			0,
			0,
		],
		[
			255,
			0,
			0,
			255,
			0,
			255,
			0,
			255,
		],
	]);
});

test('renders RGBA image blocks after encode and decode', () => {
	const encoded = encodeGIF({
		width: 2,
		height: 1,
		blocks: [{
			type: 'rgbaImage',
			width: 2,
			height: 1,
			pixels: redGreenBlueAlphaPixelBytes(
				[255, 0, 0, 255],
				[0, 0, 0, 0],
			),
		}],
	});
	const rendered = renderGIFFrames(decodeGIF(encoded), {background: 'transparent'});

	assert.deepEqual([...rendered.frames[0].pixels], [
		255,
		0,
		0,
		255,
		0,
		0,
		0,
		0,
	]);
});

test('renders RGBA frame metadata and disposal after encode and decode', () => {
	const encoded = encodeGIF({
		width: 2,
		height: 1,
		blocks: [
			{
				type: 'rgbaImage',
				width: 2,
				height: 1,
				graphicControlExtension: {
					disposalMethod: 'restoreBackground',
					delay: 0.05,
				},
				pixels: redGreenBlueAlphaPixelBytes(
					[255, 0, 0, 255],
					[0, 0, 0, 0],
				),
			},
			{
				type: 'rgbaImage',
				left: 1,
				width: 1,
				height: 1,
				pixels: redGreenBlueAlphaPixelBytes([0, 255, 0, 255]),
			},
		],
	});
	const rendered = renderGIFFrames(decodeGIF(encoded), {background: 'transparent'});

	assert.equal(rendered.frames[0].delay, 0.05);
	assert.equal(rendered.frames[0].disposalMethod, 'restoreBackground');
	assert.deepEqual(rendered.frames.map(frame => [...frame.pixels]), [
		[
			255,
			0,
			0,
			255,
			0,
			0,
			0,
			0,
		],
		[
			0,
			0,
			0,
			0,
			0,
			255,
			0,
			255,
		],
	]);
});

test('renders RGBA disposal to transparent background after encode and decode', () => {
	const encoded = encodeGIF({
		width: 2,
		height: 1,
		blocks: [
			{
				type: 'rgbaImage',
				width: 2,
				height: 1,
				graphicControlExtension: {
					disposalMethod: 'restoreBackground',
				},
				pixels: redGreenBlueAlphaPixelBytes(
					[255, 0, 0, 255],
					[0, 0, 0, 0],
				),
			},
			{
				type: 'rgbaImage',
				left: 1,
				width: 1,
				height: 1,
				pixels: redGreenBlueAlphaPixelBytes([0, 255, 0, 255]),
			},
		],
	});
	const rendered = renderGIFFrames(decodeGIF(encoded), {background: 'transparent'});

	assert.deepEqual(rendered.frames.map(frame => [...frame.pixels]), [
		[
			255,
			0,
			0,
			255,
			0,
			0,
			0,
			0,
		],
		[
			0,
			0,
			0,
			0,
			0,
			255,
			0,
			255,
		],
	]);
});

test('rejects RGBA arrays with non-byte entries', () => {
	assert.throws(() => encodeGIF({
		width: 1,
		height: 1,
		blocks: [{
			type: 'rgbaImage',
			width: 1,
			height: 1,
			pixels: [0, 0, 0, 300],
		}],
	}), {message: /image\.pixels\[3\]/v});
});

test('rejects RGBA input with a mismatched length while encoding', () => {
	assert.throws(() => encodeGIF({
		width: 2,
		height: 1,
		blocks: [{
			type: 'rgbaImage',
			width: 2,
			height: 1,
			pixels: [0, 0, 0, 255],
		}],
	}), {message: /image\.pixels length must be 8/v});
});

test('rejects null RGBA input through normal validation while encoding', () => {
	assert.throws(() => encodeGIF({
		width: 1,
		height: 1,
		blocks: [{
			type: 'rgbaImage',
			width: 1,
			height: 1,
			pixels: null,
		}],
	}), {message: /image\.pixels must be a Uint8Array, Uint8ClampedArray, or array of bytes/v});
});

test('rejects RGBA input with a non-RGBA byte length', () => {
	assert.throws(() => createIndexedImage(Uint8ClampedArray.from([
		0,
		0,
		0,
	])), {message: /length must be divisible by 4/v});
});

test('rejects empty RGBA input', () => {
	assert.throws(() => createIndexedImage(new Uint8ClampedArray()), {message: /at least one entry/v});
});

test('rejects RGBA input with partial alpha', () => {
	assert.throws(() => createIndexedImage(Uint8ClampedArray.from([
		0, 0, 0, 128,
	])), {message: /only supports fully transparent or fully opaque/v});
});

test('rejects RGBA input with more than 256 palette entries', () => {
	const pixels = new Uint8ClampedArray(257 * 4);
	for (let index = 0; index < 257; index += 1) {
		const offset = index * 4;
		pixels[offset] = index;
		pixels[offset + 1] = index >> 1;
		pixels[offset + 2] = index >> 2;
		pixels[offset + 3] = 255;
	}

	assert.throws(() => createIndexedImage(pixels), {message: /more than 256 palette entries/v});
});

test('builds indexed images with 256 opaque colors', () => {
	const pixels = new Uint8ClampedArray(256 * 4);
	for (let index = 0; index < 256; index += 1) {
		const offset = index * 4;
		pixels[offset] = index;
		pixels[offset + 1] = index ^ 0x55;
		pixels[offset + 2] = 255 - index;
		pixels[offset + 3] = 255;
	}

	const indexedImage = createIndexedImage(pixels);
	const expectedColorTable = [];
	for (let index = 0; index < 256; index += 1) {
		expectedColorTable.push(index, index ^ 0x55, 255 - index);
	}

	assert.equal(indexedImage.colorTable.length, 256 * 3);
	assert.equal(indexedImage.transparentColorIndex, undefined);
	assert.deepEqual([...indexedImage.pixels], Array.from({length: 256}, (_, index) => index));
	assert.deepEqual([...indexedImage.colorTable], expectedColorTable);
});

test('builds indexed images with 255 opaque colors and transparency', () => {
	const pixels = new Uint8ClampedArray(256 * 4);
	for (let index = 0; index < 255; index += 1) {
		const offset = index * 4;
		pixels[offset] = index;
		pixels[offset + 1] = index ^ 0x55;
		pixels[offset + 2] = 255 - index;
		pixels[offset + 3] = 255;
	}

	pixels[(255 * 4) + 3] = 0;
	const indexedImage = createIndexedImage(pixels);
	assert.equal(indexedImage.transparentColorIndex, 255);
	assert.equal(indexedImage.colorTable.length, 256 * 3);
	assert.deepEqual([...indexedImage.pixels.slice(253)], [253, 254, 255]);
});

test('rejects RGBA input with 256 opaque colors and transparency', () => {
	const pixels = new Uint8ClampedArray(257 * 4);
	for (let index = 0; index < 256; index += 1) {
		const offset = index * 4;
		pixels[offset] = index;
		pixels[offset + 1] = index ^ 0x55;
		pixels[offset + 2] = 255 - index;
		pixels[offset + 3] = 255;
	}

	pixels[(256 * 4) + 3] = 0;
	assert.throws(() => createIndexedImage(pixels), {message: /cannot exceed 256 entries/v});
});

test('rejects invalid transparent color options in RGBA input', () => {
	assert.throws(() => createIndexedImage(Uint8ClampedArray.from([
		0,
		0,
		0,
		0,
	]), {
		transparentColor: [0, 0, 256],
	}), {message: /transparentColor\[2\] must be an integer between 0 and 255/v});
});

function createDisposalMethod3AnimationGIF() {
	return encodeGIF({
		width: 3,
		height: 2,
		globalColorTable: Uint8Array.from([
			0,
			0,
			0,
			255,
			0,
			0,
			0,
			255,
			0,
			0,
			0,
			255,
		]),
		playCount: 'forever',
		blocks: [
			{
				type: 'commentExtension',
				data: 'hello',
			},
			{
				type: 'applicationExtension',
				identifier: 'APPNAME1',
				authenticationCode: '123',
				data: Uint8Array.from([9, 8, 7]),
			},
			{
				type: 'image',
				width: 3,
				height: 2,
				graphicControlExtension: {
					delay: 0.05,
					disposalMethod: 'keep',
				},
				pixels: Uint8Array.from([
					1,
					1,
					1,
					1,
					1,
					1,
				]),
			},
			{
				type: 'image',
				left: 0,
				top: 0,
				width: 1,
				height: 1,
				graphicControlExtension: {
					delay: 0.06,
					disposalMethod: 'restorePrevious',
				},
				pixels: Uint8Array.from([3]),
			},
			{
				type: 'image',
				left: 1,
				top: 0,
				width: 1,
				height: 1,
				graphicControlExtension: {
					delay: 0.07,
					disposalMethod: 'keep',
				},
				pixels: Uint8Array.from([2]),
			},
		],
	});
}

test('encodes animation metadata and renders disposal method 3', () => {
	const encoded = createDisposalMethod3AnimationGIF();
	const decoded = decodeGIF(encoded);
	assert.equal(decoded.version, '89a');
	assert.equal(decoded.playCount, 'forever');
	assert.equal(decoded.blocks[0].type, 'applicationExtension');
	assert.equal(decoded.blocks[1].type, 'commentExtension');
	assert.equal(decoded.blocks[2].type, 'applicationExtension');
	assert.equal(decoded.imageBlocks.length, 3);

	const rendered = renderGIFFrames(decoded);
	assert.equal(rendered.frames[0].disposalMethod, 'keep');
	assert.equal(rendered.frames[0].delay, 0.05);
	assert.equal(rendered.frames[1].disposalMethod, 'restorePrevious');
	assert.equal(rendered.frames[1].delay, 0.06);
	assert.equal(rendered.frames[1].left, 0);
	assert.equal(rendered.frames[1].top, 0);
	assert.equal(rendered.frames[1].width, 1);
	assert.equal(rendered.frames[1].height, 1);
	assert.equal(rendered.frames[2].disposalMethod, 'keep');
	assert.equal(rendered.frames[2].delay, 0.07);
	assert.equal(rendered.frames[2].left, 1);
	assert.equal(rendered.frames[2].top, 0);
	assert.equal(rendered.frames[2].width, 1);
	assert.equal(rendered.frames[2].height, 1);
	assert.deepEqual([...rendered.frames[0].pixels], [
		255,
		0,
		0,
		255,
		255,
		0,
		0,
		255,
		255,
		0,
		0,
		255,
		255,
		0,
		0,
		255,
		255,
		0,
		0,
		255,
		255,
		0,
		0,
		255,
	]);
	assert.deepEqual([...rendered.frames[1].pixels], [
		0,
		0,
		255,
		255,
		255,
		0,
		0,
		255,
		255,
		0,
		0,
		255,
		255,
		0,
		0,
		255,
		255,
		0,
		0,
		255,
		255,
		0,
		0,
		255,
	]);
	assert.deepEqual([...rendered.frames[2].pixels], [
		255,
		0,
		0,
		255,
		0,
		255,
		0,
		255,
		255,
		0,
		0,
		255,
		255,
		0,
		0,
		255,
		255,
		0,
		0,
		255,
		255,
		0,
		0,
		255,
	]);
});

test('disposal method 3 animation matches Pillow decoding', () => {
	if (!hasPillow) {
		return;
	}

	const encoded = createDisposalMethod3AnimationGIF();
	const rendered = renderGIFFrames(decodeGIF(encoded));
	const pillow = readGifWithPillow(writeFile('animated-restore-previous.gif', encoded));
	assert.equal(pillow.loop, 0);
	assert.equal(pillow.frames.length, 3);
	assert.deepEqual(pillow.frames, rendered.frames.map(frame => [...frame.pixels]));
});

test('disposal method 3 animation matches ImageMagick decoding', () => {
	if (!hasImageMagick) {
		return;
	}

	const encoded = createDisposalMethod3AnimationGIF();
	const rendered = renderGIFFrames(decodeGIF(encoded));
	assert.deepEqual(readGifWithImageMagick(writeFile('animated-restore-previous-imagemagick.gif', encoded), {
		width: 3,
		height: 2,
	}), rendered.frames.map(frame => [...frame.pixels]));
});

function createDisposalMethod2TransparentAnimationGIF() {
	return encodeGIF({
		width: 3,
		height: 2,
		globalColorTable: Uint8Array.from([
			0,
			0,
			0,
			255,
			0,
			0,
			0,
			255,
			0,
			0,
			0,
			255,
		]),
		blocks: [
			{
				type: 'image',
				width: 3,
				height: 2,
				graphicControlExtension: {
					delay: 0.01,
					disposalMethod: 'keep',
				},
				pixels: Uint8Array.from([
					1,
					1,
					1,
					1,
					1,
					1,
				]),
			},
			{
				type: 'image',
				left: 1,
				top: 0,
				width: 1,
				height: 2,
				graphicControlExtension: {
					delay: 0.01,
					disposalMethod: 'restoreBackground',
				},
				pixels: Uint8Array.from([3, 3]),
			},
			{
				type: 'rgbaImage',
				left: 1,
				top: 0,
				width: 1,
				height: 2,
				graphicControlExtension: {
					delay: 0.01,
					disposalMethod: 'keep',
				},
				pixels: Uint8ClampedArray.from([
					0,
					255,
					0,
					255,
					0,
					0,
					0,
					0,
				]),
			},
		],
	});
}

test('renders disposal method 2 with transparent pixels', () => {
	const rendered = renderGIFFrames(decodeGIF(createDisposalMethod2TransparentAnimationGIF()));
	assert.deepEqual([...rendered.frames[2].pixels], [
		255,
		0,
		0,
		255,
		0,
		255,
		0,
		255,
		255,
		0,
		0,
		255,
		255,
		0,
		0,
		255,
		0,
		0,
		0,
		255,
		255,
		0,
		0,
		255,
	]);
});

test('disposal method 2 transparent animation matches Pillow decoding', () => {
	if (!hasPillow) {
		return;
	}

	const encoded = createDisposalMethod2TransparentAnimationGIF();
	const rendered = renderGIFFrames(decodeGIF(encoded));
	const pillow = readGifWithPillow(writeFile('animated-disposal-2.gif', encoded));
	assert.deepEqual(pillow.frames, rendered.frames.map(frame => [...frame.pixels]));
});

test('disposal method 2 transparent animation matches ImageMagick decoding', () => {
	if (!hasImageMagick) {
		return;
	}

	const encoded = createDisposalMethod2TransparentAnimationGIF();
	const rendered = renderGIFFrames(decodeGIF(encoded));
	const imageMagickFrames = readGifWithImageMagick(writeFile('animated-disposal-2-imagemagick.gif', encoded), {
		width: 3,
		height: 2,
	});
	assert.deepEqual(imageMagickFrames.map(frame => extractRedGreenBluePixels(frame)), rendered.frames.map(frame => extractRedGreenBluePixels([...frame.pixels])));
});

test('renders local palette colors without changing later global-palette frames', () => {
	const encoded = encodeGIF({
		width: 2,
		height: 1,
		globalColorTable: rgbColorTable([0, 0, 0], [255, 0, 0]),
		blocks: [
			{
				type: 'image',
				width: 1,
				height: 1,
				colorTable: rgbColorTable([0, 0, 0], [0, 0, 255]),
				pixels: [1],
			},
			{
				type: 'image',
				left: 1,
				top: 0,
				width: 1,
				height: 1,
				pixels: [1],
			},
		],
	});
	const rendered = renderGIFFrames(decodeGIF(encoded));
	assert.deepEqual([...rendered.frames[0].pixels], [
		0,
		0,
		255,
		255,
		0,
		0,
		0,
		255,
	]);
	assert.deepEqual([...rendered.frames[1].pixels], [
		0,
		0,
		255,
		255,
		255,
		0,
		0,
		255,
	]);
});

test('renders transparent pixels in later frames over existing canvas', () => {
	const rendered = renderGIFFrames(decodeGIF(encodeGIF({
		width: 3,
		height: 1,
		globalColorTable: blackRedGreenBlueGlobalColorTable,
		blocks: [
			{
				type: 'image',
				width: 3,
				height: 1,
				pixels: [2, 1, 2],
			},
			{
				type: 'image',
				width: 3,
				height: 1,
				graphicControlExtension: {
					transparentColorIndex: 0,
				},
				pixels: [0, 3, 0],
			},
		],
	})));
	assert.deepEqual([...rendered.frames[1].pixels], [
		0,
		255,
		0,
		255,
		0,
		0,
		255,
		255,
		0,
		255,
		0,
		255,
	]);
});

test('renders transparent background when requested', () => {
	const rendered = renderGIFFrames({
		width: 1,
		height: 1,
		backgroundColorIndex: 1,
		globalColorTable: blackWhiteGlobalColorTable,
		blocks: [],
	}, {background: 'transparent'});
	assert.deepEqual(rendered.frames, []);

	const animated = renderGIFFrames({
		width: 2,
		height: 1,
		backgroundColorIndex: 1,
		globalColorTable: blackWhiteGlobalColorTable,
		blocks: [{
			type: 'image',
			width: 1,
			height: 1,
			pixels: Uint8Array.from([0]),
		}],
	}, {background: 'transparent'});
	assert.deepEqual([...animated.frames[0].pixels], [
		0,
		0,
		0,
		255,
		0,
		0,
		0,
		0,
	]);
	assert.equal(animated.frames[0].left, 0);
	assert.equal(animated.frames[0].top, 0);
	assert.equal(animated.frames[0].pixels instanceof Uint8ClampedArray, true);
});

test('renders spec background color by default', () => {
	const rendered = renderGIFFrames({
		width: 2,
		height: 1,
		backgroundColorIndex: 1,
		globalColorTable: blackWhiteGlobalColorTable,
		blocks: [{
			type: 'image',
			width: 1,
			height: 1,
			pixels: [0],
		}],
	});

	assert.deepEqual([...rendered.frames[0].pixels], [
		0,
		0,
		0,
		255,
		255,
		255,
		255,
		255,
	]);
});

test('renders GIF frame sequences one frame at a time', () => {
	const iterator = renderGIFFrameSequence({
		width: 2,
		height: 1,
		globalColorTable: blackRedGreenBlueGlobalColorTable,
		blocks: [
			{
				type: 'image',
				width: 1,
				height: 1,
				pixels: [1],
			},
			{
				type: 'image',
				left: 1,
				width: 1,
				height: 1,
				pixels: [3],
			},
		],
	});

	const first = iterator.next();
	const second = iterator.next();

	assert.equal(first.done, false);
	assert.equal(first.value.index, 0);
	assert.equal(first.value.loopIndex, 0);
	assert.deepEqual([...first.value.pixels], redGreenBlueAlphaPixelBytes(
		[255, 0, 0, 255],
		[0, 0, 0, 255],
	));
	assert.equal(second.done, false);
	assert.equal(second.value.index, 1);
	assert.equal(second.value.loopIndex, 0);
	assert.deepEqual([...second.value.pixels], redGreenBlueAlphaPixelBytes(
		[255, 0, 0, 255],
		[0, 0, 255, 255],
	));
	assert.deepEqual(iterator.next(), {
		value: undefined,
		done: true,
	});
});

test('breaking GIF frame sequence iteration does not render later frames', () => {
	const sequence = renderGIFFrameSequence({
		width: 1,
		height: 1,
		globalColorTable: blackWhiteGlobalColorTable,
		blocks: [
			{
				type: 'image',
				width: 1,
				height: 1,
				pixels: [1],
			},
			{
				type: 'image',
				width: 1,
				height: 1,
				pixels: [2],
			},
		],
	});
	let frameCount = 0;

	for (const frame of sequence) {
		assert.deepEqual([...frame.pixels], [255, 255, 255, 255]);
		frameCount += 1;
		if (frameCount === 1) {
			break;
		}
	}

	assert.equal(frameCount, 1);
});

test('aborts GIF frame sequence iteration', () => {
	const abortController = new AbortController();
	const iterator = renderGIFFrameSequence({
		width: 1,
		height: 1,
		globalColorTable: blackWhiteGlobalColorTable,
		blocks: [
			{
				type: 'image',
				width: 1,
				height: 1,
				pixels: [1],
			},
			{
				type: 'image',
				width: 1,
				height: 1,
				pixels: [2],
			},
		],
	}, {
		signal: abortController.signal,
	});

	assert.equal(iterator.next().done, false);
	abortController.abort();
	assert.deepEqual(iterator.next(), {
		value: undefined,
		done: true,
	});
});

test('pre-aborted GIF frame sequence skips render setup', () => {
	const abortController = new AbortController();
	abortController.abort();
	const gif = {};
	Object.defineProperty(gif, 'width', {
		get() {
			throw new Error('gif should not be read');
		},
	});

	const iterator = renderGIFFrameSequence(gif, {
		signal: abortController.signal,
	});

	assert.deepEqual(iterator.next(), {
		value: undefined,
		done: true,
	});
});

test('rejects invalid GIF frame sequence repeat and signal options', () => {
	const gif = {
		width: 1,
		height: 1,
		globalColorTable: blackWhiteGlobalColorTable,
		blocks: [{
			type: 'image',
			width: 1,
			height: 1,
			pixels: [1],
		}],
	};

	assert.throws(() => renderGIFFrameSequence(gif, {repeat: 'always'}), {message: /repeat must be a boolean/v});
	assert.throws(() => renderGIFFrameSequence(gif, {signal: {}}), {message: /signal must be an AbortSignal/v});
});

test('GIF frame sequence renders transparent background', () => {
	const [frame] = renderGIFFrameSequence({
		width: 2,
		height: 1,
		backgroundColorIndex: 1,
		globalColorTable: blackRedGreenBlueGlobalColorTable,
		blocks: [{
			type: 'image',
			width: 1,
			height: 1,
			pixels: [2],
		}],
	}, {
		background: 'transparent',
	});

	assert.deepEqual([...frame.pixels], redGreenBlueAlphaPixelBytes(
		[0, 255, 0, 255],
		[0, 0, 0, 0],
	));
});

test('GIF frame sequence renders one pass for missing play count metadata', () => {
	const frames = [...renderGIFFrameSequence({
		width: 1,
		height: 1,
		globalColorTable: blackWhiteGlobalColorTable,
		blocks: [
			{
				type: 'image',
				width: 1,
				height: 1,
				pixels: [0],
			},
			{
				type: 'image',
				width: 1,
				height: 1,
				pixels: [1],
			},
		],
	})];

	assert.deepEqual(frames.map(frame => frame.index), [0, 1]);
	assert.deepEqual(frames.map(frame => frame.loopIndex), [0, 0]);
});

test('GIF frame sequence renders one pass when repeat is false', () => {
	const frames = [...renderGIFFrameSequence({
		width: 1,
		height: 1,
		playCount: 3,
		globalColorTable: blackWhiteGlobalColorTable,
		blocks: [
			{
				type: 'image',
				width: 1,
				height: 1,
				pixels: [0],
			},
			{
				type: 'image',
				width: 1,
				height: 1,
				pixels: [1],
			},
		],
	}, {
		repeat: false,
	})];

	assert.deepEqual(frames.map(frame => frame.index), [0, 1]);
	assert.deepEqual(frames.map(frame => frame.loopIndex), [0, 0]);
});

test('GIF frame sequence stops image-free infinite loops', () => {
	const iterator = renderGIFFrameSequence({
		width: 1,
		height: 1,
		playCount: 'forever',
		blocks: [],
	});

	assert.deepEqual(iterator.next(), {
		value: undefined,
		done: true,
	});
});

test('renders finite GIF frame sequence loops', () => {
	const frames = [...renderGIFFrameSequence({
		width: 1,
		height: 1,
		playCount: 2,
		globalColorTable: blackWhiteGlobalColorTable,
		blocks: [
			{
				type: 'image',
				width: 1,
				height: 1,
				pixels: [0],
			},
			{
				type: 'image',
				width: 1,
				height: 1,
				pixels: [1],
			},
		],
	})];

	assert.deepEqual(frames.map(frame => frame.index), [0, 1, 0, 1]);
	assert.deepEqual(frames.map(frame => frame.loopIndex), [0, 0, 1, 1]);
});

test('aborts GIF frame sequence between loop passes', () => {
	const abortController = new AbortController();
	const iterator = renderGIFFrameSequence({
		width: 1,
		height: 1,
		playCount: 'forever',
		globalColorTable: blackWhiteGlobalColorTable,
		blocks: [
			{
				type: 'image',
				width: 1,
				height: 1,
				pixels: [0],
			},
			{
				type: 'image',
				width: 1,
				height: 1,
				pixels: [1],
			},
		],
	}, {signal: abortController.signal});

	const firstFrame = iterator.next().value;
	const secondFrame = iterator.next().value;
	assert.equal(firstFrame.loopIndex, 0);
	assert.equal(secondFrame.loopIndex, 0);
	abortController.abort();
	assert.deepEqual(iterator.next(), {
		value: undefined,
		done: true,
	});
});

test('GIF frame sequence resets composited pixels across loop boundaries', () => {
	const iterator = renderGIFFrameSequence({
		width: 2,
		height: 1,
		playCount: 'forever',
		globalColorTable: blackRedGreenBlueGlobalColorTable,
		blocks: [
			{
				type: 'image',
				width: 1,
				height: 1,
				pixels: [1],
			},
			{
				type: 'image',
				left: 1,
				width: 1,
				height: 1,
				pixels: [3],
			},
		],
	});

	iterator.next();
	iterator.next();
	const firstFrameOfSecondLoop = iterator.next().value;
	iterator.return();

	assert.equal(firstFrameOfSecondLoop.index, 0);
	assert.equal(firstFrameOfSecondLoop.loopIndex, 1);
	assert.deepEqual([...firstFrameOfSecondLoop.pixels], redGreenBlueAlphaPixelBytes(
		[255, 0, 0, 255],
		[0, 0, 0, 255],
	));
});

test('materialized GIF frames do not expose sequence metadata', () => {
	const rendered = renderGIFFrames({
		width: 1,
		height: 1,
		globalColorTable: blackWhiteGlobalColorTable,
		blocks: [{
			type: 'image',
			width: 1,
			height: 1,
			pixels: [1],
		}],
	});

	assert.equal('index' in rendered.frames[0], false);
	assert.equal('loopIndex' in rendered.frames[0], false);
});

test('removed initialPixels option does not seed rendered GIF canvases', () => {
	const gif = {
		width: 2,
		height: 1,
		globalColorTable: blackRedGreenBlueGlobalColorTable,
		blocks: [{
			type: 'image',
			width: 1,
			height: 1,
			pixels: [1],
		}],
	};
	const options = {
		initialPixels: redGreenBlueAlphaPixelBytes(
			[0, 255, 0, 255],
			[0, 255, 0, 255],
		),
	};

	assert.deepEqual([...renderGIFFrames(gif, options).frames[0].pixels], redGreenBlueAlphaPixelBytes(
		[255, 0, 0, 255],
		[0, 0, 0, 255],
	));
	assert.deepEqual([...renderGIFFrameSequence(gif, options).next().value.pixels], redGreenBlueAlphaPixelBytes(
		[255, 0, 0, 255],
		[0, 0, 0, 255],
	));
});

test('materialized GIF frames do not expose final pixels', () => {
	const rendered = renderGIFFrames({
		width: 1,
		height: 1,
		globalColorTable: blackWhiteGlobalColorTable,
		blocks: [{
			type: 'image',
			width: 1,
			height: 1,
			pixels: [1],
		}],
	});

	assert.equal('finalPixels' in rendered, false);
});

test('renders frame pixels before disposal', () => {
	const rendered = renderGIFFrames({
		width: 2,
		height: 1,
		backgroundColorIndex: 2,
		globalColorTable: blackRedGreenBlueGlobalColorTable,
		blocks: [{
			type: 'image',
			width: 1,
			height: 1,
			graphicControlExtension: {
				disposalMethod: 'restoreBackground',
			},
			pixels: [1],
		}],
	});

	assert.deepEqual([...rendered.frames[0].pixels], [
		255,
		0,
		0,
		255,
		0,
		255,
		0,
		255,
	]);
});

test('renders transparent background when no global color table exists', () => {
	const rendered = renderGIFFrames({
		width: 2,
		height: 1,
		blocks: [{
			type: 'image',
			width: 1,
			height: 1,
			colorTable: blackWhiteGlobalColorTable,
			pixels: [1],
		}],
	});

	assert.deepEqual([...rendered.frames[0].pixels], [
		255,
		255,
		255,
		255,
		0,
		0,
		0,
		0,
	]);
});

test('renders out-of-range spec background indexes as transparent', () => {
	const rendered = renderGIFFrames({
		width: 2,
		height: 1,
		backgroundColorIndex: 2,
		globalColorTable: blackWhiteGlobalColorTable,
		blocks: [{
			type: 'image',
			width: 1,
			height: 1,
			graphicControlExtension: {
				disposalMethod: 'restoreBackground',
				transparentColorIndex: 0,
			},
			pixels: [0],
		}],
	});

	assert.deepEqual([...rendered.frames[0].pixels], [
		0,
		0,
		0,
		0,
		0,
		0,
		0,
		0,
	]);
});

test('ignores out-of-range transparent color indexes while rendering loosely', () => {
	const gif = {
		width: 2,
		height: 1,
		globalColorTable: blackWhiteGlobalColorTable,
		blocks: [{
			type: 'image',
			width: 2,
			height: 1,
			graphicControlExtension: {
				transparentColorIndex: 2,
			},
			pixels: [0, 2],
		}],
	};

	assert.throws(() => renderGIFFrames(gif), {message: /Transparent color index 2 exceeds/v});
	assert.deepEqual([...renderGIFFrames(gif, {strict: false}).frames[0].pixels], [
		0,
		0,
		0,
		255,
		0,
		0,
		0,
		255,
	]);
});

test('ignores out-of-range pixel indexes while rendering loosely', () => {
	const gif = {
		width: 2,
		height: 1,
		globalColorTable: blackWhiteGlobalColorTable,
		blocks: [{
			type: 'image',
			width: 2,
			height: 1,
			pixels: [1, 2],
		}],
	};

	assert.throws(() => renderGIFFrames(gif), {message: /Pixel index 2 is outside/v});
	assert.deepEqual([...renderGIFFrames(gif, {strict: false}).frames[0].pixels], [
		255,
		255,
		255,
		255,
		0,
		0,
		0,
		255,
	]);
});

test('normalizes rendered GIF playCount', () => {
	assert.equal(renderGIFFrames({
		width: 1,
		height: 1,
		blocks: [],
	}).playCount, undefined);
	assert.equal('playCount' in renderGIFFrames({
		width: 1,
		height: 1,
		blocks: [],
	}), false);

	assert.equal(renderGIFFrames({
		width: 1,
		height: 1,
		playCount: 'forever',
		blocks: [],
	}).playCount, 'forever');
	assert.equal('loopCount' in renderGIFFrames({
		width: 1,
		height: 1,
		playCount: 'forever',
		blocks: [],
	}), false);

	assert.throws(() => renderGIFFrames({
		width: 1,
		height: 1,
		playCount: 'bad',
		blocks: [{
			type: 'image',
			width: 1,
			height: 1,
			pixels: [0],
		}],
	}), {message: /playCount must be an integer between 1 and 65536/v});

	assert.throws(() => renderGIFFrames({
		width: 1,
		height: 1,
		loopCount: 0,
		blocks: [],
	}), {message: /loopCount has been renamed to playCount/v});
});

test('ignores imageBlocks while rendering', () => {
	const rendered = renderGIFFrames({
		width: 1,
		height: 1,
		globalColorTable: blackWhiteGlobalColorTable,
		blocks: [{
			type: 'image',
			width: 1,
			height: 1,
			pixels: [1],
		}],
		imageBlocks: [{
			type: 'image',
			width: 1,
			height: 1,
			pixels: [0],
		}],
	}, {background: 'transparent'});

	assert.equal(rendered.frames.length, 1);
	assert.deepEqual([...rendered.frames[0].pixels], [
		255,
		255,
		255,
		255,
	]);
});

test('rejects out-of-range pixels against global color tables while rendering', () => {
	assert.throws(() => renderGIFFrames({
		width: 1,
		height: 1,
		globalColorTable: blackWhiteGlobalColorTable,
		blocks: [{
			type: 'image',
			width: 1,
			height: 1,
			pixels: [2],
		}],
	}), {message: /Pixel index 2 is outside the active color table/v});
});

test('rejects invalid render background modes', () => {
	assert.throws(() => renderGIFFrames({
		width: 1,
		height: 1,
		globalColorTable: blackWhiteGlobalColorTable,
		blocks: [],
	}, {background: 'invalid'}), {message: /background/v});
});

test('rejects malformed render block lists', () => {
	assert.throws(() => renderGIFFrames({
		width: 1,
		height: 1,
		blocks: 'bad',
	}), {message: /blocks must be an array/v});

	assert.throws(() => renderGIFFrames({
		width: 1,
		height: 1,
		blocks: [{
			type: 'unsupported',
		}],
	}), {message: /Unsupported block type "unsupported"/v});
});

test('rejects malformed raw image blocks while rendering', () => {
	assert.throws(() => renderGIFFrames({
		width: 1,
		height: 1,
		globalColorTable: blackWhiteGlobalColorTable,
		blocks: [{
			type: 'image',
			width: 1,
			height: 1,
			pixels: [],
		}],
	}), {message: /image.pixels length must be 1/v});

	assert.throws(() => renderGIFFrames({
		width: 1,
		height: 1,
		globalColorTable: blackWhiteGlobalColorTable,
		blocks: [{
			type: 'image',
			width: 1,
			height: 1,
			graphicControlExtension: 'bad',
			pixels: [0],
		}],
	}), {message: /graphicControlExtension must be an object or undefined/v});
});

test('round-trips interlaced image pixels', () => {
	const indexedPixels = Uint8Array.from([
		0,
		0,
		0,
		0,
		1,
		0,
		0,
		1,
		1,
		1,
		0,
		0,
		0,
		1,
		1,
		0,
	]);
	const encoded = encodeGIF({
		width: 4,
		height: 4,
		globalColorTable: blackWhiteGlobalColorTable,
		blocks: [{
			type: 'image',
			width: 4,
			height: 4,
			isInterlaced: true,
			pixels: indexedPixels,
		}],
	});
	const decoded = decodeGIF(encoded);
	const rendered = renderGIFFrames(decoded);

	assert.equal(decoded.imageBlocks[0].isInterlaced, true);
	assert.deepEqual([...decoded.imageBlocks[0].pixels], [...indexedPixels]);
	assert.deepEqual([...rendered.frames[0].pixels], indexedPixelsToRedGreenBlueAlphaPixels(indexedPixels, blackWhiteGlobalColorTable));
});

test('interlaced encoding does not trust custom indexed pixel subarray methods', () => {
	const indexedPixels = Uint8Array.from([0, 1]);
	indexedPixels.subarray = () => Uint8Array.of(1);
	const decoded = decodeGIF(encodeGIF({
		width: 1,
		height: 2,
		globalColorTable: blackWhiteGlobalColorTable,
		blocks: [{
			type: 'image',
			width: 1,
			height: 2,
			isInterlaced: true,
			pixels: indexedPixels,
		}],
	}));

	assert.deepEqual([...decoded.imageBlocks[0].pixels], [0, 1]);
});

test('decodes GIFs generated by Pillow', () => {
	if (!hasPillow) {
		return;
	}

	const pillowGifPath = path.join(generatedFixtureDirectory, 'pillow-generated.gif');
	createGifWithPillow(pillowGifPath);
	const decoded = decodeGIF(fs.readFileSync(pillowGifPath));
	const rendered = renderGIFFrames(decoded, {background: 'transparent'});
	const pillow = readGifWithPillow(pillowGifPath);
	assert.deepEqual(pillow.size, [3, 2]);
	assert.equal(pillow.loop, 0);
	const extractRedGreenBlue = frameBytes => frameBytes.filter((_, index) => index % 4 !== 3);
	assert.deepEqual(pillow.frames.map(frame => extractRedGreenBlue(frame)), rendered.frames.map(frame => extractRedGreenBlue([...frame.pixels])));
});

test('decodes GIFs generated by ImageMagick', () => {
	if (!hasImageMagick) {
		return;
	}

	const imageMagickGifPath = path.join(generatedFixtureDirectory, 'imagemagick-generated.gif');
	createGifWithImageMagick(imageMagickGifPath);
	const decoded = decodeGIF(fs.readFileSync(imageMagickGifPath));
	const rendered = renderGIFFrames(decoded, {background: 'transparent'});
	assert.equal(decoded.width, 3);
	assert.equal(decoded.height, 2);
	assert.deepEqual(readGifWithImageMagick(imageMagickGifPath, {
		width: 3,
		height: 2,
	}), rendered.frames.map(frame => [...frame.pixels]));
});

test('decodes animated GIFs generated by ImageMagick', () => {
	if (!hasImageMagick) {
		return;
	}

	const imageMagickGifPath = path.join(generatedFixtureDirectory, 'imagemagick-generated-animation.gif');
	createAnimatedGifWithImageMagick(imageMagickGifPath);
	const decoded = decodeGIF(fs.readFileSync(imageMagickGifPath));
	const rendered = renderGIFFrames(decoded, {background: 'transparent'});
	assert.equal(decoded.width, 3);
	assert.equal(decoded.height, 2);
	assert.equal(rendered.frames.length, 2);
	assert.deepEqual(readGifWithImageMagick(imageMagickGifPath, {
		width: 3,
		height: 2,
	}), rendered.frames.map(frame => [...frame.pixels]));
});

test('decodes small external fixture GIFs', () => {
	const fixtureCases = [
		{
			fileName: 'tiny-2x2.gif',
			width: 2,
			height: 2,
			blockTypes: ['image'],
			imageCount: 1,
			playCount: undefined,
		},
		{
			fileName: 'looped-animation.gif',
			width: 100,
			height: 50,
			blockTypes: ['applicationExtension', 'image', 'image'],
			imageCount: 2,
			playCount: 'forever',
		},
		{
			fileName: 'beacon-icc-profile.gif',
			width: 6,
			height: 6,
			blockTypes: ['applicationExtension', 'applicationExtension', 'image', 'image'],
			imageCount: 2,
			playCount: 'forever',
		},
	];

	for (const fixtureCase of fixtureCases) {
		const decoded = decodeGIF(readFixture(fixtureCase.fileName));
		const rendered = renderGIFFrames(decoded, {background: 'transparent'});
		assert.equal(decoded.width, fixtureCase.width);
		assert.equal(decoded.height, fixtureCase.height);
		assert.equal(decoded.imageBlocks.length, fixtureCase.imageCount);
		assert.equal(decoded.playCount, fixtureCase.playCount);
		assert.deepEqual(decoded.blocks.map(block => block.type), fixtureCase.blockTypes);
		assert.equal(rendered.frames.length, fixtureCase.imageCount);
	}
});

test('first frame of an animated GIF matches a JPEG snapshot of the same frame', async () => {
	const decoded = decodeGIF(readFixture('looped-animation.gif'));
	const rendered = renderGIFFrames(decoded, {background: 'gif'});
	const firstFramePixels = rendered.frames[0].pixels;

	const jpegImage = await Jimp.read(path.join(fixtureDirectory, 'looped-animation-frame0.jpg'));
	assert.equal(jpegImage.bitmap.width, decoded.width);
	assert.equal(jpegImage.bitmap.height, decoded.height);
	const jpegPixels = jpegImage.bitmap.data;

	let totalDifference = 0;
	for (const [index, pixelByte] of firstFramePixels.entries()) {
		totalDifference += Math.abs(pixelByte - jpegPixels[index]);
	}

	const averagePerChannelDifference = totalDifference / firstFramePixels.length;
	assert.ok(averagePerChannelDifference < 10, `Average per-channel difference ${averagePerChannelDifference} exceeds the JPEG snapshot tolerance`);
});

test('rejects malformed Pillow fixture strictly and decodes it loosely', () => {
	const fixture = readFixture('background-index-outside-palette.gif');
	assert.throws(() => decodeGIF(fixture), {message: /Background color index/v});

	const decoded = decodeGIF(fixture, {strict: false});
	const rendered = renderGIFFrames(decoded, {background: 'transparent'});
	assert.equal(decoded.version, '87a');
	assert.equal(decoded.width, 1);
	assert.equal(decoded.height, 1);
	assert.equal(decoded.imageBlocks.length, 2);
	assert.equal(rendered.frames.length, 2);
	assert.deepEqual([...rendered.frames[1].pixels], [
		255,
		0,
		0,
		255,
	]);
});

test('allows trailing bytes in loose mode', () => {
	const gif = minimalGifBytes({trailingBytes: [0]});
	assert.throws(() => decodeGIF(gif), {message: /trailing byte/v});
	assert.equal(decodeGIF(gif, {strict: false}).imageBlocks.length, 1);
});

test('rejects truncated data at each required structural boundary', () => {
	const gif = minimalGifBytes();
	for (let length = 0; length < gif.length; length += 1) {
		assert.throws(() => decodeGIF(gif.slice(0, length)), {
			message: /Expected GIF signature|Unsupported GIF version|Unexpected end of data|Unexpected end of compressed image data|Expected 1 pixel indices/v,
		});
	}
});

test('rejects invalid header, version, and truncated streams', () => {
	assert.throws(() => decodeGIF(bytes(0x4E, 0x4F, 0x54, ...gif89aVersion)), {message: /Expected GIF signature/v});
	assert.throws(() => decodeGIF(bytes(
		...gifSignature,
		0x30,
		0x30,
		0x61,
	)), {message: /Unsupported GIF version/v});
	assert.throws(() => decodeGIF(bytes(
		...gifSignature,
		...gif89aVersion,
		0x01,
	)), {message: /Unexpected end of data/v});
});

test('rejects invalid top-level decode, encode, and render inputs', () => {
	assert.throws(() => decodeGIF([0x47, 0x49, 0x46]), {message: /Expected inputBytes to be a Uint8Array/v});
	assert.throws(() => encodeGIF(null), {message: /Expected a GIF description object/v});
	assert.throws(() => renderGIFFrames(null), {message: /Expected a decoded GIF object/v});

	const spoofedDataView = new DataView(new ArrayBuffer(6));
	Object.defineProperty(spoofedDataView, Symbol.toStringTag, {value: 'Uint8Array'});
	assert.throws(() => decodeGIF(spoofedDataView), {message: /Expected inputBytes to be a Uint8Array/v});
});

test('rejects sparse block arrays', () => {
	const blocks = [];
	blocks.length = 1;

	assert.throws(() => encodeGIF({
		width: 1,
		height: 1,
		globalColorTable: blackWhiteGlobalColorTable,
		blocks,
	}), {message: 'Each block must be an object'});

	assert.throws(() => encodeGIF({
		width: 1,
		height: 1,
		globalColorTable: blackWhiteGlobalColorTable,
		imageBlocks: blocks,
	}), {message: /imageBlocks is not supported when encoding; use blocks/v});

	assert.throws(() => renderGIFFrames({
		width: 1,
		height: 1,
		globalColorTable: blackWhiteGlobalColorTable,
		blocks,
	}), {message: 'Each block must be an object'});

	const blocksWithCustomIterator = [];
	blocksWithCustomIterator.length = 1;
	blocksWithCustomIterator[Symbol.iterator] = function * () {};

	assert.throws(() => encodeGIF({
		width: 1,
		height: 1,
		globalColorTable: blackWhiteGlobalColorTable,
		blocks: blocksWithCustomIterator,
	}), {message: 'Each block must be an object'});

	assert.throws(() => renderGIFFrames({
		width: 1,
		height: 1,
		globalColorTable: blackWhiteGlobalColorTable,
		blocks: blocksWithCustomIterator,
	}), {message: 'Each block must be an object'});

	const blocksWithCustomKeys = [];
	blocksWithCustomKeys.length = 1;
	blocksWithCustomKeys.keys = function * () {};

	assert.throws(() => encodeGIF({
		width: 1,
		height: 1,
		globalColorTable: blackWhiteGlobalColorTable,
		blocks: blocksWithCustomKeys,
	}), {message: 'Each block must be an object'});

	assert.throws(() => renderGIFFrames({
		width: 1,
		height: 1,
		globalColorTable: blackWhiteGlobalColorTable,
		blocks: blocksWithCustomKeys,
	}), {message: 'Each block must be an object'});

	const shrinkingBlocks = [];
	shrinkingBlocks.length = 2;
	Object.defineProperty(shrinkingBlocks, 0, {
		get() {
			shrinkingBlocks.length = 1;
			return {
				type: 'image',
				width: 1,
				height: 1,
				pixels: [1],
			};
		},
	});

	assert.throws(() => encodeGIF({
		width: 1,
		height: 1,
		globalColorTable: blackWhiteGlobalColorTable,
		blocks: shrinkingBlocks,
	}), {message: 'Each block must be an object'});

	const shrinkingRenderBlocks = [];
	shrinkingRenderBlocks.length = 2;
	Object.defineProperty(shrinkingRenderBlocks, 0, {
		get() {
			shrinkingRenderBlocks.length = 1;
			return {
				type: 'image',
				width: 1,
				height: 1,
				pixels: [1],
			};
		},
	});

	assert.throws(() => renderGIFFrames({
		width: 1,
		height: 1,
		globalColorTable: blackWhiteGlobalColorTable,
		blocks: shrinkingRenderBlocks,
	}), {message: 'Each block must be an object'});
});

test('rejects zero-sized logical screens and image blocks while decoding in strict mode', () => {
	const zeroWidthLogicalScreen = bytes(
		...gifSignature,
		...gif89aVersion,
		...logicalScreenBytes({
			width: 0,
			height: 1,
			packedField: 0,
		}),
		0x3B,
	);
	assert.throws(() => decodeGIF(zeroWidthLogicalScreen), {message: /Logical Screen dimensions must be non-zero/v});
	assert.equal(decodeGIF(zeroWidthLogicalScreen, {strict: false}).width, 0);

	const zeroWidthImage = bytes(
		...gifSignature,
		...gif89aVersion,
		...logicalScreenBytes({
			width: 1,
			height: 1,
			packedField: 0x80,
		}),
		...blackWhiteGlobalColorTable,
		0x2C,
		0x00,
		0x00,
		0x00,
		0x00,
		0x00,
		0x00,
		0x01,
		0x00,
		0x00,
		...imageDataFromLzwCodes({
			codeSequence: [
				4,
				5,
			],
		}),
		0x3B,
	);
	assert.throws(() => decodeGIF(zeroWidthImage), {message: /Image block dimensions must be non-zero/v});
	assert.equal(decodeGIF(zeroWidthImage, {strict: false}).imageBlocks[0].width, 0);
});

test('rejects zero-sized logical screens and image blocks while encoding', () => {
	assert.throws(() => encodeGIF({
		width: 0,
		height: 1,
		globalColorTable: blackWhiteGlobalColorTable,
		blocks: [{
			type: 'image',
			width: 1,
			height: 1,
			pixels: [0],
		}],
	}), {message: /width must be an integer between 1 and 65535/v});

	assert.throws(() => encodeGIF({
		width: 1,
		height: 1,
		globalColorTable: blackWhiteGlobalColorTable,
		blocks: [{
			type: 'image',
			width: 0,
			height: 1,
			colorTable: [999],
			pixels: [0],
		}],
	}), {message: /image\.width must be an integer between 1 and 65535/v});

	assert.throws(() => renderGIFFrames({
		width: 0,
		height: 1,
		blocks: [],
	}), {message: /width must be an integer between 1 and 65535/v});
});

test('rejects malformed block introducers and missing trailer', () => {
	assert.throws(() => decodeGIF(bytes(
		...gifSignature,
		...gif89aVersion,
		...logicalScreenBytes({packedField: 0}),
		0x00,
	)), {message: /Unexpected block introducer/v});
	assert.throws(() => decodeGIF(bytes(
		...gifSignature,
		...gif89aVersion,
		...logicalScreenBytes({packedField: 0}),
	)), {message: /Unexpected end of data/v});
});

test('rejects invalid image bounds and LZW minimum code size', () => {
	assert.throws(() => decodeGIF(minimalGifBytes({
		width: 1,
		height: 1,
		imageData: [
			0x01,
			0x00,
		],
	})), {message: /Invalid minimum code size/v});

	assert.throws(() => decodeGIF(bytes(
		...gifSignature,
		...gif89aVersion,
		...logicalScreenBytes({
			width: 1,
			height: 1,
			packedField: 0x80,
		}),
		...blackWhiteGlobalColorTable,
		0x2C,
		0x01,
		0x00,
		0x00,
		0x00,
		0x01,
		0x00,
		0x01,
		0x00,
		0x00,
		...onePixelIndexZeroImageData,
		0x3B,
	)), {message: /extends beyond/v});
});

test('rejects malformed graphic control extensions in strict mode', () => {
	assert.throws(() => decodeGIF(minimalGifBytes({
		beforeImage: [
			0x21,
			0xF9,
			0x03,
			0x00,
			0x00,
			0x00,
			0x00,
			0x00,
		],
	})), {message: /Invalid Graphic Control Extension block size/v});

	assert.throws(() => decodeGIF(minimalGifBytes({
		beforeImage: graphicControlExtensionBytes({
			blockTerminator: 1,
		}),
	})), {message: /missing its block terminator/v});

	assert.throws(() => decodeGIF(minimalGifBytes({
		beforeImage: graphicControlExtensionBytes({
			packedField: 0b1110_0000,
		}),
	})), {message: /reserved bits/v});

	const decoded = decodeGIF(minimalGifBytes({
		beforeImage: graphicControlExtensionBytes({
			packedField: 0b1110_0000,
		}),
	}), {strict: false});
	assert.equal(decoded.imageBlocks[0].graphicControlExtension.disposalMethod, 'unspecified');

	const ignoredTransparentColorIndex = decodeGIF(minimalGifBytes({
		beforeImage: graphicControlExtensionBytes({
			packedField: 0,
			transparentColorIndex: 2,
		}),
	}));
	assert.equal(ignoredTransparentColorIndex.imageBlocks[0].graphicControlExtension.transparentColorIndex, undefined);

	const reservedDisposalMethodGif = minimalGifBytes({
		beforeImage: graphicControlExtensionBytes({
			packedField: 4 << 2,
		}),
	});
	assert.throws(() => decodeGIF(reservedDisposalMethodGif), {message: /reserved/v});
	assert.equal(decodeGIF(reservedDisposalMethodGif, {strict: false}).imageBlocks[0].graphicControlExtension.disposalMethod, 'unspecified');
});

test('rejects malformed plain text extensions', () => {
	assert.throws(() => decodeGIF(minimalGifBytes({
		beforeImage: [
			0x21,
			0x01,
			0x0B,
			0x00,
			0x00,
		],
	})), {message: /Unexpected block introducer/v});

	const decoded = decodeGIF(minimalGifBytes({
		beforeImage: plainTextExtensionBytes([0x41]),
	}));
	assert.equal(decoded.blocks[0].type, 'unknownExtension');
	assert.equal(decoded.blocks[0].extensionLabel, 0x01);
	assert.deepEqual([...decoded.blocks[0].data], [0x41]);
});

test('rejects malformed application extensions', () => {
	assert.throws(() => decodeGIF(minimalGifBytes({
		beforeImage: [
			0x21,
			0xFF,
			0x0A,
			...asciiBytes('APPNAME1ab'),
			0x00,
		],
	})), {message: /Invalid Application Extension block size/v});

	const nonPrintableIdentifierGif = minimalGifBytes({
		beforeImage: [
			0x21,
			0xFF,
			0x0B,
			0x41,
			0x42,
			0x01,
			0x43,
			0x44,
			0x45,
			0x46,
			0x47,
			...asciiBytes('abc'),
			0x00,
		],
	});
	assert.throws(() => decodeGIF(nonPrintableIdentifierGif), {message: /printable ASCII/v});
	assert.equal(decodeGIF(nonPrintableIdentifierGif, {strict: false}).blocks[0].identifier, 'AB\u{1}CDEFG');

	assert.throws(() => encodeGIF({
		width: 1,
		height: 1,
		globalColorTable: blackWhiteGlobalColorTable,
		blocks: [{
			type: 'applicationExtension',
			identifier: 'TOO-LONG1',
			authenticationCode: 'abc',
			data: [],
		}],
	}), {message: 'applicationExtension.identifier must be exactly 8 ASCII bytes long'});

	assert.throws(() => encodeGIF({
		width: 1,
		height: 1,
		globalColorTable: blackWhiteGlobalColorTable,
		blocks: [{
			type: 'applicationExtension',
			identifier: 'APP\u{1}AME1',
			authenticationCode: 'abc',
			data: [],
		}],
	}), {message: /printable ASCII/v});

	assert.throws(() => encodeGIF({
		width: 1,
		height: 1,
		globalColorTable: blackWhiteGlobalColorTable,
		blocks: [{
			type: 'applicationExtension',
			identifier: 'APPNAME1',
			authenticationCode: 'abcd',
			data: [],
		}],
	}), {message: 'applicationExtension.authenticationCode must be exactly 3 bytes long'});

	assert.throws(() => encodeGIF({
		width: 1,
		height: 1,
		globalColorTable: blackWhiteGlobalColorTable,
		blocks: [{
			type: 'applicationExtension',
			identifier: 'APPNAME1',
			authenticationCode: 'ébc',
			data: [],
		}],
	}), {message: 'applicationExtension.authenticationCode must be exactly 3 bytes long'});

	assert.throws(() => encodeGIF({
		width: 1,
		height: 1,
		globalColorTable: blackWhiteGlobalColorTable,
		blocks: [{
			type: 'applicationExtension',
			identifier: 'APPNAME1',
			authenticationCode: [1, 2],
			data: [],
		}],
	}), {message: /must be exactly 3 bytes long/v});

	assert.throws(() => encodeGIF({
		width: 1,
		height: 1,
		globalColorTable: blackWhiteGlobalColorTable,
		blocks: [{
			type: 'applicationExtension',
			identifier: 'APPNAME1',
			authenticationCode: [1, 2, 300],
			data: [],
		}],
	}), {message: /must be an integer between 0 and 255/v});
});

test('rejects unterminated data sub-blocks', () => {
	assert.throws(() => decodeGIF(bytes(
		...gifSignature,
		...gif89aVersion,
		...logicalScreenBytes({packedField: 0}),
		0x21,
		0xFE,
		0x02,
		0x41,
	)), {message: /Unexpected end of data/v});
});

test('rejects image descriptor reserved bits in strict mode', () => {
	const gif = minimalGifBytes({
		imageDescriptorPackedField: 0b0001_1000,
	});
	assert.throws(() => decodeGIF(gif), {message: /Image Descriptor reserved bits/v});
	assert.equal(decodeGIF(gif, {strict: false}).imageBlocks[0].isInterlaced, false);
});

test('enforces graphic control extension scope in strict mode', () => {
	assert.throws(() => decodeGIF(bytes(
		...gifSignature,
		...gif89aVersion,
		...logicalScreenBytes({
			packedField: 0x80,
		}),
		...blackWhiteGlobalColorTable,
		...graphicControlExtensionBytes(),
		0x3B,
	)), {message: /not followed by a graphic rendering block/v});

	assert.throws(() => decodeGIF(minimalGifBytes({
		beforeImage: [
			...graphicControlExtensionBytes(),
			...graphicControlExtensionBytes(),
		],
	})), {message: /second Graphic Control Extension/v});

	const duplicateGraphicControlExtensions = decodeGIF(minimalGifBytes({
		beforeImage: [
			...graphicControlExtensionBytes({delayTime: 1}),
			...graphicControlExtensionBytes({delayTime: 2}),
		],
	}), {strict: false});
	assert.equal(duplicateGraphicControlExtensions.imageBlocks[0].graphicControlExtension.delay, 0.02);

	const commentBetweenControlAndImage = asciiBytes('comment between control and image');
	const decoded = decodeGIF(minimalGifBytes({
		beforeImage: [
			...graphicControlExtensionBytes({delayTime: 1}),
			...commentExtensionBytes(commentBetweenControlAndImage),
		],
	}));
	assert.equal(decoded.blocks[1].graphicControlExtension.delay, 0.01);
});

test('rejects invalid color tables and indexed pixels while encoding', () => {
	assert.throws(() => encodeGIF({
		width: 1,
		height: 1,
		globalColorTable: [0, 0, 0],
		blocks: [{
			type: 'image',
			width: 1,
			height: 1,
			pixels: [0],
		}],
	}), {message: /between 2 and 256 entries/v});

	assert.throws(() => encodeGIF({
		width: 1,
		height: 1,
		globalColorTable: [0, 0, 0, 255, 255, 255, 128, 128, 128],
		blocks: [{
			type: 'image',
			width: 1,
			height: 1,
			pixels: [0],
		}],
	}), {message: /power-of-two number of entries/v});

	assert.throws(() => encodeGIF({
		width: 1,
		height: 1,
		globalColorTable: [[0, 0, 0], [255, 255]],
		blocks: [{
			type: 'image',
			width: 1,
			height: 1,
			pixels: [0],
		}],
	}), {message: /globalColorTable\[1\] must be an array of exactly 3 bytes/v});

	const shrinkingTripletColorTable = [[0, 0, 0]];
	shrinkingTripletColorTable.length = 4;
	Object.defineProperty(shrinkingTripletColorTable, 1, {
		get() {
			shrinkingTripletColorTable.length = 2;
			return [255, 255, 255];
		},
	});

	assert.throws(() => encodeGIF({
		width: 1,
		height: 1,
		globalColorTable: shrinkingTripletColorTable,
		blocks: [{
			type: 'image',
			width: 1,
			height: 1,
			pixels: [0],
		}],
	}), {message: /globalColorTable\[2\] must be an array of exactly 3 bytes/v});

	assert.throws(() => encodeGIF({
		width: 1,
		height: 1,
		globalColorTable: Uint8Array.from([0, 0, 0, 255, 255]),
		blocks: [{
			type: 'image',
			width: 1,
			height: 1,
			pixels: [0],
		}],
	}), {message: /globalColorTable length must be divisible by 3/v});

	assert.throws(() => encodeGIF({
		width: 1,
		height: 1,
		globalColorTable: blackWhiteGlobalColorTable,
		blocks: [{
			type: 'image',
			width: 1,
			height: 1,
			pixels: [2],
		}],
	}), {message: /active color table only has 2 entries/v});
});

test('infers minimum code size 8 for palette index 255', () => {
	const encoded = encodeGIF({
		width: 1,
		height: 1,
		globalColorTable: colorTableWithEntryCount(256),
		blocks: [{
			type: 'image',
			width: 1,
			height: 1,
			pixels: [255],
		}],
	});
	const decoded = decodeGIF(encoded);

	assert.equal(extractFirstImageData(encoded).minimumCodeSize, 8);
	assert.deepEqual([...decoded.imageBlocks[0].pixels], [255]);
});

test('rejects invalid color table indexes while decoding in strict mode', () => {
	const invalidBackgroundColorIndex = bytes(
		...gifSignature,
		...gif89aVersion,
		...logicalScreenBytes({
			packedField: 0x80,
			backgroundColorIndex: 2,
		}),
		...blackWhiteGlobalColorTable,
		0x3B,
	);
	assert.throws(() => decodeGIF(invalidBackgroundColorIndex), {message: /Background color index/v});
	assert.equal(decodeGIF(invalidBackgroundColorIndex, {strict: false}).backgroundColorIndex, 2);

	const invalidTransparentColorIndex = minimalGifBytes({
		beforeImage: graphicControlExtensionBytes({
			packedField: 0b0000_0001,
			transparentColorIndex: 2,
		}),
	});
	assert.throws(() => decodeGIF(invalidTransparentColorIndex), {message: /Transparent color index/v});
	assert.equal(decodeGIF(invalidTransparentColorIndex, {strict: false}).imageBlocks[0].graphicControlExtension.transparentColorIndex, 2);

	const invalidLocalTransparentColorIndex = minimalGifBytes({
		packedField: 0b1000_0001,
		globalColorTable: blackRedGreenBlueGlobalColorTable,
		imageDescriptorPackedField: 0b1000_0000,
		colorTable: blackWhiteGlobalColorTable,
		beforeImage: graphicControlExtensionBytes({
			packedField: 0b0000_0001,
			transparentColorIndex: 2,
		}),
	});
	assert.throws(() => decodeGIF(invalidLocalTransparentColorIndex), {message: /Transparent color index/v});
	assert.equal(decodeGIF(invalidLocalTransparentColorIndex, {strict: false}).imageBlocks[0].graphicControlExtension.transparentColorIndex, 2);

	const invalidPixelIndex = minimalGifBytes({
		imageData: imageDataFromLzwCodes({
			codeSequence: [
				4,
				2,
				5,
			],
		}),
	});
	assert.throws(() => decodeGIF(invalidPixelIndex), {message: /active color table only has 2 entries/v});
	assert.deepEqual([...decodeGIF(invalidPixelIndex, {strict: false}).imageBlocks[0].pixels], [2]);

	const invalidLocalPixelIndex = minimalGifBytes({
		packedField: 0b1000_0001,
		globalColorTable: blackRedGreenBlueGlobalColorTable,
		imageDescriptorPackedField: 0b1000_0000,
		colorTable: blackWhiteGlobalColorTable,
		imageData: imageDataFromLzwCodes({
			codeSequence: [
				4,
				2,
				5,
			],
		}),
	});
	assert.throws(() => decodeGIF(invalidLocalPixelIndex), {message: /active color table only has 2 entries/v});
	assert.deepEqual([...decodeGIF(invalidLocalPixelIndex, {strict: false}).imageBlocks[0].pixels], [2]);
});

test('rejects decode, encode, and render inputs that exceed internal pixel limits', () => {
	const hugeDimension = 0xFF_FF;
	const hugeImageBlock = bytes(
		...gifSignature,
		...gif89aVersion,
		...logicalScreenBytes({
			width: hugeDimension,
			height: hugeDimension,
			packedField: 0x80,
		}),
		...blackWhiteGlobalColorTable,
		0x2C,
		0x00,
		0x00,
		0x00,
		0x00,
		0xFF,
		0xFF,
		0xFF,
		0xFF,
		0x00,
	);

	assert.throws(() => decodeGIF(hugeImageBlock), {message: /image block has 4294836225 pixels/v});

	assert.throws(() => renderGIFFrames({
		width: hugeDimension,
		height: hugeDimension,
		globalColorTable: blackWhiteGlobalColorTable,
		blocks: [],
	}), {message: /logical screen has 4294836225 pixels/v});

	assert.throws(() => renderGIFFrames({
		width: 1,
		height: 1,
		globalColorTable: blackWhiteGlobalColorTable,
		blocks: [{
			type: 'image',
			width: 50_001,
			height: 2001,
			pixels: [],
		}],
	}), {message: /extends beyond the logical screen bounds/v});

	const offscreenIndexedPixels = [];
	offscreenIndexedPixels.length = 1;
	Object.defineProperty(offscreenIndexedPixels, 0, {
		get() {
			throw new Error('offscreen indexedPixels should not be read');
		},
	});

	assert.throws(() => encodeGIF({
		width: 1,
		height: 1,
		globalColorTable: blackWhiteGlobalColorTable,
		blocks: [{
			type: 'image',
			left: 1,
			width: 1,
			height: 1,
			pixels: offscreenIndexedPixels,
		}],
	}), {message: /extends beyond the logical screen bounds/v});

	const offscreenRedGreenBlueAlphaPixels = [];
	offscreenRedGreenBlueAlphaPixels.length = 4;
	Object.defineProperty(offscreenRedGreenBlueAlphaPixels, 0, {
		get() {
			throw new Error('offscreen pixels should not be read');
		},
	});

	assert.throws(() => encodeGIF({
		width: 1,
		height: 1,
		blocks: [{
			type: 'rgbaImage',
			left: 1,
			width: 1,
			height: 1,
			pixels: offscreenRedGreenBlueAlphaPixels,
		}],
	}), {message: /extends beyond the logical screen bounds/v});

	assert.throws(() => encodeGIF({
		width: hugeDimension,
		height: hugeDimension,
		blocks: [{
			type: 'image',
			width: hugeDimension,
			height: hugeDimension,
			colorTable: [999],
			pixels: [],
		}],
	}), {message: 'encode work cost 4294836225 exceeds the limit of 100000000'});

	const oversizedGlobalColorTable = [];
	oversizedGlobalColorTable.length = 10_000_000;
	Object.defineProperty(oversizedGlobalColorTable, 0, {
		get() {
			throw new Error('globalColorTable should not be read');
		},
	});

	assert.throws(() => encodeGIF({
		width: 1,
		height: 1,
		globalColorTable: oversizedGlobalColorTable,
		blocks: [],
	}), {message: 'globalColorTable cannot contain more than 768 flat bytes or 256 RGB triplets'});

	const invalidLengthGlobalColorTable = [];
	invalidLengthGlobalColorTable.length = 7;
	Object.defineProperty(invalidLengthGlobalColorTable, 0, {
		get() {
			throw new Error('invalidLengthGlobalColorTable should not be read');
		},
	});

	assert.throws(() => encodeGIF({
		width: 1,
		height: 1,
		globalColorTable: invalidLengthGlobalColorTable,
		blocks: [],
	}), {message: 'globalColorTable length must be divisible by 3'});

	const oversizedLocalColorTable = [];
	oversizedLocalColorTable.length = 10_000_000;
	Object.defineProperty(oversizedLocalColorTable, 0, {
		get() {
			throw new Error('colorTable should not be read');
		},
	});

	assert.throws(() => encodeGIF({
		width: 1,
		height: 1,
		blocks: [{
			type: 'image',
			width: 1,
			height: 1,
			colorTable: oversizedLocalColorTable,
			pixels: [0],
		}],
	}), {message: 'image.colorTable cannot contain more than 768 flat bytes or 256 RGB triplets'});

	const invalidTripletCountLocalColorTable = [];
	invalidTripletCountLocalColorTable.length = 300;
	Object.defineProperty(invalidTripletCountLocalColorTable, 0, {
		get() {
			throw new Error('invalidTripletCountLocalColorTable should not be read');
		},
	});

	assert.throws(() => encodeGIF({
		width: 1,
		height: 1,
		blocks: [{
			type: 'image',
			width: 1,
			height: 1,
			colorTable: invalidTripletCountLocalColorTable,
			pixels: [0],
		}],
	}), {message: 'image.colorTable must contain a power-of-two number of entries, got 100'});

	const oversizedIndexedPixels = [];
	oversizedIndexedPixels.length = 10_000_000;
	Object.defineProperty(oversizedIndexedPixels, 0, {
		get() {
			throw new Error('indexedPixels should not be read');
		},
	});

	assert.throws(() => encodeGIF({
		width: 1,
		height: 1,
		globalColorTable: blackWhiteGlobalColorTable,
		blocks: [{
			type: 'image',
			width: 1,
			height: 1,
			pixels: oversizedIndexedPixels,
		}],
	}), {message: 'image.pixels length must be 1, got 10000000'});

	const oversizedRedGreenBlueAlphaPixels = [];
	oversizedRedGreenBlueAlphaPixels.length = 10_000_000;
	Object.defineProperty(oversizedRedGreenBlueAlphaPixels, 0, {
		get() {
			throw new Error('pixels should not be read');
		},
	});

	assert.throws(() => encodeGIF({
		width: 1,
		height: 1,
		blocks: [{
			type: 'rgbaImage',
			width: 1,
			height: 1,
			pixels: oversizedRedGreenBlueAlphaPixels,
		}],
	}), {message: 'image.pixels length must be 4, got 10000000'});

	const oversizedImagePixelCount = 10_001 * 10_000;
	const oversizedEncodeIndexedPixels = [];
	oversizedEncodeIndexedPixels.length = oversizedImagePixelCount;
	Object.defineProperty(oversizedEncodeIndexedPixels, 0, {
		get() {
			throw new Error('oversized encode indexedPixels should not be read');
		},
	});

	assert.throws(() => encodeGIF({
		width: 10_001,
		height: 10_000,
		globalColorTable: blackWhiteGlobalColorTable,
		blocks: [{
			type: 'image',
			width: 10_001,
			height: 10_000,
			pixels: oversizedEncodeIndexedPixels,
		}],
	}), {message: 'encode work cost 100010000 exceeds the limit of 100000000'});

	const oversizedEncodeRedGreenBlueAlphaPixels = [];
	oversizedEncodeRedGreenBlueAlphaPixels.length = oversizedImagePixelCount * 4;
	Object.defineProperty(oversizedEncodeRedGreenBlueAlphaPixels, 0, {
		get() {
			throw new Error('oversized encode pixels should not be read');
		},
	});

	assert.throws(() => encodeGIF({
		width: 10_001,
		height: 10_000,
		blocks: [{
			type: 'image',
			width: 10_001,
			height: 10_000,
			pixels: oversizedEncodeRedGreenBlueAlphaPixels,
		}],
	}), {message: 'encode work cost 100010000 exceeds the limit of 100000000'});

	const oversizedIndexedImagePixelCount = 4097 * 4096;
	const oversizedIndexedImagePixels = [];
	oversizedIndexedImagePixels.length = oversizedIndexedImagePixelCount * 4;
	Object.defineProperty(oversizedIndexedImagePixels, 0, {
		get() {
			throw new Error('oversized RGBA pixels should not be read');
		},
	});

	assert.throws(() => encodeGIF({
		width: 4097,
		height: 4096,
		blocks: [{
			type: 'rgbaImage',
			width: 4097,
			height: 4096,
			pixels: oversizedIndexedImagePixels,
		}],
	}), {message: 'RGBA image data has 16781312 pixels, which exceeds the limit of 16777216'});
});

test('rejects render inputs that exceed internal output limits', () => {
	assert.throws(() => renderGIFFrames({
		width: 5000,
		height: 4000,
		globalColorTable: blackWhiteGlobalColorTable,
		blocks: [],
	}), {message: 'logical screen has 20000000 pixels, which exceeds the limit of 16777216'});

	const sparseBlocks = [];
	sparseBlocks.length = 100_001;
	assert.throws(() => renderGIFFrames({
		width: 1,
		height: 1,
		globalColorTable: blackWhiteGlobalColorTable,
		blocks: sparseBlocks,
	}), {message: 'render block count 100001 exceeds the limit of 100000'});

	let didReadSecondFramePixels = false;
	const secondFrame = {
		type: 'image',
		width: 1,
		height: 1,
		get pixels() {
			didReadSecondFramePixels = true;
			throw new Error('second frame pixels should not be read');
		},
	};

	assert.throws(() => renderGIFFrames({
		width: 4096,
		height: 4096,
		globalColorTable: blackWhiteGlobalColorTable,
		blocks: [
			{
				type: 'image',
				width: 1,
				height: 1,
				pixels: [1],
			},
			secondFrame,
		],
	}), {message: 'rendered frame pixels has 33554432 pixels, which exceeds the limit of 16777216'});
	assert.equal(didReadSecondFramePixels, false);
});

test('rejects RGBA input that exceeds internal pixel limits', () => {
	assert.throws(
		() => createIndexedImage(new Uint8ClampedArray((16_777_216 + 1) * 4)),
		{message: 'pixels has 16777217 pixels, which exceeds the limit of 16777216'},
	);
});

test('rejects decode inputs that exceed internal block limits', () => {
	const commentBlocks = [];
	for (let index = 0; index <= 100_000; index += 1) {
		commentBlocks.push(...commentExtensionBytes([]));
	}

	const header = bytes(
		...gifSignature,
		...gif89aVersion,
		...logicalScreenBytes({packedField: 0}),
	);
	const gif = new Uint8Array(header.length + commentBlocks.length + 1);
	gif.set(header);
	gif.set(commentBlocks, header.length);
	gif[gif.length - 1] = 0x3B;
	assert.throws(() => decodeGIF(gif), {message: /block count 100001 exceeds/v});

	const sparseBlocks = [];
	sparseBlocks.length = 100_001;
	Object.defineProperty(sparseBlocks, 0, {
		get() {
			throw new Error('blocks should not be read');
		},
	});

	assert.throws(() => encodeGIF({
		width: 1,
		height: 1,
		globalColorTable: blackWhiteGlobalColorTable,
		blocks: sparseBlocks,
	}), {message: 'block count 100001 exceeds the limit of 100000'});

	const imageBlockWithGraphicControlExtension = {
		type: 'image',
		width: 1,
		height: 1,
		graphicControlExtension: {
			delay: 0.01,
		},
		pixels: [0],
	};
	assert.throws(() => encodeGIF({
		width: 1,
		height: 1,
		globalColorTable: blackWhiteGlobalColorTable,
		blocks: Array.from({length: 50_001}, () => imageBlockWithGraphicControlExtension),
	}), {message: 'block count 100002 exceeds the limit of 100000'});

	const transparentColorAlphaImageBlock = {
		type: 'rgbaImage',
		width: 1,
		height: 1,
		pixels: [
			0,
			0,
			0,
			0,
		],
	};
	assert.throws(() => encodeGIF({
		width: 1,
		height: 1,
		blocks: Array.from({length: 50_001}, () => transparentColorAlphaImageBlock),
	}), {message: 'block count 100002 exceeds the limit of 100000'});
});

test('counts graphic control extensions toward internal block limits', () => {
	const graphicControlExtensions = [];
	for (let index = 0; index <= 100_000; index += 1) {
		graphicControlExtensions.push(...graphicControlExtensionBytes());
	}

	const header = bytes(
		...gifSignature,
		...gif89aVersion,
		...logicalScreenBytes({packedField: 0}),
	);
	const gif = new Uint8Array(header.length + graphicControlExtensions.length + 1);
	gif.set(header);
	gif.set(graphicControlExtensions, header.length);
	gif[gif.length - 1] = 0x3B;
	assert.throws(() => decodeGIF(gif, {strict: false}), {message: /block count 100001 exceeds/v});
});

test('rejects data payloads that exceed internal sub-block limits', () => {
	const commentSubBlocks = [];
	for (let index = 0; index <= 300_000; index += 1) {
		commentSubBlocks.push(1, 0x41);
	}

	const header = bytes(
		...gifSignature,
		...gif89aVersion,
		...logicalScreenBytes({packedField: 0}),
		0x21,
		0xFE,
	);
	const gif = new Uint8Array(header.length + commentSubBlocks.length + 1);
	gif.set(header);
	gif.set(commentSubBlocks, header.length);
	gif[gif.length - 1] = 0x3B;
	assert.throws(() => decodeGIF(gif), {message: /data sub-block count 300001 exceeds/v});
});

test('rejects data payloads that exceed internal byte limits', () => {
	const maximumDataPayloadByteLength = 64 * 1024 * 1024;
	const payloadByteLength = maximumDataPayloadByteLength + 1;
	const fullSubBlockCount = Math.floor(payloadByteLength / 255);
	const lastSubBlockByteLength = payloadByteLength % 255;
	const header = bytes(
		...gifSignature,
		...gif89aVersion,
		...logicalScreenBytes({packedField: 0}),
		0x21,
		0xFE,
	);
	const gif = new Uint8Array(header.length + (fullSubBlockCount * 256) + 1 + lastSubBlockByteLength + 2);
	gif.set(header);
	let offset = header.length;
	for (let index = 0; index < fullSubBlockCount; index += 1) {
		gif[offset] = 255;
		offset += 1;
		gif.fill(0x41, offset, offset + 255);
		offset += 255;
	}

	gif[offset] = lastSubBlockByteLength;
	offset += 1;
	gif.fill(0x41, offset, offset + lastSubBlockByteLength);
	offset += lastSubBlockByteLength;
	gif[offset] = 0;
	gif[offset + 1] = 0x3B;
	assert.throws(() => decodeGIF(gif), {message: 'data payload has 67108865 bytes, which exceeds the limit of 67108864'});

	const oversizedCommentData = [];
	oversizedCommentData.length = maximumDataPayloadByteLength + 1;
	Object.defineProperty(oversizedCommentData, 0, {
		get() {
			throw new Error('commentExtension.data should not be read');
		},
	});

	assert.throws(() => encodeGIF({
		width: 1,
		height: 1,
		globalColorTable: blackWhiteGlobalColorTable,
		blocks: [{
			type: 'commentExtension',
			data: oversizedCommentData,
		}],
	}), {message: 'commentExtension.data has 67108865 bytes, which exceeds the limit of 67108864'});

	assert.throws(() => encodeGIF({
		width: 1,
		height: 1,
		globalColorTable: blackWhiteGlobalColorTable,
		blocks: [{
			type: 'commentExtension',
			data: 'é',
		}],
	}), {message: 'commentExtension.data must contain only ASCII characters'});
});

test('rejects encode input that exceeds the cumulative internal limit', () => {
	const maximumDataPayloadByteLength = 64 * 1024 * 1024;
	const sharedPayload = new Uint8Array(maximumDataPayloadByteLength);

	assert.throws(() => encodeGIF({
		width: 1,
		height: 1,
		globalColorTable: blackWhiteGlobalColorTable,
		blocks: [
			{
				type: 'commentExtension',
				data: sharedPayload,
			},
			{
				type: 'commentExtension',
				data: sharedPayload,
			},
		],
	}), {message: 'encode work cost 134217728 exceeds the limit of 100000000'});
});

test('rejects image blocks without pixel data or an active color table', () => {
	assert.throws(() => encodeGIF({
		width: 1,
		height: 1,
		blocks: [{
			type: 'image',
			width: 1,
			height: 1,
		}],
	}), {message: /requires a color table or a global color table/v});

	assert.throws(() => encodeGIF({
		width: 1,
		height: 1,
		globalColorTable: blackWhiteGlobalColorTable,
		blocks: [{
			type: 'image',
			width: 1,
			height: 1,
		}],
	}), {message: /requires pixels/v});
});

test('rejects invalid disposal methods while encoding', () => {
	const gif = {
		width: 1,
		height: 1,
		globalColorTable: blackWhiteGlobalColorTable,
		blocks: [{
			type: 'image',
			width: 1,
			height: 1,
			graphicControlExtension: {
				disposalMethod: 'reserved',
			},
			pixels: [1],
		}],
	};
	assert.throws(() => encodeGIF(gif), {message: /disposalMethod/v});
});

test('rejects invalid graphic control fields while encoding', () => {
	assert.throws(() => encodeGIF({
		width: 1,
		height: 1,
		globalColorTable: blackWhiteGlobalColorTable,
		blocks: [{
			type: 'image',
			width: 1,
			height: 1,
			graphicControlExtension: {
				delay: 655.36,
			},
			pixels: [1],
		}],
	}), {message: /delay must be a number between 0 and 655.35/v});

	assert.throws(() => encodeGIF({
		width: 1,
		height: 1,
		globalColorTable: blackWhiteGlobalColorTable,
		blocks: [{
			type: 'image',
			width: 1,
			height: 1,
			graphicControlExtension: {
				transparentColorIndex: -1,
			},
			pixels: [1],
		}],
	}), {message: /transparentColorIndex must be an integer between 0 and 255/v});
});
