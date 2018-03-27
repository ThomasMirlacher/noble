'use strict';

const debug = require('debug')('noble');

const EventEmitter = require('events');
const Peripheral = require('./peripheral');
const Service = require('./service');
const Characteristic = require('./characteristic');
const Descriptor = require('./descriptor');

class Noble extends EventEmitter {
	constructor(bindings) {
		super();

		this.initialized = false;

		this.address = 'unknown';
		this._state = 'unknown';
		this._bindings = bindings;
		this._peripherals = {};

		this._discoveredPeripheralUUids = [];

		this._bindings.on('stateChange', this.onStateChange.bind(this));
		this._bindings.on('addressChange', this.onAddressChange.bind(this));
		//this._bindings.on('scanStart', this.onScanStart.bind(this));
		//this._bindings.on('scanStop', this.onScanStop.bind(this));
		this._bindings.on('discover', this.onDiscover.bind(this));
		this._bindings.on('connect', this.onConnect.bind(this));
		this._bindings.on('disconnect', this.onDisconnect.bind(this));
		this._bindings.on('rssiUpdate', this.onRssiUpdate.bind(this));
		this._bindings.on('servicesDiscover', this.onServicesDiscover.bind(this));
		this._bindings.on('includedServicesDiscover', this.onIncludedServicesDiscover.bind(this));
		this._bindings.on('characteristicsDiscover', this.onCharacteristicsDiscover.bind(this));
		this._bindings.on('read', this.onRead.bind(this));
		this._bindings.on('write', this.onWrite.bind(this));
		this._bindings.on('broadcast', this.onBroadcast.bind(this));
		this._bindings.on('notify', this.onNotify.bind(this));
		this._bindings.on('descriptorsDiscover', this.onDescriptorsDiscover.bind(this));
		this._bindings.on('valueRead', this.onValueRead.bind(this));
		this._bindings.on('valueWrite', this.onValueWrite.bind(this));
		this._bindings.on('handleRead', this.onHandleRead.bind(this));
		this._bindings.on('handleWrite', this.onHandleWrite.bind(this));
		this._bindings.on('handleNotify', this.onHandleNotify.bind(this));
		this._bindings.on('encryptChange', this.onEncryptChange.bind(this));

		this.on('warning', (message) => {
			if (this.listeners('warning').length === 1) {
				console.warn(`noble: ${message}`);
			}
		});

		//lazy init bindings on first new listener, should be on stateChange
		this.on('newListener', (event) => {
			if (event === 'stateChange' && !this.initialized) {
				process.nextTick(() => {
					this._bindings.init();
					this.initialized = true;
				});
			}
		});
	}

	//or lazy init bindings if someone attempts to get state first
	get state() {
		if (!this.initialized) {
			this._bindings.init();
			this.initialized = true;
		}
		return this._state;
	}

	onStateChange(state) {
		debug(`stateChange ${state}`);

		this._state = state;

		this.emit('stateChange', state);
	}

	onAddressChange(address) {
		debug(`addressChange ${address}`);

		this.address = address;
	}

	startScanning(servicesFiltered, allowDuplicates, callback) {
		let promise = new Promise((resolve, reject) => {
			const scan = (state) => {
				if (state !== 'poweredOn') {
					const error = new Error('Could not start scanning, state is ' + state + ' (not poweredOn)');
					reject(error);
				} else {
					this._bindings.once('scanStart', (filterDuplicates) => {
						resolve(filterDuplicates);
					});

					this._discoveredPeripheralUUids = [];
					this._allowDuplicates = allowDuplicates;

					this._bindings.startScanning(servicesFiltered, allowDuplicates);
				}
			};

			//if bindings still not init, do it now
			if (!this.initialized) {
				this._bindings.init();
				this.initialized = true;
				this._bindings.once('stateChange', scan.bind(this));
			} else {
				scan.call(this, this._state);
			}
		});

		if (callback && typeof callback == 'function') {
			promise.then((resolve) => callback(null, resolve), callback);
		}

		return promise;
	}

	/*
	onScanStart(filterDuplicates) {
		debug('scanStart');
		this.emit('scanStart', filterDuplicates);
	}
	*/

	stopScanning(callback) {
		let promise = new Promise((resolve, reject) => {
			this._bindings.once('scanStop', resolve);

			if (this._bindings && this.initialized) {
				this._bindings.stopScanning();
			}
		});

		if (callback && typeof callback == 'function') {
			promise.then((resolve) => callback(null, resolve), callback);
		}

		return promise;
	}

	/*
	onScanStop() {
		debug('scanStop');
		this.emit('scanStop');
	}
	*/

	onDiscover(peripheralUuid, address, addressType, connectable, advertisement, rssi) {
		let peripheral = this._peripherals[peripheralUuid];

		if (!peripheral) {
			peripheral = new Peripheral(this, peripheralUuid, address, addressType, connectable, advertisement, rssi);

			this._peripherals[peripheralUuid] = peripheral;
		} else {
			// "or" the advertisment data with existing
			for (let i in advertisement) {
				if (advertisement[i] !== undefined) {
					peripheral.advertisement[i] = advertisement[i];
				}
			}

			peripheral.connectable = connectable;
			peripheral.rssi = rssi;
		}

		const previouslyDiscoverd = (this._discoveredPeripheralUUids.indexOf(peripheralUuid) !== -1);

		if (!previouslyDiscoverd) {
			this._discoveredPeripheralUUids.push(peripheralUuid);
		}

		if (this._allowDuplicates || !previouslyDiscoverd) {
			this.emit('discover', peripheral);
		}
	}

	connect(peripheralUuid) {
		this._bindings.connect(peripheralUuid);
	}

	onConnect(peripheralUuid, error) {
		const peripheral = this._peripherals[peripheralUuid];

		if (peripheral) {
			peripheral.state = error ? 'error' : 'connected';
			peripheral.emit('connect', error);
		} else {
			this.emit('warning', `unknown peripheral ${peripheralUuid} connected!`);
		}
	}

	disconnect(peripheralUuid) {
		this._bindings.disconnect(peripheralUuid);
	}

	onDisconnect(peripheralUuid) {
		const peripheral = this._peripherals[peripheralUuid];

		if (peripheral) {
			peripheral.state = 'disconnected';
			peripheral.emit('disconnect');
		} else {
			this.emit('warning', `unknown peripheral ${peripheralUuid} disconnected!`);
		}
	}

	updateRssi(peripheralUuid) {
		this._bindings.updateRssi(peripheralUuid);
	}

	onRssiUpdate(peripheralUuid, rssi) {
		const peripheral = this._peripherals[peripheralUuid];

		if (peripheral) {
			peripheral.rssi = rssi;

			peripheral.emit('rssiUpdate', rssi);
		} else {
			this.emit('warning', `unknown peripheral ${peripheralUuid} RSSI update!`);
		}
	}

	discoverServices(peripheralUuid, uuids) {
		this._bindings.discoverServices(peripheralUuid, uuids);
	}

	onServicesDiscover(peripheralUuid, servicesFiltered) {
		const peripheral = this._peripherals[peripheralUuid];

		if (peripheral) {
			const services_ = [];

			for (let serviceFiltered of servicesFiltered) {
				const service_ = new Service(
					this,
					peripheralUuid,
					serviceFiltered
				);
				peripheral.gattHandles[serviceFiltered.startHandle] = service_;

				services_.push(service_);
			}

			peripheral.services = services_;	// DELME?

			peripheral.emit('servicesDiscover', services_);
		} else {
			this.emit('warning', `unknown peripheral ${peripheralUuid} services discover!`);
		}
	}

	discoverIncludedServices(peripheralUuid, handle, servicesFiltered) {
		this._bindings.discoverIncludedServices(peripheralUuid, handle, servicesFiltered);
	}

	onIncludedServicesDiscover(peripheralUuid, handle, includedServicesFiltered) {
		const peripheral = this._peripherals[peripheralUuid];
		const service = peripheral.gattHandles[handle];

		if (service) {
			service.includedServicesFiltered = includedServicesFiltered;

			service.emit('includedServicesDiscover', includedServicesFiltered);
		} else {
			this.emit('warning', `unknown peripheral ${peripheralUuid}, ${handle} included services discover!`);
		}
	}

	discoverCharacteristics(peripheralUuid, handle, characteristicUuids) {
		this._bindings.discoverCharacteristics(peripheralUuid, handle, characteristicUuids);
	}

	onCharacteristicsDiscover(peripheralUuid, handle, characteristicsFiltered) {
		const peripheral = this._peripherals[peripheralUuid];
		const service = peripheral.gattHandles[handle];

		if (service) {
			const characteristics_ = [];

			for (let characteristic of characteristicsFiltered) {
				const characteristic_ = new Characteristic(
					this,
					peripheralUuid,
					characteristic
				);
				peripheral.gattHandles[characteristic.startHandle] = characteristic_;

				characteristics_.push(characteristic_);
			}

			service.characteristics = characteristics_;

			service.emit('characteristicsDiscover', characteristics_);
		} else {
			this.emit('warning', `unknown peripheral ${peripheralUuid}, ${handle} characteristics discover!`);
		}
	}

	discoverDescriptors(peripheralUuid, handle) {
		this._bindings.discoverDescriptors(peripheralUuid, handle);
	}

	onDescriptorsDiscover(peripheralUuid, handle, descriptorsFiltered) {
		const peripheral = this._peripherals[peripheralUuid];
		const characteristic = peripheral.gattHandles[handle];

		if (characteristic) {
			const descriptors_ = [];

			for (let descriptor of descriptorsFiltered) {
				const descriptor_ = new Descriptor(
					this,
					peripheralUuid,
					descriptor
				);

				peripheral.gattHandles[descriptor.startHandle] = descriptor_;

				descriptors_.push(descriptor_);
			}

			characteristic.descriptors = descriptors_;

			characteristic.emit('descriptorsDiscover', descriptors_);
		} else {
			this.emit('warning', `unknown peripheral ${peripheralUuid}, ${handle} descriptors discover!`);
		}
	}

	read(peripheralUuid, handle) {
		this._bindings.read(peripheralUuid, handle);
	}

	onRead(peripheralUuid, handle, data, isNotification) {
		const peripheral = this._peripherals[peripheralUuid];
		const characteristic = peripheral.gattHandles[handle];

		if (characteristic) {
			characteristic.emit('data', data, isNotification);
			characteristic.emit('read', data, isNotification); // for backwards compatbility
		} else {
			this.emit('warning', `unknown peripheral ${peripheralUuid}, ${handle} read!`);
		}
	}

	write(peripheralUuid, handle, data, withoutResponse) {
		this._bindings.write(peripheralUuid, handle, data, withoutResponse);
	}

	onWrite(peripheralUuid, handle) {
		const peripheral = this._peripherals[peripheralUuid];
		const characteristic = peripheral.gattHandles[handle];

		if (characteristic) {
			characteristic.emit('write');
		} else {
			this.emit('warning', `unknown peripheral ${peripheralUuid}, ${handle} write!`);
		}
	}

	broadcast(peripheralUuid, handle, broadcast) {
		this._bindings.broadcast(peripheralUuid, handle, broadcast);
	}

	onBroadcast(peripheralUuid, handle, state) {
		const peripheral = this._peripherals[peripheralUuid];
		const characteristic = peripheral.gattHandles[handle];

		if (characteristic) {
			characteristic.emit('broadcast', state);
		} else {
			this.emit('warning', `unknown peripheral ${peripheralUuid}, ${handle} broadcast!`);
		}
	}

	notify(peripheralUuid, handle, notify) {
		this._bindings.notify(peripheralUuid, handle, notify);
	}

	onNotify(peripheralUuid, handle, state) {
		const peripheral = this._peripherals[peripheralUuid];
		const characteristic = peripheral.gattHandles[handle];

		if (characteristic) {
			characteristic.emit('notify', state);
		} else {
			this.emit('warning', `unknown peripheral ${peripheralUuid}, ${handle} notify!`);
		}
	}

	readValue(peripheralUuid, handle) {
		this._bindings.readValue(peripheralUuid, handle);
	}

	onValueRead(peripheralUuid, handle, data) {
		const peripheral = this._peripherals[peripheralUuid];
		const descriptor = peripheral.gattHandles[handle];

		if (descriptor) {
			descriptor.emit('valueRead', data);
		} else {
			this.emit('warning', `unknown peripheral ${peripheralUuid}, ${handle} value read!`);
		}
	}

	writeValue(peripheralUuid, handle, data) {
		this._bindings.writeValue(peripheralUuid, handle, data);
	}

	onValueWrite(peripheralUuid, handle) {
		const peripheral = this._peripherals[peripheralUuid];
		const descriptor = peripheral.gattHandles[handle];

		if (descriptor) {
			descriptor.emit('valueWrite');
		} else {
			this.emit('warning', `unknown peripheral ${peripheralUuid}, ${handle} value write!`);
		}
	}

	readHandle(peripheralUuid, handle) {
		this._bindings.readHandle(peripheralUuid, handle);
	}

	onHandleRead(peripheralUuid, handle, data) {
		const peripheral = this._peripherals[peripheralUuid];

		if (peripheral) {
			peripheral.emit('handleRead' + handle, data);
		} else {
			this.emit('warning', `unknown peripheral ${peripheralUuid} handle read!`);
		}
	}

	writeHandle(peripheralUuid, handle, data, withoutResponse) {
		this._bindings.writeHandle(peripheralUuid, handle, data, withoutResponse);
	}

	onHandleWrite(peripheralUuid, handle) {
		const peripheral = this._peripherals[peripheralUuid];

		if (peripheral) {
			peripheral.emit('handleWrite' + handle);
		} else {
			this.emit('warning', `unknown peripheral ${peripheralUuid} handle write!`);
		}
	}

	onHandleNotify(peripheralUuid, handle, data) {
		const peripheral = this._peripherals[peripheralUuid];

		if (peripheral) {
			peripheral.emit('handleNotify', handle, data);
		} else {
			this.emit('warning', `unknown peripheral ${peripheralUuid} handle notify!`);
		}
	}

	onEncryptChange(handle, encrypt) {
		console.log("noble encryptChange " + encrypt);
		this.emit('encryptChange', handle, encrypt);
	}
}

module.exports = Noble;
