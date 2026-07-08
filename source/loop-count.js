import {netscapeLoopingAppIdentifier, netscapeLoopingAppAuthenticationCode, netscapeLoopingAppAuthenticationCodeBytes} from './constants.js';
import {requireIntegerInRange, areBytesEqual, normalizeFixedByteField} from './validate.js';

export function renderTotalPlayCount(playCount) {
	return playCount === 'forever'
		? Infinity
		: playCount ?? 1;
}

export function normalizePlayCount(value, name) {
	// Use a string sentinel because `Infinity` serializes to `null` in JSON.
	if (value === 'forever') {
		return value;
	}

	return requireIntegerInRange(value, 1, 0x1_00_00, name);
}

export function encodeNetscapeLoopCount(playCount, name) {
	if (playCount === 'forever') {
		return 0;
	}

	return requireIntegerInRange(playCount, 1, 0x1_00_00, name) - 1;
}

export function encodeExplicitNetscapeLoopCount(playCount, name) {
	if (playCount === 'forever') {
		return 0;
	}

	return requireIntegerInRange(playCount, 2, 0x1_00_00, name) - 1;
}

export function decodeNetscapeLoopCount(loopCount) {
	return loopCount === 0
		? 'forever'
		: loopCount + 1;
}

export function rejectRenamedLoopCount(object) {
	if (object.loopCount !== undefined) {
		throw new TypeError('loopCount has been renamed to playCount');
	}
}

export function containsNetscapeLoopingAppExtension(blocks) {
	for (const block of blocks) {
		if (isNetscapeLoopingAppExtension(block)) {
			return true;
		}
	}

	return false;
}

export function createNetscapeLoopingAppExtension(loopCount) {
	return {
		type: 'applicationExtension',
		identifier: netscapeLoopingAppIdentifier,
		authenticationCode: netscapeLoopingAppAuthenticationCode,
		data: Uint8Array.of(0x01, loopCount & 0xFF, (loopCount >> 8) & 0xFF),
	};
}

export function isNetscapeLoopingAppExtension(block) {
	return block.type === 'applicationExtension'
		&& block.identifier === netscapeLoopingAppIdentifier
		&& block.data.length >= 3
		&& block.data[0] === 0x01
		&& areBytesEqual(normalizeFixedByteField(block.authenticationCode, 3, 'applicationExtension.authenticationCode'), netscapeLoopingAppAuthenticationCodeBytes);
}
