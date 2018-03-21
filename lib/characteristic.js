'use strict';

const debug = require('debug')('characteristic');

const EventEmitter = require('events');
const characteristics = require('./characteristics.json');

class Characteristic extends EventEmitter {
	constructor(noble, peripheralId, data) {
		super();

		this._noble = noble;
		this._peripheralId = peripheralId;

		this.uuid = data.uuid;
		this.startHandle = data.startHandle;
		this.valueHandle = data.valueHandle;
		this.name = null;
		this.type = null;
		this.properties = data.properties;
		this.propertiesTxt = data.propertiesTxt;

		this.characteristics = null;

		const descriptor = characteristics[data.uuid];
		if (descriptor) {
			this.name = descriptor.name;
			this.type = descriptor.type;
		}
	}

	toString() {
		return JSON.stringify({
			uuid: this.uuid,
			startHandle: this.startHandle,
			valueHandle: this.valueHandle,
			name: this.name,
			type: this.type,
			properties: this.propertiesTxt
		});
	}

	read(callback) {
		const promise = new Promise((resolve, reject) => {
			const onRead = (data, isNotificaton) => {
				// only call the callback if 'read' event and non-notification
				// 'read' for non-notifications is only present for backwards compatbility
				if (!isNotificaton) {
					this.removeListener('read', onRead);
					resolve(data);
				}
			};

			this.once('read', onRead);
			this._noble.read(
				this._peripheralId,
				this.startHandle
			);
		});

		if (callback && typeof callback == 'function') {
			promise.then((resolve) => callback(null, resolve), callback);
		}

		return promise;
	}

	write(data, withoutResponse, callback) {
		if (process.title !== 'browser' && !(data instanceof Buffer)) {
			throw new Error('data must be a Buffer');
		}

		const promise = new Promise((resolve, reject) => {
			this.once('write', () => {
				resolve();
			});

			this._noble.write(
				this._peripheralId,
				this.startHandle,
				data,
				withoutResponse
			);
		});

		if (callback && typeof callback == 'function') {
			promise.then((resolve) => callback(null, resolve), callback);
		}

		return promise;
	}

	broadcast(broadcast, callback) {
		const promise = new Promise((resolve, reject) => {
			this.once('broadcast', () => {
				resolve();
			});

			this._noble.broadcast(
				this._peripheralId,
				this.startHandle,
				broadcast
			);
		});

		if (callback && typeof callback == 'function') {
			promise.then((resolve) => callback(null, resolve), callback);
		}

		return promise;
	}

	// deprecated in favour of subscribe/unsubscribe
	notify(notify, callback) {
		const promise = new Promise((resolve, reject) => {
			this.once('notify', () => {
				resolve();
			});

			this._noble.notify(
				this._peripheralId,
				this.startHandle,
				notify
			);
		});

		if (callback && typeof callback == 'function') {
			promise.then((resolve) => callback(null, resolve), callback);
		}

		return promise;
	}

	subscribe(callback) {
		return this.notify(true, callback);
	}

	unsubscribe(callback) {
		return this.notify(false, callback);
	}

	discoverDescriptors(callback) {
		const promise = new Promise((resolve, reject) => {
			this.once('descriptorsDiscover', resolve);

			this._noble.discoverDescriptors(
				this._peripheralId,
				this.startHandle
			);
		});

		if (callback && typeof callback == 'function') {
			promise.then((resolve) => callback(null, resolve), callback);
		}

		return promise;
	}
}

module.exports = Characteristic;
