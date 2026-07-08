import {decodeGIF} from './source/decode.js';
import {encodeGIF} from './source/encode.js';
import {renderGIFFrames} from './source/render.js';
import {buildQuantizedIndexedImage} from './source/quantize.js';
import {
	isUint8Array,
	isUint8ClampedArray,
	requireNonZeroUnsigned16,
	requireFiniteNumberInRange,
	requirePositiveFiniteNumber,
	normalizeRedGreenBlueAlphaPixels,
} from './source/validate.js';
import {rejectRenamedLoopCount} from './source/loop-count.js';

export {decodeGIF} from './source/decode.js';
export {encodeGIF} from './source/encode.js';
export {renderGIFFrameSequence, renderGIFFrames} from './source/render.js';
export {indexedImage} from './source/quantize.js';

export function decodeAnimatedGIF(inputBytes, options = {}) {
	const gif = decodeGIF(inputBytes, options);
	const rendered = renderGIFFrames(gif, {
		background: options.background ?? 'transparent',
		strict: options.strict,
	});

	return {
		width: rendered.width,
		height: rendered.height,
		...(rendered.playCount !== undefined && {playCount: rendered.playCount}),
		frames: rendered.frames.map(frame => ({
			pixels: frame.pixels,
			delay: frame.delay,
		})),
	};
}

export function encodeAnimatedGIF(frames, options = {}) {
	if (!Array.isArray(frames) || frames.length === 0) {
		throw new TypeError('frames must be a non-empty array');
	}

	const width = requireNonZeroUnsigned16(options.width, 'width');
	const height = requireNonZeroUnsigned16(options.height, 'height');
	const quality = requireFiniteNumberInRange(options.quality ?? 0.8, 0, 1, 'quality');
	rejectRenamedLoopCount(options);
	const hasFrameDelays = frames.some(frame => isAnimationFrameObject(frame) && frame.delay !== undefined);
	if (options.fps !== undefined && hasFrameDelays) {
		throw new Error('fps cannot be combined with per-frame delay');
	}

	if (options.fps === undefined && frames.some(frame => !isAnimationFrameObject(frame) || frame.delay === undefined)) {
		throw new Error('fps is required unless every frame has a delay');
	}

	const frameDelay = options.fps === undefined
		? undefined
		: 1 / requirePositiveFiniteNumber(options.fps, 'fps');

	const blocks = frames.map((frame, index) => {
		const pixels = normalizeAnimationFramePixels(frame, width * height * 4, `frames[${index}]`);
		const delay = frameDelay ?? requireFiniteNumberInRange(frame.delay, 0, 655.35, `frames[${index}].delay`);
		const imageBlock = {
			type: 'rgbaImage',
			width,
			height,
			graphicControlExtension: {
				delay,
			},
		};

		if (quality === 1) {
			return {
				...imageBlock,
				pixels,
			};
		}

		const quantizedImage = buildQuantizedIndexedImage(pixels, {quality});
		return {
			type: 'image',
			width,
			height,
			pixels: quantizedImage.pixels,
			colorTable: quantizedImage.colorTable,
			graphicControlExtension: {
				delay,
				transparentColorIndex: quantizedImage.transparentColorIndex,
			},
		};
	});

	const gif = {
		width,
		height,
		blocks,
	};
	if (options.playCount !== undefined) {
		gif.playCount = options.playCount;
	}

	return encodeGIF(gif);
}

function normalizeAnimationFramePixels(frame, expectedLength, fieldName) {
	const pixels = isAnimationFrameObject(frame)
		? frame.pixels
		: frame;
	return normalizeRedGreenBlueAlphaPixels(pixels, expectedLength, fieldName);
}

function isAnimationFrameObject(frame) {
	return frame !== null
		&& typeof frame === 'object'
		&& !isUint8Array(frame)
		&& !isUint8ClampedArray(frame)
		&& !Array.isArray(frame);
}
