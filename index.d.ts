/* eslint-disable @typescript-eslint/naming-convention -- GIF block type names mirror the spec's own casing */

/**
GIF color table data as flat RGB bytes, flat byte arrays, or RGB triplets.
*/
export type ColorTable = Uint8Array | number[] | Array<[number, number, number]>;

/**
Extension payload data as ASCII text or bytes.
*/
export type ExtensionPayload = string | Uint8Array | number[];

/**
Fixed-size GIF byte field as text or exact bytes.
*/
export type FixedByteField = string | Uint8Array | number[];

/**
GIF file version.
*/
export type GIFVersion = '87a' | '89a';

/**
Total animation plays. Finite values must be integers from `1` to `65_536`. Use `'forever'` for infinite playback. Omit the property when no GIF loop extension is present.
*/
export type GIFPlayCount = number | 'forever';

/**
GIF frame disposal behavior.
*/
export type DisposalMethod = 'unspecified' | 'keep' | 'restoreBackground' | 'restorePrevious';

/**
Graphic Control Extension metadata for transparency, delay, and disposal.
*/
export type GraphicControlExtension = {
	/**
	Advanced GIF compositing metadata exposed so structured GIF data can be preserved or re-encoded. It controls what happens to the current frame’s pixels before the next frame is drawn: `'unspecified'` leaves the choice to the decoder, `'keep'` keeps the pixels, `'restoreBackground'` clears them to the background, and `'restorePrevious'` restores the previous canvas. Rendered pixels already have this applied, so most users do not need to read or set it.
	*/
	disposalMethod?: DisposalMethod;

	/**
	Frame delay in seconds.
	*/
	delay?: number;

	/**
	Palette index to treat as transparent. Omit it for no transparent color.
	*/
	transparentColorIndex?: number | undefined;
};

/**
A block holding arbitrary text with no effect on rendering.
*/
export type CommentExtensionBlock = {
	/**
	Block discriminator.
	*/
	type: 'commentExtension';

	/**
	Raw comment payload as ASCII text or bytes.
	*/
	data?: ExtensionPayload;
};

/**
Application Extension block, including Netscape play count metadata when present.
*/
export type AppExtensionBlock = {
	/**
	Block discriminator.
	*/
	type: 'applicationExtension';

	/**
	8-byte GIF application identifier.
	*/
	identifier: string;

	/**
	3-byte authentication code as text or exact bytes.
	*/
	authenticationCode: FixedByteField;

	/**
	Raw application payload as ASCII text or bytes.
	*/
	data?: ExtensionPayload;

	/**
	Whether this block is the Netscape looping extension when decoded.
	*/
	isNetscapeLoopingExtension?: boolean;

	/**
	Total animation plays from a Netscape looping extension. `'forever'` means infinite playback. When encoding an explicit Netscape application extension block, finite values must be from `2` to `65_536` because `1` is represented by omitting the loop extension.
	*/
	playCount?: GIFPlayCount;
};

type ImageBlockBase = {
	/**
	Graphic control metadata scoped to this image block.
	*/
	graphicControlExtension?: GraphicControlExtension | undefined;

	/**
	Image left offset in logical-screen pixels. Defaults to `0` when encoding.
	*/
	left?: number;

	/**
	Image top offset in logical-screen pixels. Defaults to `0` when encoding.
	*/
	top?: number;

	/**
	Image width in pixels.
	*/
	width: number;

	/**
	Image height in pixels.
	*/
	height: number;
};

/**
Indexed image block. `pixels` is one palette index per pixel and uses this image's `colorTable` or the GIF `globalColorTable`.
*/
export type ImageBlock = ImageBlockBase & {
	/**
	Block discriminator.
	*/
	type: 'image';

	/**
	Whether indexed pixels are stored in GIF interlaced order.
	*/
	isInterlaced?: boolean;

	/**
	Color table for this image block.
	*/
	colorTable?: ColorTable | undefined;

	/**
	LZW minimum code size read from decoded GIF image data. `encodeGIF` infers this value and does not accept it as input.
	*/
	minimumCodeSize?: number;

	/**
	One palette index per pixel.
	*/
	pixels: Uint8Array | number[];
};

/**
RGBA image block. Use this when you have flat RGBA bytes and want gifkit to build the indexed pixels and color table.
*/
export type RGBAImage = ImageBlockBase & {
	/**
	Block discriminator.
	*/
	type: 'rgbaImage';

	/**
	Flat RGBA bytes: `[red, green, blue, alpha, ...]`. Used to build a local color table when the image fits GIF’s 256-color model.
	*/
	pixels: Uint8Array | Uint8ClampedArray | number[];

	/**
	RGB value stored in the palette entry used for transparent RGBA pixels.
	*/
	transparentColor?: [number, number, number];
};

/**
Image block accepted by `encodeGIF`. The encoder infers GIF LZW details like `minimumCodeSize`.
*/
export type EncodableImageBlock = Omit<ImageBlock, 'minimumCodeSize'> & {
	/**
	Not accepted by `encodeGIF`; the encoder infers it from the active color table.
	*/
	minimumCodeSize?: never;
};

/**
A block whose extension label gifkit doesn't interpret, preserved as raw bytes.
*/
export type UnknownExtensionBlock = {
	/**
	Block discriminator.
	*/
	type: 'unknownExtension';

	/**
	Raw extension label byte.
	*/
	extensionLabel: number;

	/**
	Fixed data bytes that followed the extension label.
	*/
	fixedData: Uint8Array;

	/**
	Raw data sub-block payload.
	*/
	data: Uint8Array;
};

/**
Any structured GIF block.
*/
export type GIFBlock = CommentExtensionBlock | AppExtensionBlock | ImageBlock | UnknownExtensionBlock;

/**
Structured block accepted by `encodeGIF`.
*/
export type EncodableGIFBlock = CommentExtensionBlock | AppExtensionBlock | EncodableImageBlock | RGBAImage;

/**
Structured GIF object with logical-screen metadata, extension blocks, image blocks, color tables, and decoded indexed pixels.
*/
export type GIF = {
	/**
	Optional object discriminator.
	*/
	type?: 'gif';

	/**
	Decoded GIF version.
	*/
	version?: GIFVersion;

	/**
	Logical screen width in pixels.
	*/
	width: number;

	/**
	Logical screen height in pixels.
	*/
	height: number;

	/**
	Global color table index used as the logical-screen background color.
	*/
	backgroundColorIndex?: number;

	/**
	Global color table shared by image blocks.
	*/
	globalColorTable?: ColorTable | undefined;

	/**
	Total animation plays. `'forever'` means infinite playback. Omitted when no loop extension was present.
	*/
	playCount?: GIFPlayCount | undefined;

	/**
	Structured GIF blocks in file order.
	*/
	blocks?: GIFBlock[];

	/**
	Image blocks extracted for convenience.
	*/
	imageBlocks?: ImageBlock[];
};

/**
Structured GIF object accepted by `encodeGIF`.
*/
export type EncodableGIF = Omit<GIF, 'version' | 'playCount' | 'blocks' | 'imageBlocks'> & {
	/**
	Total animation plays. Finite values must be integers from `1` to `65_536`. Use `'forever'` for infinite playback. Omit it to omit the loop extension. `playCount: 1` also omits the loop extension because that matches default GIF playback.
	*/
	playCount?: GIFPlayCount | undefined;

	/**
	Structured encodable GIF blocks in file order.
	*/
	blocks?: EncodableGIFBlock[];
};

/**
Options for `decodeGIF()` and `decodeAnimatedGIF()`.
*/
export type DecodeOptions = {
	/**
	Default: `true`. Reject reserved bits, malformed extension sequencing, and trailing bytes.
	*/
	strict?: boolean;
};

/**
How to render the GIF logical-screen background.
*/
export type RenderBackground = 'transparent' | 'gif';

/**
Options for `renderGIFFrames()`, `renderGIFFrameSequence()`, and `decodeAnimatedGIF()`.
*/
export type RenderOptions = {
	/**
	Default: `true`. Reject malformed render data like color indexes outside the active color table.
	*/
	strict?: boolean;

	/**
	Default: `'gif'` for `renderGIFFrames()` and `'transparent'` for `decodeAnimatedGIF()`. Use `'gif'` to render the logical-screen background color, or `'transparent'` to render it as transparent.
	*/
	background?: RenderBackground;
};

/**
Options for `renderGIFFrameSequence()`.
*/
export type GIFFrameSequenceOptions = RenderOptions & {
	/**
	Default: `true`. Repeat according to GIF `playCount` metadata. Missing metadata means one pass, a finite number means that many total passes, and `'forever'` means infinite playback. Set to `false` to render exactly one pass.
	*/
	repeat?: boolean;

	/**
	Optional abort signal. When aborted, iteration ends.
	*/
	signal?: AbortSignal;
};

/**
Rendered full logical-screen RGBA frame.
*/
export type RenderedFrame = {
	/**
	Frame left offset in logical-screen pixels.
	*/
	left: number;

	/**
	Frame top offset in logical-screen pixels.
	*/
	top: number;

	/**
	Frame width in pixels.
	*/
	width: number;

	/**
	Frame height in pixels.
	*/
	height: number;

	/**
	Frame delay in seconds.
	*/
	delay: number;

	/**
	Advanced GIF compositing metadata kept so rendered frames can still be related back to the original GIF structure. `'unspecified'` leaves the choice to the decoder, `'keep'` keeps the pixels, `'restoreBackground'` clears them to the background, and `'restorePrevious'` restores the previous canvas before the next frame is drawn. gifkit already applies this when producing `pixels`, so use it only if you need to inspect or preserve the original animation metadata.
	*/
	disposalMethod: DisposalMethod;

	/**
	Rendered full logical-screen RGBA pixels.
	*/
	pixels: Uint8ClampedArray;
};

/**
Rendered full logical-screen RGBA frame yielded by `renderGIFFrameSequence()`.
*/
export type RenderedGIFFrame = RenderedFrame & {
	/**
	Zero-based image-frame index within the current pass.
	*/
	index: number;

	/**
	Zero-based repetition index for this frame.
	*/
	loopIndex: number;
};

/**
Rendered GIF frames.
*/
export type RenderedGIF = {
	/**
	Logical screen width in pixels.
	*/
	width: number;

	/**
	Logical screen height in pixels.
	*/
	height: number;

	/**
	Total animation plays. `'forever'` means infinite playback. Omitted when no loop extension was present.
	*/
	playCount?: GIFPlayCount;

	/**
	Rendered full logical-screen frames.
	*/
	frames: RenderedFrame[];
};

/**
Decoded animated GIF frame as full-frame RGBA pixels with delay in seconds.
*/
export type DecodedAnimatedGIFFrame = {
	/**
	Rendered full-frame RGBA pixels.
	*/
	pixels: Uint8ClampedArray;

	/**
	Frame delay in seconds.
	*/
	delay: number;
};

/**
Decoded animated GIF with rendered full-frame RGBA frames. `playCount` is `'forever'` for infinite playback and omitted when no loop extension was present.
*/
export type DecodedAnimatedGIF = {
	/**
	Logical screen width in pixels.
	*/
	width: number;

	/**
	Logical screen height in pixels.
	*/
	height: number;

	/**
	Total animation plays. `'forever'` means infinite playback. Omitted when no loop extension was present.
	*/
	playCount?: GIFPlayCount;

	/**
	Rendered full-frame RGBA frames.
	*/
	frames: DecodedAnimatedGIFFrame[];
};

/**
Flat RGBA bytes for one animated GIF frame: `[red, green, blue, alpha, ...]`.
*/
export type AnimatedGIFPixels = Uint8Array | Uint8ClampedArray;

/**
RGBA pixels for one animated GIF frame.
*/
export type AnimatedGIFFrame = AnimatedGIFPixels | {
	/**
	Flat RGBA bytes: `[red, green, blue, alpha, ...]`.
	*/
	pixels: Uint8Array | Uint8ClampedArray | number[];

	/**
	Unavailable in the uniform-`fps` frame form.
	*/
	delay?: never;
};

/**
RGBA pixels for one animated GIF frame with a per-frame delay in seconds.
*/
export type AnimatedGIFFrameWithDelay = {
	/**
	Flat RGBA bytes: `[red, green, blue, alpha, ...]`.
	*/
	pixels: Uint8Array | Uint8ClampedArray | number[];

	/**
	Per-frame delay in seconds.
	*/
	delay: number;
};

/**
Options for `encodeAnimatedGIF`. `playCount: 'forever'` means infinite playback. Omit it to omit the loop extension. `quality` defaults to `0.8`; quantization is per-frame and does not dither. Use `1` to keep exact colors.
*/
export type EncodeAnimatedGIFOptions = {
	/**
	Frame width in pixels.
	*/
	width: number;

	/**
	Frame height in pixels.
	*/
	height: number;

	/**
	Total animation plays. Finite values must be integers from `1` to `65_536`. Use `'forever'` for infinite playback. Omit it to omit the loop extension.
	*/
	playCount?: GIFPlayCount | undefined;

	/**
	Default: `0.8`. `0...1`, where lower values quantize each frame more aggressively. Use `1` only when every frame already has at most 256 exact colors.
	*/
	quality?: number;
};

/**
Options for `encodeAnimatedGIF` with uniform frame timing.
*/
export type EncodeAnimatedGIFOptionsWithFPS = EncodeAnimatedGIFOptions & {
	/**
	Frames per second for uniform timing. GIF stores delays in 0.01 second increments, so timing is rounded.
	*/
	fps: number;
};

/**
Options for `encodeAnimatedGIF` with per-frame timing.
*/
export type EncodeAnimatedGIFOptionsWithFrameDelays = EncodeAnimatedGIFOptions & {
	/**
	Unavailable when each frame provides its own `delay`.
	*/
	fps?: undefined;
};

/**
Options for `indexedImage`.
*/
export type IndexedImageOptions = {
	/**
	Default: `[0, 0, 0]`. RGB value stored in the palette entry used for transparent pixels.
	*/
	transparentColor?: [number, number, number];
};

/**
Indexed pixels and a GIF color table converted from RGBA input without quantizing or dithering.
*/
export type IndexedImage = {
	/**
	One palette index per pixel.
	*/
	pixels: Uint8Array;

	/**
	GIF color table as flat RGB bytes.
	*/
	colorTable: Uint8Array;

	/**
	Palette index used for transparency, or `undefined` when the image has no transparent pixels.
	*/
	transparentColorIndex: number | undefined;
};

/**
Decodes a `Uint8Array` containing a GIF file and returns a structured GIF object with logical-screen metadata, extension blocks, image blocks, color tables, and decoded indexed pixels.

Options:

- `strict` - Default: `true`. Reject reserved bits, malformed extension sequencing, and trailing bytes. Use `false` for best-effort decoding.

Decoding enforces internal pixel, block-count, data sub-block-count, and data payload byte limits to avoid resource exhaustion.

gifkit focuses on GIF features that are useful in modern JavaScript workflows. It intentionally does not expose the GIF user-input flag, pixel aspect ratio byte, color-resolution metadata, color-table sort flags, or Plain Text Extension rendering/encoding. These are legacy display-era features, are rarely present in real GIFs, and are easy to misunderstand. Unknown extensions, including Plain Text Extensions, are preserved as `unknownExtension` blocks.

@example
```
import {decodeGIF, encodeGIF, renderGIFFrames} from '@sindresorhus/gifkit';

const bytes = encodeGIF({
	width: 2,
	height: 2,
	globalColorTable: [
		[0, 0, 0],
		[255, 255, 255],
	],
	blocks: [{
		type: 'image',
		width: 2,
		height: 2,
		pixels: [0, 1, 1, 0],
	}],
});

const gif = decodeGIF(bytes);
const rendered = renderGIFFrames(gif);

console.log(gif.version);
console.log(rendered.frames[0].pixels);
```
*/
export function decodeGIF(inputBytes: Uint8Array, options?: DecodeOptions): GIF;

/**
Encodes a structured GIF object to a `Uint8Array`. Use `image` blocks when you already have indexed pixels and a palette. Use `rgbaImage` blocks when you have flat RGBA bytes that fit GIF’s 256-color model.

The `gif` object has this shape:

- `width` / `height` - Required. Logical screen size.
- `globalColorTable` - Optional. Global palette as flat RGB bytes (`[red, green, blue, ...]`), a `Uint8Array`, or RGB triplets (`[[red, green, blue], ...]`).
- `backgroundColorIndex` - Optional. Palette index used as the logical-screen background color. Requires `globalColorTable`.
- `playCount` - Total animation plays. Finite values must be integers from `1` to `65_536`. Use `'forever'` for infinite playback. Omit it to omit the loop extension. `playCount: 1` also omits the loop extension because that matches default GIF playback.
- `blocks` - Structured GIF blocks in file order.

Encoded GIFs are always written as GIF89a.

Block types:

- Indexed image block: `{type: 'image', width, height, pixels, colorTable?}`. `pixels` is one palette index per pixel and uses the image `colorTable` or GIF `globalColorTable`. `left` and `top` are optional image offsets and default to `0`. Advanced fields include `isInterlaced`.
- RGBA image block: `{type: 'rgbaImage', width, height, pixels}`. `pixels` is flat RGBA bytes: `[red, green, blue, alpha, ...]`. gifkit builds a color table from the pixels, so this only works when the image has at most 256 colors and alpha values are fully transparent or fully opaque. `transparentColor` is the RGB palette value stored for transparent pixels.
- Graphic control metadata for an image block: `graphicControlExtension: {disposalMethod?, delay?, transparentColorIndex?}`. `delay` is in seconds. `transparentColorIndex` is a palette index, or `undefined` for no transparent color. `disposalMethod` is exposed so structured GIF data can be preserved or re-encoded. It controls what happens to the current frame’s pixels before the next frame is drawn: `'unspecified'` leaves the choice to the decoder, `'keep'` keeps the pixels, `'restoreBackground'` clears them to the background, and `'restorePrevious'` restores the previous canvas. Rendered pixels already have this applied, so most users do not need to read or set it.
- Comment extension: `{type: 'commentExtension', data}`. Strings must be ASCII.
- Application extension: `{type: 'applicationExtension', identifier, authenticationCode, data?}`. `authenticationCode` accepts a 3-byte string or byte array. Decoded Netscape loop extensions also expose `isNetscapeLoopingExtension` and `playCount`. When encoding an explicit Netscape application extension block, finite `playCount` values must be from `2` to `65_536` because `1` is represented by omitting the loop extension.

Encoding enforces internal pixel, block-count, encode work cost, data payload byte, and total encoded byte limits to avoid resource exhaustion.

Extension payload strings must contain only ASCII characters. Use `Uint8Array` for binary extension data.

@example
```
import {decodeGIF, encodeGIF, renderGIFFrames} from '@sindresorhus/gifkit';

const bytes = encodeGIF({
	width: 2,
	height: 2,
	globalColorTable: [
		[0, 0, 0],
		[255, 255, 255],
	],
	blocks: [{
		type: 'image',
		width: 2,
		height: 2,
		pixels: [0, 1, 1, 0],
	}],
});

const gif = decodeGIF(bytes);
const rendered = renderGIFFrames(gif);

console.log(gif.version);
console.log(rendered.frames[0].pixels);
```
*/
export function encodeGIF(gif: EncodableGIF): Uint8Array;

/**
Decodes an animated GIF to rendered full-frame RGBA frames. Frame `delay` values are in seconds. Uses a transparent background by default.

Returns:

- `width` / `height` - Logical screen size.
- `playCount` - Total animation plays. `'forever'` means infinite playback. Omitted when no loop extension was present.
- `frames` - Rendered full-frame RGBA frames.
- `frames[].pixels` - `Uint8ClampedArray` of flat RGBA bytes: `[red, green, blue, alpha, ...]`.
- `frames[].delay` - Frame delay in seconds. GIF stores delays in 0.01 second increments.

Options:

- `background` - Default: `'transparent'`. Use `'gif'` to render the logical-screen background color.
- `strict` - Default: `true`. Reject malformed decode data and render data like color indexes outside the active color table. Use `false` for best-effort decoding and rendering.

@example
```
import {decodeAnimatedGIF} from '@sindresorhus/gifkit';

const animation = decodeAnimatedGIF(bytes);

console.log(animation.width);
console.log(animation.frames[0].pixels);
console.log(animation.frames[0].delay);
```
*/
export function decodeAnimatedGIF(inputBytes: Uint8Array, options?: DecodeOptions & RenderOptions): DecodedAnimatedGIF;

/**
Encodes RGBA frames as an animated GIF. Use `fps` for uniform timing, or frame objects with `delay` in seconds when frames need different durations. GIF stores delays in 0.01 second increments, so timing is rounded. `quality` is `0...1`; the default quantizes each frame to fit GIF’s 256-color palette without dithering. Use `1` only when every frame already has at most 256 exact colors.

Options:

- `width` / `height` - Required. Frame size.
- `fps` - Frames per second for uniform timing. Cannot be combined with per-frame `delay`. GIF stores delays in 0.01 second increments, so timing is rounded to the nearest increment.
- `playCount` - Total animation plays. Finite values must be integers from `1` to `65_536`. Use `'forever'` for infinite playback. Omit it to omit the loop extension. `playCount: 1` also omits the loop extension because that matches default GIF playback.
- `quality` - Default: `0.8`. `0...1`, where lower values quantize each frame more aggressively to fit GIF’s 256-color palette. Quantization is per-frame and does not dither. For photos and screenshots, keep the default or lower it. Use `1` only when every frame already has at most 256 exact colors.

Frames can be `Uint8Array` or `Uint8ClampedArray` RGBA pixels. Pixels are flat RGBA bytes: `[red, green, blue, alpha, ...]`.

For per-frame timing, use frame objects with `pixels` and `delay` in seconds. Delays are rounded to GIF’s 0.01 second increments:

@example
```
import {encodeAnimatedGIF} from '@sindresorhus/gifkit';

const bytes = encodeAnimatedGIF(frames, {
	width: 640,
	height: 480,
	fps: 14,
	playCount: 5,
	quality: 0.7,
});
```

@example
```
import {encodeAnimatedGIF} from '@sindresorhus/gifkit';

const bytes = encodeAnimatedGIF([
	{pixels: frame1, delay: 0.1},
	{pixels: frame2, delay: 0.2},
], {
	width: 640,
	height: 480,
	playCount: 5,
	quality: 0.7,
});
```
*/
export function encodeAnimatedGIF(frames: AnimatedGIFFrame[], options: EncodeAnimatedGIFOptionsWithFPS): Uint8Array;
export function encodeAnimatedGIF(frames: AnimatedGIFFrameWithDelay[], options: EncodeAnimatedGIFOptionsWithFrameDelays): Uint8Array;

/**
Renders image blocks as an iterable sequence of full logical-screen RGBA frames while applying transparency and disposal methods. Use this for playback or large GIFs where materializing every rendered frame would be wasteful.

Options:

- `background` - Default: `'gif'`. Use `'transparent'` to render the logical-screen background as transparent.
- `strict` - Default: `true`. Reject malformed render data like color indexes outside the active color table.
- `repeat` - Default: `true`. Repeat according to GIF `playCount` metadata. Missing metadata means one pass, a finite number means that many total passes, and `'forever'` means infinite playback. Set to `false` to render exactly one pass.
- `signal` - Optional abort signal. When aborted, iteration ends.

Yields:

- `left` / `top` - Frame source offset in logical-screen pixels.
- `width` / `height` - Frame source size.
- `delay` - Frame delay in seconds.
- `disposalMethod` - Advanced GIF compositing metadata kept so rendered frames can still be related back to the original GIF structure.
- `pixels` - `Uint8ClampedArray` of rendered full logical-screen RGBA bytes.
- `index` - Zero-based image-frame index within the current pass.
- `loopIndex` - Zero-based repetition index for this frame.

@example
```
import {decodeGIF, renderGIFFrameSequence} from '@sindresorhus/gifkit';

const gif = decodeGIF(bytes, {strict: false});

for (const frame of renderGIFFrameSequence(gif, {strict: false})) {
	console.log(frame.pixels);
	console.log(frame.delay);
}
```
*/
export function renderGIFFrameSequence(gif: GIF, options?: GIFFrameSequenceOptions): IterableIterator<RenderedGIFFrame>;

/**
Renders image blocks to full logical-screen RGBA frames while applying transparency and disposal methods. Most users should use `decodeAnimatedGIF()` instead; use this when you need decoded GIF structure and rendered pixels.

Options:

- `background` - Default: `'gif'`. Use `'transparent'` to render the logical-screen background as transparent.
- `strict` - Default: `true`. Reject malformed render data like color indexes outside the active color table.

Returns:

- `width` / `height` - Logical screen size.
- `playCount` - Total animation plays. `'forever'` means infinite playback. Omitted when no loop extension was present.
- `frames` - Rendered full logical-screen RGBA frames.
- `frames[].left` / `frames[].top` - Frame source offset in logical-screen pixels.
- `frames[].width` / `frames[].height` - Frame source size.
- `frames[].delay` - Frame delay in seconds.
- `frames[].disposalMethod` - Advanced GIF compositing metadata kept so rendered frames can still be related back to the original GIF structure. `'unspecified'` leaves the choice to the decoder, `'keep'` keeps the pixels, `'restoreBackground'` clears them to the background, and `'restorePrevious'` restores the previous canvas before the next frame is drawn. gifkit already applies this when producing `frames[].pixels`, so use it only if you need to inspect or preserve the original animation metadata.
- `frames[].pixels` - `Uint8ClampedArray` of rendered full logical-screen RGBA bytes.

Rendering enforces internal logical-screen, rendered-output, render block-count, and image-block pixel limits to avoid huge allocations.

@example
```
import {decodeGIF, encodeGIF, renderGIFFrames} from '@sindresorhus/gifkit';

const bytes = encodeGIF({
	width: 2,
	height: 2,
	globalColorTable: [
		[0, 0, 0],
		[255, 255, 255],
	],
	blocks: [{
		type: 'image',
		width: 2,
		height: 2,
		pixels: [0, 1, 1, 0],
	}],
});

const gif = decodeGIF(bytes);
const rendered = renderGIFFrames(gif);

console.log(gif.version);
console.log(rendered.frames[0].pixels);
```
*/
export function renderGIFFrames(gif: GIF, options?: RenderOptions): RenderedGIF;

/**
Use this when you have raw RGBA pixels, for example from a canvas or image decoder, and want the `pixels` and `colorTable` needed for an image block. It only works when the pixels already fit GIF’s palette model.

Converts RGBA pixels to GIF indexed pixels and a power-of-two color table without quantizing or dithering. Each unique opaque RGB color becomes a palette entry. All fully transparent pixels share one palette entry and set `transparentColorIndex`.

Throws if the image exceeds the internal pixel limit, uses more than 256 palette entries, or uses partial alpha. GIF only supports fully transparent or fully opaque pixels.

Options:

- `transparentColor` - Default: `[0, 0, 0]`. RGB value stored in the palette entry used for transparent pixels.

@example
```
import {indexedImage} from '@sindresorhus/gifkit';

const image = indexedImage(new Uint8ClampedArray([
	255, 0, 0, 255,
	0, 0, 0, 0,
]));

console.log(image.pixels);
console.log(image.colorTable);
```
*/
export function indexedImage(pixels: Uint8Array | Uint8ClampedArray, options?: IndexedImageOptions): IndexedImage;
