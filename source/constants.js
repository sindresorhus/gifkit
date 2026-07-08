export const asciiTextEncoder = new TextEncoder();
export const asciiTextDecoder = new TextDecoder('ascii', {fatal: false});
export const uint8ArraySubarray = Uint8Array.prototype.subarray;

export const extensionIntroducer = 0x21;
export const imageSeparator = 0x2C;
export const trailerByte = 0x3B;

export const graphicControlExtensionLabel = 0xF9;
export const commentExtensionLabel = 0xFE;
export const plainTextExtensionLabel = 0x01;
export const appExtensionLabel = 0xFF;

export const netscapeLoopingAppIdentifier = 'NETSCAPE';
export const netscapeLoopingAppAuthenticationCode = '2.0';
export const netscapeLoopingAppAuthenticationCodeBytes = asciiTextEncoder.encode(netscapeLoopingAppAuthenticationCode);
export const defaultMaximumPixelCount = 100_000_000;
export const defaultMaximumRenderPixelCount = 16_777_216;
export const defaultMaximumIndexedImagePixelCount = 16_777_216;
export const defaultMaximumBlockCount = 100_000;
export const defaultMaximumDataSubBlockCount = 300_000;
export const defaultMaximumDataPayloadByteLength = 64 * 1024 * 1024;
export const defaultMaximumEncodeWorkCost = defaultMaximumPixelCount;
export const defaultMaximumEncodedByteLength = 256 * 1024 * 1024;

// The fast render path writes packed 32-bit RGBA values, which only maps to Uint8ClampedArray byte order on little-endian platforms.
const endiannessProbe = new Uint32Array([0x0A_0B_0C_0D]);

export const isLittleEndian = new Uint8Array(endiannessProbe.buffer, endiannessProbe.byteOffset, endiannessProbe.byteLength)[0] === 0x0D;

export const disposalMethodNames = [
	'unspecified',
	'keep',
	'restoreBackground',
	'restorePrevious',
];
