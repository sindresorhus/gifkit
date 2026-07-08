import {
	defaultMaximumPixelCount,
	defaultMaximumRenderPixelCount,
	defaultMaximumBlockCount,
	isLittleEndian,
} from './constants.js';
import {
	requireByte,
	requireNonZeroUnsigned16,
	requireBlockObject,
	requireCountWithinLimit,
	requirePixelCountWithinLimit,
	requirePixelCountValueWithinLimit,
	normalizeColorTable,
	normalizeIndexedPixels,
	normalizeImageGeometry,
	normalizeGraphicControlExtension,
} from './validate.js';
import {rejectRenamedLoopCount, normalizePlayCount, renderTotalPlayCount} from './loop-count.js';

export function renderGIFFrameSequence(gif, options = {}) {
	const {
		repeat,
		signal,
		...renderOptions
	} = normalizeFrameSequenceOptions(options);

	if (signal?.aborted) {
		return emptyGIFFrameSequence();
	}

	const renderState = createGIFRenderState(gif, renderOptions);
	return renderGIFFrameSequenceFromState(renderState, {repeat, signal});
}

export function renderGIFFrames(gif, options = {}) {
	const renderState = createGIFRenderState(gif, normalizeRenderOptions(options));
	const renderedFrames = [];
	let renderedPixelCount = 0;
	const beforeRenderFrame = () => {
		renderedPixelCount += renderState.logicalScreenPixelCount;
		requirePixelCountValueWithinLimit(renderedPixelCount, defaultMaximumRenderPixelCount, 'rendered frame pixels');
	};

	for (const frame of renderGIFFrameSequenceFromState(renderState, {beforeRenderFrame})) {
		renderedFrames.push(toRenderedFrame(frame));
	}

	return {
		width: renderState.logicalScreenWidth,
		height: renderState.logicalScreenHeight,
		...(renderState.playCount !== undefined && {playCount: renderState.playCount}),
		frames: renderedFrames,
	};
}

function createGIFRenderState(gif, renderOptions) {
	const {background, strict} = renderOptions;

	if (!gif || typeof gif !== 'object') {
		throw new TypeError('Expected a decoded GIF object');
	}

	const logicalScreenWidth = requireNonZeroUnsigned16(gif.width, 'width');
	const logicalScreenHeight = requireNonZeroUnsigned16(gif.height, 'height');
	const logicalScreenPixelCount = requirePixelCountWithinLimit(logicalScreenWidth, logicalScreenHeight, defaultMaximumRenderPixelCount, 'logical screen');
	const globalColorTable = normalizeColorTable(gif.globalColorTable, 'globalColorTable');
	const backgroundColorIndex = requireByte(gif.backgroundColorIndex ?? 0, 'backgroundColorIndex');
	rejectRenamedLoopCount(gif);

	const playCount = gif.playCount === undefined
		? undefined
		: normalizePlayCount(gif.playCount, 'playCount');

	let blocks;
	if (gif.blocks === undefined) {
		blocks = [];
	} else if (Array.isArray(gif.blocks)) {
		blocks = gif.blocks;
	} else {
		throw new TypeError('blocks must be an array');
	}

	requireCountWithinLimit(blocks.length, defaultMaximumBlockCount, 'render block count');
	const canvasPixels = new Uint8ClampedArray(logicalScreenWidth * logicalScreenHeight * 4);

	const renderContext = {
		logicalScreenWidth,
		logicalScreenHeight,
		globalColorTable,
		backgroundColorIndex,
		background,
		strict,
	};

	fillCanvasBackground(canvasPixels, renderContext);

	return {
		logicalScreenWidth,
		logicalScreenHeight,
		logicalScreenPixelCount,
		playCount,
		blocks,
		canvasPixels,
		renderContext,
	};
}

function * renderGIFFrameSequenceFromState(renderState, {repeat = false, signal, beforeRenderFrame} = {}) {
	if (signal?.aborted) {
		return;
	}

	const totalLoops = repeat
		? renderTotalPlayCount(renderState.playCount)
		: 1;
	const initialCanvasPixels = totalLoops > 1
		? new Uint8ClampedArray(renderState.canvasPixels)
		: undefined;
	let loopIndex = 0;

	while (loopIndex < totalLoops) {
		if (loopIndex > 0) {
			renderState.canvasPixels.set(initialCanvasPixels);
		}

		let frameIndex = 0;
		let blockIndex = 0;
		const blockCount = renderState.blocks.length;
		let isRenderedFrameInLoop = false;

		while (blockIndex < blockCount) {
			if (signal?.aborted) {
				return;
			}

			const block = renderState.blocks[blockIndex];
			blockIndex += 1;
			requireBlockObject(block);

			switch (block.type) {
				case 'image': {
					isRenderedFrameInLoop = true;
					beforeRenderFrame?.();

					yield {
						...renderImageBlockToFrame(renderState.canvasPixels, block, renderState.renderContext),
						index: frameIndex,
						loopIndex,
					};

					frameIndex += 1;

					break;
				}

				case 'commentExtension':
				case 'applicationExtension':
				case 'unknownExtension': {
					break;
				}

				default: {
					throw new Error(`Unsupported block type ${JSON.stringify(block.type)}`);
				}
			}
		}

		if (!isRenderedFrameInLoop) {
			return;
		}

		loopIndex += 1;
	}
}

function * emptyGIFFrameSequence() {}

function toRenderedFrame(frame) {
	return {
		left: frame.left,
		top: frame.top,
		width: frame.width,
		height: frame.height,
		delay: frame.delay,
		disposalMethod: frame.disposalMethod,
		pixels: frame.pixels,
	};
}

function normalizeRenderOptions(options) {
	const {
		background = 'gif',
		strict = true,
	} = options;

	if (background !== 'transparent' && background !== 'gif') {
		throw new TypeError(`background must be 'transparent' or 'gif', got ${JSON.stringify(background)}`);
	}

	if (typeof strict !== 'boolean') {
		throw new TypeError(`strict must be a boolean, got ${JSON.stringify(strict)}`);
	}

	return {
		background,
		strict,
	};
}

function normalizeFrameSequenceOptions(options) {
	const renderOptions = normalizeRenderOptions(options);

	const {
		repeat = true,
		signal,
	} = options;

	if (typeof repeat !== 'boolean') {
		throw new TypeError(`repeat must be a boolean, got ${JSON.stringify(repeat)}`);
	}

	if (signal !== undefined && typeof signal?.aborted !== 'boolean') {
		throw new TypeError('signal must be an AbortSignal');
	}

	return {
		...renderOptions,
		repeat,
		signal,
	};
}

function fillCanvasBackground(canvasPixels, {globalColorTable, backgroundColorIndex, background}) {
	const backgroundTriplet = getColorTriplet(globalColorTable, backgroundColorIndex);
	const isUseTransparentBackground = background === 'transparent' || backgroundTriplet === undefined;
	const red = isUseTransparentBackground ? 0 : backgroundTriplet[0];
	const green = isUseTransparentBackground ? 0 : backgroundTriplet[1];
	const blue = isUseTransparentBackground ? 0 : backgroundTriplet[2];
	const alpha = isUseTransparentBackground ? 0 : 255;

	for (let offset = 0; offset < canvasPixels.length; offset += 4) {
		canvasPixels[offset] = red;
		canvasPixels[offset + 1] = green;
		canvasPixels[offset + 2] = blue;
		canvasPixels[offset + 3] = alpha;
	}
}

function renderImageBlockToFrame(canvasPixels, imageBlock, renderContext) {
	const geometry = normalizeImageGeometry(imageBlock, {
		logicalScreenWidth: renderContext.logicalScreenWidth,
		logicalScreenHeight: renderContext.logicalScreenHeight,
	});

	const indexedPixels = normalizeIndexedPixels(imageBlock.pixels, geometry.width * geometry.height, 'image.pixels');

	if (indexedPixels === undefined) {
		throw new Error('An image block requires pixels to render');
	}

	const colorTable = normalizeColorTable(imageBlock.colorTable, 'colorTable');
	const activeColorTable = colorTable ?? renderContext.globalColorTable;
	if (activeColorTable === undefined) {
		throw new Error('Cannot render an image block without an active color table');
	}

	const graphicControlExtension = normalizeGraphicControlExtension(imageBlock.graphicControlExtension);
	requirePixelCountWithinLimit(geometry.width, geometry.height, defaultMaximumPixelCount, 'image block');
	const transparentColorIndex = graphicControlExtension?.transparentColorIndex;
	const disposalMethod = graphicControlExtension?.disposalMethod ?? 'unspecified';
	const normalizedImageBlock = {
		...imageBlock,
		...geometry,
		indexedPixels,
	};
	const activeColorTableUint32 = isLittleEndian ? createColorTableUint32(activeColorTable) : undefined;

	if (
		renderContext.strict
		&& transparentColorIndex !== undefined
		&& transparentColorIndex >= activeColorTable.length / 3
	) {
		throw new Error(`Transparent color index ${transparentColorIndex} exceeds the active color table`);
	}

	const snapshotBeforeRendering = disposalMethod === 'restorePrevious' ? new Uint8ClampedArray(canvasPixels) : undefined;

	drawIndexedImageOntoCanvas(canvasPixels, normalizedImageBlock, {
		...renderContext,
		activeColorTable,
		activeColorTableUint32,
		transparentColorIndex,
	});

	const renderedFrame = {
		left: geometry.left,
		top: geometry.top,
		width: geometry.width,
		height: geometry.height,
		delay: (graphicControlExtension?.delayInHundredthsOfASecond ?? 0) / 100,
		disposalMethod,
		pixels: new Uint8ClampedArray(canvasPixels),
	};

	if (disposalMethod === 'restoreBackground') {
		restoreAreaToBackground(canvasPixels, normalizedImageBlock, renderContext);
	} else if (snapshotBeforeRendering !== undefined) {
		canvasPixels.set(snapshotBeforeRendering);
	}

	return renderedFrame;
}

function drawIndexedImageOntoCanvas(canvasPixels, imageBlock, {activeColorTable, activeColorTableUint32, transparentColorIndex, logicalScreenWidth, strict}) {
	if (activeColorTableUint32 !== undefined) {
		drawIndexedImageOntoCanvasUint32(canvasPixels, imageBlock, {
			activeColorTableUint32,
			transparentColorIndex,
			logicalScreenWidth,
			strict,
		});
		return;
	}

	const {
		left = 0,
		top = 0,
		width,
		height,
		indexedPixels,
	} = imageBlock;
	for (let row = 0; row < height; row += 1) {
		let sourceOffset = row * width;
		let destinationOffset = (((top + row) * logicalScreenWidth) + left) * 4;

		for (let column = 0; column < width; column += 1) {
			const pixelIndex = indexedPixels[sourceOffset];

			sourceOffset += 1;

			if (transparentColorIndex !== undefined && pixelIndex === transparentColorIndex) {
				destinationOffset += 4;
				continue;
			}

			const colorOffset = pixelIndex * 3;
			if (colorOffset + 2 >= activeColorTable.length) {
				if (strict) {
					throw new Error(`Pixel index ${pixelIndex} is outside the active color table`);
				}

				destinationOffset += 4;
				continue;
			}

			canvasPixels[destinationOffset] = activeColorTable[colorOffset];
			canvasPixels[destinationOffset + 1] = activeColorTable[colorOffset + 1];
			canvasPixels[destinationOffset + 2] = activeColorTable[colorOffset + 2];
			canvasPixels[destinationOffset + 3] = 255;
			destinationOffset += 4;
		}
	}
}

function drawIndexedImageOntoCanvasUint32(canvasPixels, imageBlock, {activeColorTableUint32, transparentColorIndex, logicalScreenWidth, strict}) {
	const {
		left = 0,
		top = 0,
		width,
		height,
		indexedPixels,
	} = imageBlock;
	const canvasPixelsUint32 = new Uint32Array(canvasPixels.buffer, canvasPixels.byteOffset, canvasPixels.byteLength / Uint32Array.BYTES_PER_ELEMENT);
	for (let row = 0; row < height; row += 1) {
		let sourceOffset = row * width;
		let destinationOffset = ((top + row) * logicalScreenWidth) + left;

		for (let column = 0; column < width; column += 1) {
			const pixelIndex = indexedPixels[sourceOffset];

			sourceOffset += 1;

			if (transparentColorIndex !== undefined && pixelIndex === transparentColorIndex) {
				destinationOffset += 1;
				continue;
			}

			const color = activeColorTableUint32[pixelIndex];
			if (color === undefined) {
				if (strict) {
					throw new Error(`Pixel index ${pixelIndex} is outside the active color table`);
				}

				destinationOffset += 1;
				continue;
			}

			canvasPixelsUint32[destinationOffset] = color;
			destinationOffset += 1;
		}
	}
}

function createColorTableUint32(colorTable) {
	const colorTableUint32 = new Uint32Array(colorTable.length / 3);

	for (let colorIndex = 0; colorIndex < colorTableUint32.length; colorIndex += 1) {
		const colorOffset = colorIndex * 3;

		colorTableUint32[colorIndex] = 0xFF_00_00_00
			| (colorTable[colorOffset + 2] << 16)
			| (colorTable[colorOffset + 1] << 8)
			| colorTable[colorOffset];
	}

	return colorTableUint32;
}

function restoreAreaToBackground(canvasPixels, imageBlock, {logicalScreenWidth, logicalScreenHeight, globalColorTable, backgroundColorIndex, background}) {
	const {
		left = 0,
		top = 0,
		width,
		height,
	} = imageBlock;
	const backgroundTriplet = getColorTriplet(globalColorTable, backgroundColorIndex);
	const isUseTransparentBackground = background === 'transparent' || backgroundTriplet === undefined;
	const red = isUseTransparentBackground ? 0 : backgroundTriplet[0];
	const green = isUseTransparentBackground ? 0 : backgroundTriplet[1];
	const blue = isUseTransparentBackground ? 0 : backgroundTriplet[2];
	const alpha = isUseTransparentBackground ? 0 : 255;

	for (let row = 0; row < height; row += 1) {
		const destinationRow = top + row;
		if (destinationRow < 0 || destinationRow >= logicalScreenHeight) {
			continue;
		}

		for (let column = 0; column < width; column += 1) {
			const destinationColumn = left + column;
			if (destinationColumn < 0 || destinationColumn >= logicalScreenWidth) {
				continue;
			}

			const destinationOffset = ((destinationRow * logicalScreenWidth) + destinationColumn) * 4;
			canvasPixels[destinationOffset] = red;
			canvasPixels[destinationOffset + 1] = green;
			canvasPixels[destinationOffset + 2] = blue;
			canvasPixels[destinationOffset + 3] = alpha;
		}
	}
}

function getColorTriplet(colorTable, paletteIndex) {
	if (colorTable === undefined) {
		return undefined;
	}

	const colorOffset = paletteIndex * 3;
	if (colorOffset + 2 >= colorTable.length) {
		return undefined;
	}

	return [
		colorTable[colorOffset],
		colorTable[colorOffset + 1],
		colorTable[colorOffset + 2],
	];
}
