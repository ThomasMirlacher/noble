'use strict';

var debug = require('debug')('descriptor');

var EventEmitter = require('events');
var descriptors = require('./descriptors.json');

class Descriptor extends EventEmitter {
	constructor(noble, peripheralId, data) {
		super();

		this._noble = noble;
		this._peripheralId = peripheralId;

		this.uuid = data.uuid;
		this.startHandle = data.startHandle;
		this.name = null;
		this.type = null;

		var descriptor = descriptors[data.uuid];
		if (descriptor) {
			this.name = descriptor.name;
			this.type = descriptor.type;
		}
	}

	toString() {
		return JSON.stringify({
			uuid: this.uuid,
			startHandle: this.startHandle,
			name: this.name,
			type: this.type
		});
	}

	readValue(callback) {
		const promise = new Promise((resolve, reject) => {
			this.once('valueRead', (data) => {
				resolve(data);
			});

			this._noble.readValue(
				this._peripheralId,
				this.startHandle
			);
		});

		if (callback && typeof callback == 'function') {
			promise.then((resolve) => callback(null, resolve), callback);
		}

		return promise;
	}

	writeValue(data, callback) {
		const promise = new Promise((resolve, reject) => {
			if (!(data instanceof Buffer)) {
				throw new Error('data must be a Buffer');
			}

			this.once('valueWrite', () => {
				resolve();
			});

			this._noble.writeValue(
				this._peripheralId,
				this.startHandle,
				data
			);
		});

		if (callback && typeof callback == 'function') {
			promise.then((resolve) => callback(null, resolve), callback);
		}

		return promise;
	}
}

module.exports = Descriptor;
