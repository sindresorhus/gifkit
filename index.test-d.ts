import {expectAssignable, expectError, expectType} from 'tsd';
import {
	indexedImage,
	decodeAnimatedGIF,
	decodeGIF,
	encodeAnimatedGIF,
	encodeGIF,
	renderGIFFrameSequence,
	renderGIFFrames,
	type GIF,
	type GIFPlayCount,
	type EncodableGIF,
	type DisposalMethod,
	type GIFVersion,
	type ColorTable,
	type ExtensionPayload,
	type FixedByteField,
	type GraphicControlExtension,
	type AppExtensionBlock,
	type CommentExtensionBlock,
	type ImageBlock,
	type RGBAImage,
	type EncodableImageBlock,
	type GIFBlock,
	type EncodableGIFBlock,
	type UnknownExtensionBlock,
	type DecodeOptions,
	type DecodedAnimatedGIF,
	type DecodedAnimatedGIFFrame,
	type EncodeAnimatedGIFOptions,
	type RenderOptions,
	type GIFFrameSequenceOptions,
	type RenderedFrame,
	type RenderedGIFFrame,
	type RenderedGIF,
	type AnimatedGIFFrame,
	type IndexedImage,
} from './index.js';

expectAssignable<GIFVersion>('87a');
expectAssignable<GIFVersion>('89a');
expectError<GIFVersion>('90a');
expectAssignable<GIFPlayCount>(5);
expectAssignable<GIFPlayCount>('forever');
expectError<GIFPlayCount>(null);
expectAssignable<DisposalMethod>('restoreBackground');
expectError<DisposalMethod>(2);

expectAssignable<ColorTable>(new Uint8Array());
expectAssignable<ColorTable>([0, 0, 0, 255, 255, 255]);
expectAssignable<ColorTable>([[0, 0, 0], [255, 255, 255]]);
expectError<ColorTable>([[0, 0]]);

expectAssignable<ExtensionPayload>('hello');
expectAssignable<ExtensionPayload>(new Uint8Array());
expectAssignable<ExtensionPayload>([0, 128, 255]);
expectError<ExtensionPayload>([0, '1']);

expectAssignable<FixedByteField>('APPBIN01');
expectAssignable<FixedByteField>(new Uint8Array([0, 128, 255]));
expectAssignable<FixedByteField>([0, 128, 255]);
expectError<FixedByteField>([0, false]);

expectAssignable<DecodeOptions>({
	strict: false,
});
expectError<DecodeOptions>({
	strict: 'true',
});

expectAssignable<RenderOptions>({
	background: 'transparent',
	strict: false,
});
expectError<RenderOptions>({
	initialPixels: new Uint8ClampedArray(),
});
expectError<RenderOptions>({
	background: 'invalid',
});
expectAssignable<GIFFrameSequenceOptions>({
	background: 'gif',
	repeat: true,
	signal: new AbortController().signal,
});
expectError<GIFFrameSequenceOptions>({
	repeat: 'true',
});

const gif = {
	width: 1,
	height: 1,
	globalColorTable: [
		[0, 0, 0],
		[255, 255, 255],
	],
	blocks: [{
		type: 'image',
		width: 1,
		height: 1,
		pixels: [1],
	}],
} satisfies GIF & EncodableGIF;

expectAssignable<GIF>(gif);
expectAssignable<EncodableGIF>(gif);
expectType<Uint8Array>(encodeGIF(gif));
expectType<GIF>(decodeGIF(new Uint8Array()));
expectError(decodeGIF([0x47, 0x49, 0x46]));
expectType<Uint8Array | number[] | Array<[number, number, number]> | undefined>(decodeGIF(new Uint8Array()).globalColorTable);
expectType<GIFPlayCount | undefined>(decodeGIF(new Uint8Array()).playCount);
expectError(decodeGIF(new Uint8Array()).loopCount);
expectError(decodeGIF(new Uint8Array(), {
	maxBlocks: 1,
}));
const decodedAnimatedGif = decodeAnimatedGIF(new Uint8Array(), {
	background: 'transparent',
});
expectType<DecodedAnimatedGIF>(decodedAnimatedGif);
expectType<DecodedAnimatedGIFFrame>(decodedAnimatedGif.frames[0]);
expectType<Uint8ClampedArray>(decodedAnimatedGif.frames[0]?.pixels);
expectType<number>(decodedAnimatedGif.frames[0]?.delay);
expectError(decodeAnimatedGIF(new Uint8Array(), {
	background: 'invalid',
}));
expectType<Uint8Array>(indexedImage(new Uint8ClampedArray()).pixels);
expectType<Uint8ClampedArray>(renderGIFFrames(gif, {
	background: 'transparent',
}).frames[0].pixels);
expectError(renderGIFFrames(gif, {
	maxCanvasPixels: 1,
}));
expectError(encodeGIF(gif, {
	background: 'transparent',
}));
expectError(encodeGIF({
	version: '87a',
	width: 1,
	height: 1,
	blocks: [],
}));

const decodedImageBlock = decodeGIF(new Uint8Array()).imageBlocks?.[0];
expectType<ImageBlock | undefined>(decodedImageBlock);
expectType<Uint8Array | number[] | Array<[number, number, number]> | undefined>(decodedImageBlock?.colorTable);
expectType<number | undefined>(decodedImageBlock?.graphicControlExtension?.transparentColorIndex);

const graphicControlExtension = {
	disposalMethod: 'restoreBackground',
	transparentColorIndex: undefined,
} satisfies GraphicControlExtension;

const commentExtensionBlock = {
	type: 'commentExtension',
	data: new Uint8Array([0, 1, 2]),
} satisfies CommentExtensionBlock;
expectAssignable<EncodableGIFBlock>(commentExtensionBlock);

const binaryAppExtensionBlock = {
	type: 'applicationExtension',
	identifier: 'APPBIN01',
	authenticationCode: [0, 128, 255],
} satisfies AppExtensionBlock;
expectAssignable<EncodableGIFBlock>(binaryAppExtensionBlock);
expectAssignable<AppExtensionBlock>({
	type: 'applicationExtension',
	identifier: 'APPNAME1',
	authenticationCode: 'abc',
});
expectError<AppExtensionBlock>({
	type: 'applicationExtension',
	identifier: 'APPNAME1',
});

const redGreenBlueAlphaImageBlock = {
	type: 'rgbaImage',
	width: 1,
	height: 1,
	pixels: new Uint8ClampedArray([255, 0, 0, 255]),
	transparentColor: [0, 0, 0],
	graphicControlExtension,
} satisfies RGBAImage;
expectAssignable<EncodableGIFBlock>(redGreenBlueAlphaImageBlock);
expectError<EncodableImageBlock>({
	type: 'image',
	width: 1,
	height: 1,
	minimumCodeSize: 2,
	pixels: [0],
});
const decodedImageBlockWithMinimumCodeSize = {
	type: 'image',
	width: 1,
	height: 1,
	minimumCodeSize: 2,
	pixels: [0],
} satisfies ImageBlock;
expectError<EncodableImageBlock>(decodedImageBlockWithMinimumCodeSize);
expectError<ImageBlock>({
	type: 'image',
	height: 1,
	pixels: [0],
});
expectError<ImageBlock>({
	type: 'image',
	width: 1,
	pixels: [0],
});

const unknownExtensionBlock: UnknownExtensionBlock = {
	type: 'unknownExtension',
	extensionLabel: 0x7F,
	fixedData: new Uint8Array(),
	data: new Uint8Array(),
};
expectAssignable<GIFBlock>(unknownExtensionBlock);
expectError<EncodableGIFBlock>(unknownExtensionBlock);
expectError(encodeGIF({
	width: 1,
	height: 1,
	blocks: [unknownExtensionBlock],
}));
const decodedGif: GIF = decodeGIF(new Uint8Array());
expectError(encodeGIF(decodedGif));

expectError<EncodableGIF>({
	width: 1,
	height: 1,
	imageBlocks: [redGreenBlueAlphaImageBlock],
});
expectError<EncodableGIF>({
	width: 1,
	height: 1,
	playCount: null,
});
expectError<EncodableGIF>({
	width: 1,
	height: 1,
	loopCount: 0,
});
expectAssignable<EncodableGIF>({
	width: 1,
	height: 1,
	playCount: 'forever',
});
expectError<EncodableGIF>({
	width: 1,
	height: 1,
	version: '89a',
});
expectError<EncodableGIF>({
	width: 1,
	height: 1,
	pixelAspectRatio: 49,
});
expectError(encodeGIF({
	width: 1,
	height: 1,
	blocks: [{
		type: 'rgbaImage',
		width: 1,
		height: 1,
		pixels: new Uint8ClampedArray([0, 0, 0, 0]),
		transparentColor: [0, 0],
	}],
}));
expectError(encodeGIF({
	width: 1,
	height: 1,
	blocks: [{
		type: 'rgbaImage',
		width: 1,
		height: 1,
		pixels: new Uint8ClampedArray([0, 0, 0, 0]),
		transparentColor: [0, 0, 0, 0],
	}],
}));

const animatedFrame = new Uint8ClampedArray([255, 0, 0, 255]) satisfies AnimatedGIFFrame;
expectType<Uint8Array>(encodeAnimatedGIF([animatedFrame], {
	width: 1,
	height: 1,
	fps: 14,
	playCount: 5,
	quality: 0.7,
}));
expectType<Uint8Array>(encodeAnimatedGIF([{
	pixels: [255, 0, 0, 255],
	delay: 0.1,
}], {
	width: 1,
	height: 1,
}));
expectAssignable<EncodeAnimatedGIFOptions>({
	width: 1,
	height: 1,
	quality: 0.7,
});
expectError<EncodeAnimatedGIFOptions>({
	width: 1,
	height: 1,
	playCount: null,
});
expectError<EncodeAnimatedGIFOptions>({
	width: 1,
	height: 1,
	loopCount: 0,
});
expectAssignable<EncodeAnimatedGIFOptions>({
	width: 1,
	height: 1,
	playCount: 'forever',
});
expectAssignable<EncodeAnimatedGIFOptions & {fps: number}>({
	width: 1,
	height: 1,
	fps: 14,
	quality: 0.7,
});
expectError(encodeAnimatedGIF([animatedFrame], {
	width: 1,
	height: 1,
}));
expectError(encodeAnimatedGIF([[255, 0, 0, 255]], {
	width: 1,
	height: 1,
	fps: 14,
}));
expectError(encodeAnimatedGIF([{
	pixels: [255, 0, 0, 255],
	delay: 0.1,
}], {
	width: 1,
	height: 1,
	fps: 14,
}));
expectError(encodeAnimatedGIF([animatedFrame], {
	width: 1,
	fps: 14,
}));

const renderedGif = renderGIFFrames(gif);
expectType<RenderedGIF>(renderedGif);
expectType<number>(renderedGif.width);
expectType<number>(renderedGif.height);
expectType<GIFPlayCount | undefined>(renderedGif.playCount);
expectError(renderedGif.loopCount);
expectType<RenderedFrame>(renderedGif.frames[0]);
expectType<Uint8ClampedArray>(renderedGif.frames[0]?.pixels);
expectError(renderedGif.finalPixels);

const renderedFrameSequence = renderGIFFrameSequence(gif, {
	background: 'gif',
	strict: false,
	repeat: true,
	signal: new AbortController().signal,
});
expectType<IterableIterator<RenderedGIFFrame>>(renderedFrameSequence);
expectAssignable<Iterable<RenderedGIFFrame>>(renderedFrameSequence);
expectAssignable<RenderedGIFFrame>({
	...renderedGif.frames[0],
	index: 0,
	loopIndex: 0,
});
expectError(renderGIFFrameSequence(gif, {
	repeat: 'true',
}));

const convertedImage = indexedImage(new Uint8ClampedArray([0, 0, 0, 0]), {
	transparentColor: [0, 0, 0],
});
expectType<IndexedImage>(indexedImage(new Uint8Array()));
expectType<IndexedImage>(convertedImage);
expectType<Uint8Array>(convertedImage.pixels);
expectAssignable<ColorTable>(convertedImage.colorTable);
expectType<number | undefined>(convertedImage.transparentColorIndex);
expectError(indexedImage([0, 0, 0, 0]));
expectError(indexedImage(new Uint8ClampedArray(), {
	transparentColor: [0, 0],
}));
expectError(indexedImage(new Uint8ClampedArray(), {
	transparentColor: [0, 0, 0, 0],
}));
