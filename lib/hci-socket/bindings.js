'use strict';

const debug = require('debug')('bindings');

const EventEmitter = require('events');

const Smp = require('./smp');
const Gatt = require('./gatt');
const Gap = require('./gap');
const Hci = require('./hci');
const Signaling = require('./signaling');

class NobleBindings extends EventEmitter {
	constructor() {
		super();

		this._state = null;

		this._addresses = {};
		this._addresseTypes = {};
		this._connectable = {};

		this._pendingConnectionUuid = null;
		this._connectionQueue = [];

		this._handles = {};
		this._gatts = {};
		this._smps = {};
		this._signalings = {};

		this._hci = new Hci();
		this._gap = new Gap(this._hci);
	}

	init() {
		this.onSigIntBinded = this.onSigInt.bind(this);

		this._gap.on('scanStart', this.onScanStart.bind(this));
		this._gap.on('scanStop', this.onScanStop.bind(this));
		this._gap.on('discover', this.onDiscover.bind(this));

		this._hci.on('stateChange', this.onStateChange.bind(this));
		this._hci.on('addressChange', this.onAddressChange.bind(this));
		this._hci.on('leConnComplete', this.onLeConnComplete.bind(this));
		this._hci.on('leConnUpdateComplete', this.onLeConnUpdateComplete.bind(this));
		this._hci.on('rssiRead', this.onRssiRead.bind(this));
		this._hci.on('disconnComplete', this.onDisconnComplete.bind(this));
		this._hci.on('encryptChange', this.onEncryptChange.bind(this));
		this._hci.on('aclDataPkt', this.onAclDataPkt.bind(this));

		this._hci.init();

		/* Add exit handlers after `init()` has completed. If no adaptor
		is present it can throw an exception - in which case we don't
		want to try and clear up afterwards (issue #502) */
		process.on('SIGINT', this.onSigIntBinded);
		process.on('exit', this.onExit.bind(this));
	}

	_getGattByPeripheralUuid(peripheralUuid) {
		const handle_ = this._handles[peripheralUuid];
		return this._gatts[handle_];
	}

	startScanning(serviceUuids, allowDuplicates) {
		this._scanServiceUuids = serviceUuids || [];
		this._gap.startScanning(allowDuplicates);
	}

	onScanStart(filterDuplicates) {
		this.emit('scanStart', filterDuplicates);
	}

	stopScanning() {
		this._gap.stopScanning();
	}

	onScanStop() {
		this.emit('scanStop');
	}

	connect(peripheralUuid) {
		const address = this._addresses[peripheralUuid];
		const addressType = this._addresseTypes[peripheralUuid];

		if (!this._pendingConnectionUuid) {
			this._pendingConnectionUuid = peripheralUuid;

			this._hci.createLeConn(address, addressType);
		} else {
			this._connectionQueue.push(peripheralUuid);
		}
	}

	disconnect(peripheralUuid) {
		this._hci.disconnect(this._handles[peripheralUuid]);
	}

	updateRssi(peripheralUuid) {
		this._hci.readRssi(this._handles[peripheralUuid]);
	}

	onSigInt() {
		const sigIntListeners = process.listeners('SIGINT');

		if (sigIntListeners[sigIntListeners.length - 1] === this.onSigIntBinded) {
			// we are the last listener, so exit
			// this will trigger onExit, and clean up
			process.exit(1);
		}
	}

	onExit() {
		this.stopScanning();

		for (const handle in this._smps) {
			this._hci.disconnect(handle);
		}
	}

	onStateChange(state) {
		if (this._state === state) {
			return;
		}
		this._state = state;


		if (state === 'unauthorized') {
			console.log('noble warning: adapter state unauthorized, please run as root or with sudo');
			console.log('               or see README for information on running without root/sudo:');
			console.log('               https://github.com/sandeepmistry/noble#running-on-linux');
		} else if (state === 'unsupported') {
			console.log('noble warning: adapter does not support Bluetooth Low Energy (BLE, Bluetooth Smart).');
			console.log('               Try to run with environment constiable:');
			console.log('               [sudo] NOBLE_HCI_DEVICE_ID=x node ...');
		}

		this.emit('stateChange', state);
	}

	onAddressChange(address) {
		this.emit('addressChange', address);
	}

	onDiscover(status, address, addressType, connectable, advertisement, rssi) {
		if (this._scanServiceUuids === undefined) {
			return;
		}

		let serviceUuids = advertisement.serviceUuids || [];
		const serviceData = advertisement.serviceData || [];
		let hasScanServiceUuids = (this._scanServiceUuids.length === 0);

		if (!hasScanServiceUuids) {
			serviceUuids = serviceUuids.slice();

			for (let i in serviceData) {
				serviceUuids.push(serviceData[i].uuid);
			}

			for (let i in serviceUuids) {
				hasScanServiceUuids = (this._scanServiceUuids.indexOf(serviceUuids[i]) !== -1);

				if (hasScanServiceUuids) {
					break;
				}
			}
		}

		if (hasScanServiceUuids) {
			const uuid = address.split(':').join('');
			this._addresses[uuid] = address;
			this._addresseTypes[uuid] = addressType;
			this._connectable[uuid] = connectable;

			this.emit('discover', uuid, address, addressType, connectable, advertisement, rssi);
		}
	}

	onLeConnComplete(status, handle, role, addressType, address, interval, latency, supervisionTimeout, masterClockAccuracy) {
		let peripheralUuid = null;
		let error = null;

		if (status === 0) {
			peripheralUuid = address.split(':').join('').toLowerCase();

			const smp = new Smp(this._hci, handle, this._hci.addressType, this._hci.address, addressType, address);
			const gatt = new Gatt(this._hci, handle, address, smp);
			const signaling = new Signaling(this._hci. handle);

			this._gatts[handle] = gatt;
			this._signalings[handle] = signaling;
			this._smps[handle] = smp;
			this._handles[peripheralUuid] = handle;
			this._handles[handle] = peripheralUuid;

			this._gatts[handle].on('mtu', this.onMtu.bind(this));
			this._gatts[handle].on('servicesDiscover', this.onServicesDiscovered.bind(this));
			this._gatts[handle].on('includedServicesDiscover', this.onIncludedServicesDiscovered.bind(this));
			this._gatts[handle].on('characteristicsDiscover', this.onCharacteristicsDiscovered.bind(this));
			this._gatts[handle].on('read', this.onRead.bind(this));
			this._gatts[handle].on('write', this.onWrite.bind(this));
			this._gatts[handle].on('broadcast', this.onBroadcast.bind(this));
			this._gatts[handle].on('notify', this.onNotify.bind(this));
			this._gatts[handle].on('notification', this.onNotification.bind(this));
			this._gatts[handle].on('descriptorsDiscover', this.onDescriptorsDiscovered.bind(this));
			this._gatts[handle].on('valueRead', this.onValueRead.bind(this));
			this._gatts[handle].on('valueWrite', this.onValueWrite.bind(this));
			this._gatts[handle].on('handleRead', this.onHandleRead.bind(this));
			this._gatts[handle].on('handleWrite', this.onHandleWrite.bind(this));
			this._gatts[handle].on('handleNotify', this.onHandleNotify.bind(this));

			this._signalings[handle].on('connectionParameterUpdateRequest', this.onConnectionParameterUpdateRequest.bind(this));

			this._gatts[handle].exchangeMtu(256);
		} else {
			peripheralUuid = this._pendingConnectionUuid;
			let statusMessage = Hci.STATUS_MAPPER[status] || 'HCI Error: Unknown';
			const errorCode = ` (0x${status.toString(16)})`;
			statusMessage = statusMessage + errorCode;
			error = new Error(statusMessage);
		}

		this.emit('connect', peripheralUuid, error);

		if (this._connectionQueue.length > 0) {
			const peripheralUuid = this._connectionQueue.shift();

			address = this._addresses[peripheralUuid];
			addressType = this._addresseTypes[peripheralUuid];

			this._pendingConnectionUuid = peripheralUuid;

			this._hci.createLeConn(address, addressType);
		} else {
			this._pendingConnectionUuid = null;
		}
	}

	onLeConnUpdateComplete(handle, interval, latency, supervisionTimeout) {
		// no-op
	}

	onDisconnComplete(handle, reason) {
		const peripheralUuid = this._handles[handle];

		if (peripheralUuid) {
			this._gatts[handle].onAclStreamEnd();
			this._signalings[handle].onAclStreamEnd();

			delete this._gatts[handle];
			delete this._signalings[handle];
			delete this._smps[handle];
			delete this._handles[peripheralUuid];
			delete this._handles[handle];

			this.emit('disconnect', peripheralUuid); // TODO: handle reason?
		} else {
			console.warn(`noble warning: unknown handle ${handle} disconnected!`);
		}
	}

	onEncryptChange(handle, encrypt) {
		console.log("bindings encryptChange " + encrypt);
		this.emit('encryptChange', handle, encrypt);
	}

	onMtu(address, mtu) {
		console.log(`MTU: ${address} ${mtu}`);
		// no-op
	}

	onRssiRead(handle, rssi) {
		this.emit('rssiUpdate', this._handles[handle], rssi);
	}

	onAclDataPkt(handle, cid, data) {
		if (data) {
			if (cid == Gatt.CID) { // att
				this._gatts[handle].onAclStreamData(data);
			}
			if (cid == Signaling.CID) { // signaling
				this._signalings[handle].onAclStreamData(data);
			}
			if (cid == Smp.CID) {	// SMP
				this._smps[handle].onAclStreamData(data);
			}
		} else {
			this._gatts[handle].onAclStreamEnd();
			this._signalings[handle].onAclStreamEnd();
			//aclStream.onAclStreamEnd();
		}
	}

	discoverServices(peripheralUuid, uuids) {
		const gatt = this._getGattByPeripheralUuid(peripheralUuid);

		if (gatt) {
			gatt.discoverServices(uuids || []);
		} else {
			console.warn(`noble warning: unknown peripheral ${peripheralUuid}`);
		}
	}

	onServicesDiscovered(address, servicesFiltered) {
		const uuid = address.split(':').join('').toLowerCase();

		this.emit('servicesDiscover', uuid, servicesFiltered);
	}

	discoverIncludedServices(peripheralUuid, handle, serviceUuids) {
		const gatt = this._getGattByPeripheralUuid(peripheralUuid);

		if (gatt) {
			gatt.discoverIncludedServices(handle, serviceUuids || []);
		} else {
			console.warn(`noble warning: unknown peripheral ${peripheralUuid}`);
		}
	}

	onIncludedServicesDiscovered(address, handle, includedServicesFiltered) {
		const uuid = address.split(':').join('').toLowerCase();

		this.emit('includedServicesDiscover', uuid, handle, includedServicesFiltered);
	}

	discoverCharacteristics(peripheralUuid, handle, characteristicsFiltered) {
		const gatt = this._getGattByPeripheralUuid(peripheralUuid);

		if (gatt) {
			gatt.discoverCharacteristics(handle, characteristicsFiltered || []);
		} else {
			console.warn(`noble warning: unknown peripheral ${peripheralUuid}`);
		}
	}

	onCharacteristicsDiscovered(address, handle, characteristicsFiltered) {
		const uuid = address.split(':').join('').toLowerCase();

		this.emit('characteristicsDiscover', uuid, handle, characteristicsFiltered);
	}

	discoverDescriptors(peripheralUuid, handle) {
		const gatt = this._getGattByPeripheralUuid(peripheralUuid);

		if (gatt) {
			gatt.discoverDescriptors(handle);
		} else {
			console.warn(`noble warning: unknown peripheral ${peripheralUuid}`);
		}
	}

	onDescriptorsDiscovered(address, handle, descriptorsFiltered) {
		const uuid = address.split(':').join('').toLowerCase();

		this.emit('descriptorsDiscover', uuid, handle, descriptorsFiltered);
	}

	read(peripheralUuid, handle) {
		const gatt = this._getGattByPeripheralUuid(peripheralUuid);

		if (gatt) {
			gatt.read(handle);
		} else {
			console.warn(`noble warning: unknown peripheral ${peripheralUuid}`);
		}
	}

	onRead(address, handle, data) {
		const uuid = address.split(':').join('').toLowerCase();

		this.emit('read', uuid, handle, data, false);
	}

	write(peripheralUuid, handle, data, withoutResponse) {
		const gatt = this._getGattByPeripheralUuid(peripheralUuid);

		if (gatt) {
			gatt.write(handle, data, withoutResponse);
		} else {
			console.warn(`noble warning: unknown peripheral ${peripheralUuid}`);
		}
	}

	onWrite(address, handle) {
		const uuid = address.split(':').join('').toLowerCase();

		this.emit('write', uuid, handle);
	}

	broadcast(peripheralUuid, handle, broadcast) {
		const gatt = this._getGattByPeripheralUuid(peripheralUuid);

		if (gatt) {
			gatt.broadcast(handle, broadcast);
		} else {
			console.warn(`noble warning: unknown peripheral ${peripheralUuid}`);
		}
	}

	onBroadcast(address, handle, state) {
		const uuid = address.split(':').join('').toLowerCase();

		this.emit('broadcast', uuid, handle, state);
	}

	notify(peripheralUuid, handle, notify) {
		const gatt = this._getGattByPeripheralUuid(peripheralUuid);

		if (gatt) {
			gatt.notify(handle, notify);
		} else {
			console.warn(`noble warning: unknown peripheral ${peripheralUuid}`);
		}
	}

	onNotify(address, handle, state) {
		const uuid = address.split(':').join('').toLowerCase();

		this.emit('notify', uuid, handle, state);
	}

	onNotification(address, handle, data) {
		const uuid = address.split(':').join('').toLowerCase();

		this.emit('read', uuid, handle, data, true);
	}

	readValue(peripheralUuid, handle) {
		const gatt = this._getGattByPeripheralUuid(peripheralUuid);

		if (gatt) {
			gatt.readValue(handle);
		} else {
			console.warn(`noble warning: unknown peripheral ${peripheralUuid}`);
		}
	}

	onValueRead(address, handle, data) {
		const uuid = address.split(':').join('').toLowerCase();

		this.emit('valueRead', uuid, handle, data);
	}

	writeValue(peripheralUuid, handle, data) {
		const gatt = this._getGattByPeripheralUuid(peripheralUuid);

		if (gatt) {
			gatt.writeValue(handle, data);
		} else {
			console.warn(`noble warning: unknown peripheral ${peripheralUuid}`);
		}
	}

	onValueWrite(address, handle) {
		const uuid = address.split(':').join('').toLowerCase();

		this.emit('valueWrite', uuid, handle);
	}

	readHandle(peripheralUuid, attHandle) {
		const gatt = this._getGattByPeripheralUuid(peripheralUuid);

		if (gatt) {
			gatt.readHandle(attHandle);
		} else {
			console.warn(`noble warning: unknown peripheral ${peripheralUuid}`);
		}
	}

	onHandleRead(address, handle, data) {
		const uuid = address.split(':').join('').toLowerCase();

		this.emit('handleRead', uuid, handle, data);
	}

	writeHandle(peripheralUuid, attHandle, data, withoutResponse) {
		const gatt = this._getGattByPeripheralUuid(peripheralUuid);

		if (gatt) {
			gatt.writeHandle(attHandle, data, withoutResponse);
		} else {
			console.warn(`noble warning: unknown peripheral ${peripheralUuid}`);
		}
	}

	onHandleWrite(address, handle) {
		const uuid = address.split(':').join('').toLowerCase();

		this.emit('handleWrite', uuid, handle);
	}

	onHandleNotify(address, handle, data) {
		const uuid = address.split(':').join('').toLowerCase();

		this.emit('handleNotify', uuid, handle, data);
	}

	onConnectionParameterUpdateRequest(handle, minInterval, maxInterval, latency, supervisionTimeout) {
		this._hci.connUpdateLe(handle, minInterval, maxInterval, latency, supervisionTimeout);
	}
}

module.exports = new NobleBindings();
