import {
	asciiTextEncoder,
	asciiTextDecoder,
	uint8ArraySubarray,
	defaultMaximumEncodedByteLength,
} from './constants.js';
import {
	isUint8Array,
	toUint8ArrayView,
	requireByte,
	requireUnsigned16,
	requireByteLengthWithinLimit,
} from './validate.js';

export class GIFByteReader {
	#inputBytes;
	#offset = 0;
	#length;

	constructor(inputBytes) {
		if (!isUint8Array(inputBytes)) {
			throw new TypeError('Expected inputBytes to be a Uint8Array');
		}

		this.#inputBytes = toUint8ArrayView(inputBytes);
		this.#length = this.#inputBytes.length;
	}

	get offset() {
		return this.#offset;
	}

	get length() {
		return this.#length;
	}

	readByte() {
		if (this.#offset >= this.#length) {
			throw new Error('Unexpected end of data');
		}

		const value = this.#inputBytes[this.#offset];
		this.#offset += 1;
		return value;
	}

	readBytes(length) {
		if (!Number.isSafeInteger(length) || length < 0) {
			throw new Error(`Invalid byte length ${length}`);
		}

		if (this.#offset + length > this.#length) {
			throw new Error('Unexpected end of data');
		}

		const value = Uint8Array.from(uint8ArraySubarray.call(this.#inputBytes, this.#offset, this.#offset + length));
		this.#offset += length;
		return value;
	}

	readBytesInto(target, targetOffset, length) {
		if (!Number.isSafeInteger(length) || length < 0) {
			throw new Error(`Invalid byte length ${length}`);
		}

		if (this.#offset + length > this.#length) {
			throw new Error('Unexpected end of data');
		}

		target.set(uint8ArraySubarray.call(this.#inputBytes, this.#offset, this.#offset + length), targetOffset);
		this.#offset += length;
	}

	readUnsignedLittleEndian16() {
		const leastSignificantByte = this.readByte();
		const mostSignificantByte = this.readByte();
		return leastSignificantByte | (mostSignificantByte << 8);
	}

	readAsciiString(length) {
		return asciiTextDecoder.decode(this.readBytes(length));
	}
}

export class GIFByteWriter {
	#bytes = new Uint8Array(1024);
	#byteLength = 0;

	#ensureCapacity(requiredCapacity) {
		if (requiredCapacity <= this.#bytes.length) {
			return;
		}

		const nextCapacity = Math.min(defaultMaximumEncodedByteLength, Math.max(requiredCapacity, this.#bytes.length * 2));
		const nextBytes = new Uint8Array(nextCapacity);
		nextBytes.set(uint8ArraySubarray.call(this.#bytes, 0, this.#byteLength));
		this.#bytes = nextBytes;
	}

	writeByte(value) {
		requireByteLengthWithinLimit(this.#byteLength + 1, defaultMaximumEncodedByteLength, 'encoded GIF');
		this.#ensureCapacity(this.#byteLength + 1);
		this.#bytes[this.#byteLength] = requireByte(value, 'byte');
		this.#byteLength += 1;
	}

	writeBytes(values) {
		if (isUint8Array(values)) {
			const bytes = toUint8ArrayView(values);
			requireByteLengthWithinLimit(this.#byteLength + bytes.length, defaultMaximumEncodedByteLength, 'encoded GIF');
			this.#ensureCapacity(this.#byteLength + bytes.length);
			this.#bytes.set(bytes, this.#byteLength);
			this.#byteLength += bytes.length;
			return;
		}

		requireByteLengthWithinLimit(this.#byteLength + values.length, defaultMaximumEncodedByteLength, 'encoded GIF');
		this.#ensureCapacity(this.#byteLength + values.length);
		for (const value of values) {
			this.writeByte(value);
		}
	}

	writeUnsignedLittleEndian16(value) {
		const normalizedValue = requireUnsigned16(value, 'unsigned16');
		this.writeByte(normalizedValue & 0xFF);
		this.writeByte((normalizedValue >> 8) & 0xFF);
	}

	writeAsciiString(value) {
		const encodedValue = asciiTextEncoder.encode(value);

		for (const byte of encodedValue) {
			this.writeByte(byte);
		}
	}

	toUint8Array() {
		return this.#bytes.slice(0, this.#byteLength);
	}
}
