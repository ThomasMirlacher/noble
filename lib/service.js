'use strict';

const debug = require('debug')('service');

const EventEmitter = require('events');
const util = require('util');

const services = require('./services.json');

class Service extends EventEmitter {
	constructor(noble, peripheralId, data) {
		super();

		this._noble = noble;
		this._peripheralId = peripheralId;

		this.uuid = data.uuid;
		this.startHandle = data.startHandle;
		this.endHandle = data.endHandle;
		this.name = null;
		this.type = null;

		this.includedServiceUuids = null;
		this.characteristics = null;

		const service = services[this.uuid];
		if (service) {
			this.name = service.name;
			this.type = service.type;
		}
	}

	toString() {
		return JSON.stringify({
			uuid: this.uuid,
			startHandle: this.startHandle,
			endHandle: this.endHandle,
			name: this.name,
			type: this.type,
			includedServiceUuids: this.includedServiceUuids
		});
	}

	discoverIncludedServices(uuids, callback) {
		const promise = new Promise((resolve, reject) => {
			this.once('includedServicesDiscover', resolve);

			this._noble.discoverIncludedServices(
				this._peripheralId,
				this.startHandle,
				uuids
			);
		});

		if (callback && typeof callback == 'function') {
			promise.then((resolve) => callback(null, resolve), callback);
		}

		return promise;
	}

	discoverCharacteristics(uuids, callback) {
		const promise = new Promise((resolve, reject) => {
			this.once('characteristicsDiscover', resolve);

			this._noble.discoverCharacteristics(
				this._peripheralId,
				this.startHandle,
				uuids
			);
		});

		if (callback && typeof callback == 'function') {
			promise.then((resolve) => callback(null, resolve), callback);
		}

		return promise;
	}
}

module.exports = Service;
