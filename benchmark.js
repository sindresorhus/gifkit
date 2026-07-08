import fs from 'node:fs';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import {fileURLToPath} from 'node:url';
import {
	decodeGIF,
	encodeGIF,
	renderGIFFrames,
} from './index.js';

const fixtureDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const generatedGIFs = [
	createPatternGIF({
		width: 320,
		height: 240,
		colorCount: 256,
		seed: 17,
	}),
	createPatternGIF({
		width: 96,
		height: 96,
		colorCount: 16,
		seed: 43,
	}),
	createAnimationGIF(),
];
const generatedEncodedGIFs = generatedGIFs.map(gif => encodeGIF(gif));
const fixtureEncodedGIFs = [
	'tiny-2x2.gif',
	'looped-animation.gif',
	'beacon-icc-profile.gif',
].map(fileName => fs.readFileSync(path.join(fixtureDirectory, fileName)));
const encodedGIFs = [
	...generatedEncodedGIFs,
	...fixtureEncodedGIFs,
];
const decodedGIFs = encodedGIFs.map(bytes => decodeGIF(bytes));

const corpusSummary = [
	`${generatedGIFs.length} generated GIFs`,
	`${fixtureEncodedGIFs.length} fixture GIFs`,
	`${sumBytes(encodedGIFs)} encoded bytes`,
	`${sumFrames(decodedGIFs)} decoded frames`,
	`${sumRenderedPixels(decodedGIFs)} rendered pixels per pass`,
].join(', ');
console.log(`Corpus: ${corpusSummary}`);

runBenchmark('encode generated corpus', 750, () => {
	for (const gif of generatedGIFs) {
		encodeGIF(gif);
	}
});

runBenchmark('decode generated+fixture corpus', 1500, () => {
	for (const bytes of encodedGIFs) {
		decodeGIF(bytes);
	}
});

runBenchmark('render generated+fixture corpus', 1500, () => {
	for (const gif of decodedGIFs) {
		renderGIFFrames(gif, {backgroundMode: 'transparent'});
	}
});

runBenchmark('decode+render generated+fixture corpus', 750, () => {
	for (const bytes of encodedGIFs) {
		renderGIFFrames(decodeGIF(bytes), {backgroundMode: 'transparent'});
	}
});

function runBenchmark(name, iterationCount, body) {
	for (let index = 0; index < 10; index += 1) {
		body();
	}

	const startTime = performance.now();
	for (let index = 0; index < iterationCount; index += 1) {
		body();
	}

	const elapsedMilliseconds = performance.now() - startTime;
	const operationsPerSecond = iterationCount / (elapsedMilliseconds / 1000);
	console.log(`${name}: ${operationsPerSecond.toFixed(0)} passes/sec (${elapsedMilliseconds.toFixed(1)} ms)`);
}

function createPatternGIF({width, height, colorCount, seed}) {
	return {
		width,
		height,
		globalColorTable: createColorTable(colorCount),
		blocks: [{
			type: 'image',
			width,
			height,
			indexedPixels: createIndexedPixels({
				width, height, colorCount, seed,
			}),
		}],
	};
}

function createAnimationGIF() {
	const width = 160;
	const height = 120;
	const colorCount = 64;
	const blocks = [];
	for (let frameIndex = 0; frameIndex < 12; frameIndex += 1) {
		blocks.push({
			type: 'image',
			width,
			height,
			graphicControlExtension: {
				delayTimeInHundredthsOfASecond: 4,
				disposalMethod: frameIndex % 3 === 0 ? 2 : 0,
				transparentColorIndex: frameIndex % 2 === 0 ? 0 : undefined,
			},
			indexedPixels: createAnimatedIndexedPixels({
				width,
				height,
				colorCount,
				frameIndex,
			}),
		});
	}

	return {
		width,
		height,
		playCount: 'forever',
		globalColorTable: createColorTable(colorCount),
		blocks,
	};
}

function createColorTable(colorCount) {
	const colorTable = new Uint8Array(colorCount * 3);
	for (let colorIndex = 0; colorIndex < colorCount; colorIndex += 1) {
		const offset = colorIndex * 3;
		colorTable[offset] = (colorIndex * 47) & 0xFF;
		colorTable[offset + 1] = (colorIndex * 91) & 0xFF;
		colorTable[offset + 2] = (colorIndex * 151) & 0xFF;
	}

	return colorTable;
}

function createIndexedPixels({width, height, colorCount, seed}) {
	const indexedPixels = new Uint8Array(width * height);
	for (let offset = 0; offset < indexedPixels.length; offset += 1) {
		const x = offset % width;
		const y = Math.floor(offset / width);
		indexedPixels[offset] = ((x * 13) + (y * 29) + (Math.floor(x / 7) * 11) + (Math.floor(y / 5) * 17) + seed) % colorCount;
	}

	return indexedPixels;
}

function createAnimatedIndexedPixels({width, height, colorCount, frameIndex}) {
	const indexedPixels = new Uint8Array(width * height);
	const spriteLeft = (frameIndex * 11) % (width - 32);
	const spriteTop = (frameIndex * 7) % (height - 32);

	for (let offset = 0; offset < indexedPixels.length; offset += 1) {
		const x = offset % width;
		const y = Math.floor(offset / width);
		const isSprite = x >= spriteLeft && x < spriteLeft + 32 && y >= spriteTop && y < spriteTop + 32;
		indexedPixels[offset] = isSprite
			? (((x + y + (frameIndex * 5)) % (colorCount - 1)) + 1)
			: (frameIndex % 2 === 0 ? 0 : (((x * 3) + (y * 5) + frameIndex) % colorCount));
	}

	return indexedPixels;
}

function sumBytes(buffers) {
	let total = 0;
	for (const bytes of buffers) {
		total += bytes.length;
	}

	return total;
}

function sumFrames(gifs) {
	let total = 0;
	for (const gif of gifs) {
		total += gif.imageBlocks.length;
	}

	return total;
}

function sumRenderedPixels(gifs) {
	let total = 0;
	for (const gif of gifs) {
		total += gif.width * gif.height * gif.imageBlocks.length;
	}

	return total;
}
