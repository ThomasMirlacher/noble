'use strict';

const debug = require('debug')('gatt');

const EventEmitter = require('events');

const ATT_OP_ERROR = 0x01;
const ATT_OP_MTU_REQ = 0x02;
const ATT_OP_MTU_RESP = 0x03;
const ATT_OP_FIND_INFO_REQ = 0x04;
const ATT_OP_FIND_INFO_RESP = 0x05;
const ATT_OP_READ_BY_TYPE_REQ = 0x08;
const ATT_OP_READ_BY_TYPE_RESP = 0x09;
const ATT_OP_READ_REQ = 0x0a;
const ATT_OP_READ_RESP = 0x0b;
const ATT_OP_READ_BLOB_REQ = 0x0c;
const ATT_OP_READ_BLOB_RESP = 0x0d;
const ATT_OP_READ_BY_GROUP_REQ = 0x10;
const ATT_OP_READ_BY_GROUP_RESP = 0x11;
const ATT_OP_WRITE_REQ = 0x12;
const ATT_OP_WRITE_RESP = 0x13;
const ATT_OP_PREPARE_WRITE_REQ = 0x16;
const ATT_OP_PREPARE_WRITE_RESP = 0x17;
const ATT_OP_EXECUTE_WRITE_REQ = 0x18;
const ATT_OP_EXECUTE_WRITE_RESP = 0x19;
const ATT_OP_HANDLE_NOTIFY = 0x1b;
const ATT_OP_HANDLE_IND = 0x1d;
const ATT_OP_HANDLE_CNF = 0x1e;
const ATT_OP_WRITE_CMD = 0x52;

const ATT_ECODE_SUCCESS = 0x00;
const ATT_ECODE_INVALID_HANDLE = 0x01;
const ATT_ECODE_READ_NOT_PERM = 0x02;
const ATT_ECODE_WRITE_NOT_PERM = 0x03;
const ATT_ECODE_INVALID_PDU = 0x04;
const ATT_ECODE_AUTHENTICATION = 0x05;
const ATT_ECODE_REQ_NOT_SUPP = 0x06;
const ATT_ECODE_INVALID_OFFSET = 0x07;
const ATT_ECODE_AUTHORIZATION = 0x08;
const ATT_ECODE_PREP_QUEUE_FULL = 0x09;
const ATT_ECODE_ATTR_NOT_FOUND = 0x0a;
const ATT_ECODE_ATTR_NOT_LONG = 0x0b;
const ATT_ECODE_INSUFF_ENCR_KEY_SIZE = 0x0c;
const ATT_ECODE_INVAL_ATTR_VALUE_LEN = 0x0d;
const ATT_ECODE_UNLIKELY = 0x0e;
const ATT_ECODE_INSUFF_ENC = 0x0f;
const ATT_ECODE_UNSUPP_GRP_TYPE = 0x10;
const ATT_ECODE_INSUFF_RESOURCES = 0x11;

const GATT_PRIM_SVC_UUID = 0x2800;
const GATT_INCLUDE_UUID = 0x2802;
const GATT_CHARAC_UUID = 0x2803;

const GATT_CLIENT_CHARAC_CFG_UUID = 0x2902;
const GATT_SERVER_CHARAC_CFG_UUID = 0x2903;

class Gatt extends EventEmitter {
	static get CID() {return 0x04;}

	constructor(hci, handle, address, smp) {
		super();

		this._hci = hci;
		this._handle = handle;

		this._address = address;
		this._smp = smp;

		this._handles = {};

		this._currentCommand = null;
		this._commandQueue = [];

		this._mtu = 23;
		this._security = 'low';

		this.onAclStreamEncryptBinded = this.onAclStreamEncrypt.bind(this);
		this._smp.on('encrypt', this.onAclStreamEncryptBinded);
	}

	onAclStreamData(data) {
		if (this._currentCommand && data.toString('hex') === this._currentCommand.buffer.toString('hex')) {
			debug(`${this._address}: echo ... echo ... echo ...`);
		} else if (data[0] % 2 === 0) {
			if (process.env.NOBLE_MULTI_ROLE) {
				debug(`${this._address}: multi-role flag in use, ignoring command meant for peripheral role.`);
			} else {
				const requestType = data[0];
				debug(`${this._address}: replying with REQ_NOT_SUPP to 0x${requestType.toString(16)}`);
				this.writeAtt(this.errorResponse(requestType, 0x0000, ATT_ECODE_REQ_NOT_SUPP));
			}
		} else if (data[0] === ATT_OP_HANDLE_NOTIFY || data[0] === ATT_OP_HANDLE_IND) {
			const valueHandle = data.readUInt16LE(1);
			const valueData = data.slice(3);

			this.emit('handleNotify', this._address, valueHandle, valueData);

			if (data[0] === ATT_OP_HANDLE_IND) {
				this._queueCommand(this.handleConfirmation(), null, () => {
					this.emit('handleConfirmation', this._address, valueHandle);
				});
			}

			this.emit('notification', this._address, valueHandle, valueData);
			/*
			for (let serviceUuid in this._services) {
				for (let characteristicUuid in this._characteristics[serviceUuid]) {
					if (this._characteristics[serviceUuid][characteristicUuid].valueHandle === valueHandle) {
						this.emit('notification', this._address, serviceUuid, characteristicUuid, valueData);
					}
				}
			}
			*/
		} else if (!this._currentCommand) {
			debug(`${this._address}: uh oh, no current command`);
		} else {
			if (data[0] === ATT_OP_ERROR &&
				(data[4] === ATT_ECODE_AUTHENTICATION || data[4] === ATT_ECODE_AUTHORIZATION || data[4] === ATT_ECODE_INSUFF_ENC) &&
				this._security !== 'medium') {

				this._smp.securityRequest(data);
				return;
			}

			debug(`${this._address}: read: ${data.toString('hex')}`);

			this._currentCommand.callback(data);

			this._currentCommand = null;

			while (this._commandQueue.length) {
				this._currentCommand = this._commandQueue.shift();

				this.writeAtt(this._currentCommand.buffer);

				if (this._currentCommand.callback) {
					break;
				} else if (this._currentCommand.writeCallback) {
					this._currentCommand.writeCallback();

					this._currentCommand = null;
				}
			}
		}
	}

	onAclStreamEncrypt(encrypt) {
		if (encrypt) {
			this._security = 'medium';
			//DENT: this is just a convenience function
			//this.writeAtt(this._currentCommand.buffer);
		}
	}

	onAclStreamEnd() {
		this.removeAllListeners();
	}

	writeAtt(data) {
		debug(`${this._address}: write: ${data.toString('hex')}`);

		this._hci.writeAclDataPkt(this._handle, Gatt.CID, data);
	}

	errorResponse(opcode, handle, status) {
		const buf = new Buffer(5);

		buf.writeUInt8(ATT_OP_ERROR, 0);
		buf.writeUInt8(opcode, 1);
		buf.writeUInt16LE(handle, 2);
		buf.writeUInt8(status, 4);

		return buf;
	}

	_queueCommand(buffer, callback, writeCallback) {
		this._commandQueue.push({
			buffer: buffer,
			callback: callback,
			writeCallback: writeCallback
		});

		if (this._currentCommand === null) {
			while (this._commandQueue.length) {
				this._currentCommand = this._commandQueue.shift();

				this.writeAtt(this._currentCommand.buffer);

				if (this._currentCommand.callback) {
					break;
				} else if (this._currentCommand.writeCallback) {
					this._currentCommand.writeCallback();

					this._currentCommand = null;
				}
			}
		}
	}

	mtuRequest(mtu) {
		const buf = new Buffer(3);

		buf.writeUInt8(ATT_OP_MTU_REQ, 0);
		buf.writeUInt16LE(mtu, 1);

		return buf;
	}

	readByGroupRequest(startHandle, endHandle, groupUuid) {
		const buf = new Buffer(7);

		buf.writeUInt8(ATT_OP_READ_BY_GROUP_REQ, 0);
		buf.writeUInt16LE(startHandle, 1);
		buf.writeUInt16LE(endHandle, 3);
		buf.writeUInt16LE(groupUuid, 5);

		return buf;
	}

	readByTypeRequest(startHandle, endHandle, groupUuid) {
		const buf = new Buffer(7);

		buf.writeUInt8(ATT_OP_READ_BY_TYPE_REQ, 0);
		buf.writeUInt16LE(startHandle, 1);
		buf.writeUInt16LE(endHandle, 3);
		buf.writeUInt16LE(groupUuid, 5);

		return buf;
	}

	readRequest(handle) {
		const buf = new Buffer(3);

		buf.writeUInt8(ATT_OP_READ_REQ, 0);
		buf.writeUInt16LE(handle, 1);

		return buf;
	}

	readBlobRequest(handle, offset) {
		const buf = new Buffer(5);

		buf.writeUInt8(ATT_OP_READ_BLOB_REQ, 0);
		buf.writeUInt16LE(handle, 1);
		buf.writeUInt16LE(offset, 3);

		return buf;
	}

	findInfoRequest(startHandle, endHandle) {
		const buf = new Buffer(5);

		buf.writeUInt8(ATT_OP_FIND_INFO_REQ, 0);
		buf.writeUInt16LE(startHandle, 1);
		buf.writeUInt16LE(endHandle, 3);

		return buf;
	}

	writeRequest(handle, data, withoutResponse) {
		const buf = new Buffer(3 + data.length);

		buf.writeUInt8(withoutResponse ? ATT_OP_WRITE_CMD : ATT_OP_WRITE_REQ, 0);
		buf.writeUInt16LE(handle, 1);

		for (let i = 0; i < data.length; i++) {
			buf.writeUInt8(data.readUInt8(i), i + 3);
		}

		return buf;
	}

	prepareWriteRequest(handle, offset, data) {
		const buf = new Buffer(5 + data.length);

		buf.writeUInt8(ATT_OP_PREPARE_WRITE_REQ, 0);
		buf.writeUInt16LE(handle, 1);
		buf.writeUInt16LE(offset, 3);

		for (let i = 0; i < data.length; i++) {
			buf.writeUInt8(data.readUInt8(i), i + 5);
		}

		return buf;
	}

	executeWriteRequest(handle, cancelPreparedWrites) {
		const buf = new Buffer(2);

		buf.writeUInt8(ATT_OP_EXECUTE_WRITE_REQ, 0);
		buf.writeUInt8(cancelPreparedWrites ? 0 : 1, 1);

		return buf;
	}

	handleConfirmation() {
		const buf = new Buffer(1);

		buf.writeUInt8(ATT_OP_HANDLE_CNF, 0);

		return buf;
	}

	exchangeMtu(mtu) {
		this._queueCommand(this.mtuRequest(mtu), (data) => {
			const opcode = data[0];

			if (opcode === ATT_OP_MTU_RESP) {
				const newMtu = data.readUInt16LE(1);

				debug(`${this._address}: new MTU is ${newMtu}`);

				this._mtu = newMtu;
			}

			this.emit('mtu', this._address, this._mtu);
		});
	}

	discoverServices(uuids) {
		const services = [];

		const callback = (data) => {
			const opcode = data[0];

			if (opcode === ATT_OP_READ_BY_GROUP_RESP) {
				const len_entry = data[1];
				const len_uuid = len_entry - 4;
				const num = (data.length - 2) / len_entry;

				for (let i = 0; i < num; i++) {
					const pos = 2 + i * len_entry;

					services.push({
						startHandle: data.readUInt16LE(pos + 0),
						endHandle: data.readUInt16LE(pos + 2),
						uuid: data.slice(pos + 4, pos + 4 + len_uuid).toString('hex').match(/.{1,2}/g).reverse().join('')
					});
				}
			}

			if (opcode !== ATT_OP_READ_BY_GROUP_RESP || services[services.length - 1].endHandle === 0xffff) {
				const servicesFiltered = [];

				for (let service of services) {
					if (uuids.length === 0 || uuids.indexOf(service.uuid) !== -1) {
						servicesFiltered.push(service);
					}

					this._handles[service.startHandle] = service;
					this._handles[service.startHandle].type = 'service';
				}

				this.emit('servicesDiscover', this._address, servicesFiltered);
			} else {
				this._queueCommand(this.readByGroupRequest(services[services.length - 1].endHandle + 1, 0xffff, GATT_PRIM_SVC_UUID), callback);
			}
		};

		this._queueCommand(this.readByGroupRequest(0x0001, 0xffff, GATT_PRIM_SVC_UUID), callback);
	}

	discoverIncludedServices(handle, uuids) {
		const service = this._handles[handle];
		const includedServices = [];

		const callback= (data) => {
			const opcode = data[0];

			if (opcode === ATT_OP_READ_BY_TYPE_RESP) {
				const len_entry = data[1];
				const len_uuid = len_entry - 6;
				const num = (data.length - 2) / len_entry;

				for (let i = 0; i < num; i++) {
					const pos = 2 + i * len_entry;

					includedServices.push({
						startHandle: data.readUInt16LE(pos + 0),
						endHandle: data.readUInt16LE(pos + 2),
						uuid: data.slice(pos + 6, pos + 6 + len_uuid).toString('hex').match(/.{1,2}/g).reverse().join('')
					});
				}
			}

			if (opcode !== ATT_OP_READ_BY_TYPE_RESP || includedServices[includedServices.length - 1].endHandle === service.endHandle) {
				const includedServicesFiltered = [];

				for (let includedService of includedServices) {
					if (uuids.length === 0 || uuids.indexOf(includedService.uuid) !== -1) {
						includedServicesFiltered.push(includedService);

						this._handles[includedService.startHandle] = includedService;
						this._handles[includedService.startHandle].type = 'includedService';
					}
				}

				this.emit('includedServicesDiscover', this._address, handle, includedServicesFiltered);
			} else {
				this._queueCommand(this.readByTypeRequest(includedServices[includedServices.length - 1].endHandle + 1, service.endHandle, GATT_INCLUDE_UUID), callback);
			}
		};

		this._queueCommand(this.readByTypeRequest(service.startHandle, service.endHandle, GATT_INCLUDE_UUID), callback);
	}

	discoverCharacteristics(handle, uuids) {
		const service = this._handles[handle];
		const characteristics = [];

		const callback = (data) => {
			const opcode = data[0];

			if (opcode === ATT_OP_READ_BY_TYPE_RESP) {
				const len_entry = data[1];
				const len_uuid = len_entry - 5;
				const num = (data.length - 2) / len_entry;

				for (let i = 0; i < num; i++) {
					const pos = 2 + i * len_entry;

					characteristics.push({
						startHandle: data.readUInt16LE(pos + 0),
						properties: data.readUInt8(pos + 2),
						valueHandle: data.readUInt16LE(pos + 3),
						uuid: data.slice(pos + 5, pos + 5 + len_uuid).toString('hex').match(/.{1,2}/g).reverse().join('')
					});
				}
			}

			// NOTE: if there is only a single handle left, there is no need to check for another characteristic
			if (opcode !== ATT_OP_READ_BY_TYPE_RESP || characteristics[characteristics.length - 1].valueHandle+1 >= service.endHandle) {
				const characteristicsFiltered = [];

				for (let i = 0; i < characteristics.length; i++) {
					const characteristic = characteristics[i];
					const properties = characteristic.properties;

					if (i !== 0) {
						characteristics[i - 1].endHandle = characteristics[i].startHandle - 1;
					}

					if (i === (characteristics.length - 1)) {
						characteristics[i].endHandle = service.endHandle;
					}

					characteristic.propertiesTxt = [];

					if (properties & 0x01) {
						characteristic.propertiesTxt.push('broadcast');
					}

					if (properties & 0x02) {
						characteristic.propertiesTxt.push('read');
					}

					if (properties & 0x04) {
						characteristic.propertiesTxt.push('writeWithoutResponse');
					}

					if (properties & 0x08) {
						characteristic.propertiesTxt.push('write');
					}

					if (properties & 0x10) {
						characteristic.propertiesTxt.push('notify');
					}

					if (properties & 0x20) {
						characteristic.propertiesTxt.push('indicate');
					}

					if (properties & 0x40) {
						characteristic.propertiesTxt.push('authenticatedSignedWrites');
					}

					if (properties & 0x80) {
						characteristic.propertiesTxt.push('extendedProperties');
					}

					if (uuids.length === 0 || uuids.indexOf(characteristic.uuid) !== -1) {
						characteristicsFiltered.push(characteristic);	// DELME

						this._handles[characteristic.startHandle] = characteristics[i];
						this._handles[characteristic.startHandle].type = 'characteristic';
					}
				}

				this.emit('characteristicsDiscover', this._address, handle, characteristicsFiltered);
			} else {
				this._queueCommand(this.readByTypeRequest(characteristics[characteristics.length - 1].valueHandle + 1, service.endHandle, GATT_CHARAC_UUID), callback);
			}
		};

		this._queueCommand(this.readByTypeRequest(service.startHandle, service.endHandle, GATT_CHARAC_UUID), callback);
	}

	discoverDescriptors(handle) {
		const characteristic = this._handles[handle];
		const descriptors = [];

		const callback = (data) => {
			const opcode = data[0];

			if (opcode === ATT_OP_FIND_INFO_RESP) {
				const type = data[1];
				const len_entry = (type === 1) ? 2+2 : 16+2;
				const len_uuid = len_entry - 2;
				const num = (data.length - 2) / len_entry;

				for (let i = 0; i < num; i++) {
					let pos = 2 + i * len_entry;

					descriptors.push({
						startHandle: data.readUInt16LE(pos),
						uuid: data.slice(pos + 2, pos + 2 + len_uuid).toString('hex').match(/.{1,2}/g).reverse().join('')
					});
				}
			}

			if (opcode !== ATT_OP_FIND_INFO_RESP || descriptors[descriptors.length - 1].startHandle === characteristic.endHandle) {
				for (let descriptor of descriptors) {
					this._handles[descriptor.startHandle] = descriptor;
					this._handles[descriptor.startHandle].type = 'descriptor';
				}
				this.emit('descriptorsDiscover', this._address, handle, descriptors);
			} else {
				this._queueCommand(this.findInfoRequest(descriptors[descriptors.length - 1].startHandle + 1, characteristic.endHandle), callback);
			}
		};

		if (characteristic.valueHandle === characteristic.endHandle) {
			this.emit('descriptorsDiscover', this._address, handle, []);
		} else {
			this._queueCommand(this.findInfoRequest(characteristic.valueHandle + 1, characteristic.endHandle), callback);
		}
	}

	// for characteristics
	read(handle) {
		const characteristic = this._handles[handle];

		return this.readHandle(characteristic.valueHandle);
	}

	// for characteristics
	write(handle, data, withoutResponse) {
		const characteristic = this._handles[handle];

		return this.writeHandle(characteristic.valueHandle, data, withoutResponse);
	}

	/* Perform a "long write" as described Bluetooth Spec section 4.9.4 "Write Long Characteristic Values" */
	longWrite(handle, data, withoutResponse) {
		const characteristic = this._handles[handle];

		return this.longWriteHandle(characteristic.valueHandle, data, withoutResponse);
	}

	broadcast(handle, broadcast) {
		const promise = new Promise((resolve, reject) => {
			const characteristic = this._handles[handle];

			this._queueCommand(this.readByTypeRequest(characteristic.startHandle, characteristic.endHandle, GATT_SERVER_CHARAC_CFG_UUID), (data) => {
				const opcode = data[0];
				if (opcode === ATT_OP_READ_BY_TYPE_RESP) {
					const type = data[1];
					const handle = data.readUInt16LE(2);
					let value = data.readUInt16LE(4);

					if (broadcast) {
						value |= 0x0001;
					} else {
						value &= 0xfffe;
					}

					const valueBuffer = new Buffer(2);
					valueBuffer.writeUInt16LE(value, 0);

					this._queueCommand(this.writeRequest(handle, valueBuffer, false), (data) => {
						const opcode = data[0];

						if (opcode === ATT_OP_WRITE_RESP) {
							this.emit('broadcast', this._address, handle, broadcast);
						}
					});
				}
			});
		});

		return promise;
	}

	notify(handle, notify) {
		const promise = new Promise((resolve, reject) => {
			const characteristic = this._handles[handle];

			this._queueCommand(this.readByTypeRequest(characteristic.startHandle, characteristic.endHandle, GATT_CLIENT_CHARAC_CFG_UUID), (data) => {
				const opcode = data[0];
				if (opcode === ATT_OP_READ_BY_TYPE_RESP) {
					const type = data[1];
					const handle = data.readUInt16LE(2);
					let value = data.readUInt16LE(4);

					const useNotify = characteristic.properties & 0x10;
					const useIndicate = characteristic.properties & 0x20;

					if (notify) {
						if (useNotify) {
							value |= 0x0001;
						} else if (useIndicate) {
							value |= 0x0002;
						}
					} else {
						if (useNotify) {
							value &= 0xfffe;
						} else if (useIndicate) {
							value &= 0xfffd;
						}
					}

					const valueBuffer = new Buffer(2);
					valueBuffer.writeUInt16LE(value, 0);

					this._queueCommand(this.writeRequest(handle, valueBuffer, false), (data) => {
						const opcode = data[0];

						if (opcode === ATT_OP_WRITE_RESP) {
							this.emit('notify', this._address, handle, notify);
							resolve(this._address, handle, notify);
						}
					});
				}
			});
		});

		return promise;
	}

	// for descriptors
	readValue(handle, descriptorUuid) {
		const promise = new Promise((resolve, reject) => {
			const descriptor = this._handles[handle];

			this._queueCommand(this.readRequest(descriptor.startHandle), (data) => {
				const opcode = data[0];

				if (opcode === ATT_OP_READ_RESP) {
					this.emit('valueRead', this._address, handle, data.slice(1));
					resolve(this._address, handle, data.slice(1));
				}
			});
		});
		
		return promise;
	}

	// for descriptors
	writeValue(handle, data) {
		const promise = new Promise((resolve, reject) => {
			const descriptor = this._handles[handle];

			this._queueCommand(this.writeRequest(descriptor.startHandle, data, false), (data) => {
				const opcode = data[0];

				if (opcode === ATT_OP_WRITE_RESP) {
					this.emit('valueWrite', this._address, handle);
					resolve(this._address, handle);
				}
			});
		});

		return promise;
	}

	/*
	readHandle(handle) {
		const promise = new Promise((resolve, reject) => {
			this._queueCommand(this.readRequest(handle), (data) => {
				const opcode = data[0];

				if (opcode === ATT_OP_READ_RESP) {
					this.emit('handleRead', this._address, handle, data.slice(1));
					resolve(this._address, handle, data.slice(1));
				}
			});
		});

		return promise;
	}
	*/

	readHandle(handle) {
		const promise = new Promise((resolve, reject) => {
			const callback = (data) => {
				const opcode = data[0];	
				let readData = new Buffer(0);

				if (opcode === ATT_OP_READ_RESP || opcode === ATT_OP_READ_BLOB_RESP) {
					readData = new Buffer(readData.toString('hex') + data.slice(1).toString('hex'), 'hex');

					if (data.length >= this._mtu) {
						this._queueCommand(this.readBlobRequest(handle, readData.length), callback);
						return;
					} 
				}

				this.emit('handleRead', this._address, handle, readData);
				resolve(this._address, handle, readData);
			};

			this._queueCommand(this.readRequest(handle), callback);
		});

		return promise;
	}

	writeHandle(handle, data, withoutResponse) {
		const promise = new Promise((resolve, reject) => {
			if (withoutResponse) {
				this._queueCommand(this.writeRequest(handle, data, true), null, () => {
					this.emit('handleWrite', this._address, handle);
					resolve(this._address, handle);
				});
			} else if (data.length + 3 > this._mtu) {
				return this.longWriteHandle(handle, data, withoutResponse);
			} else {
				this._queueCommand(this.writeRequest(handle, data, false), (data) => {
					const opcode = data[0];

					if (opcode === ATT_OP_WRITE_RESP) {
						this.emit('handleWrite', this._address, handle);
						resolve(this._address, handle);
					}
				});
			}
		});

		return promise;
	}

	longWriteHandle(handle, data, withoutResponse) {
		const promise = new Promise((resolve, reject) => {
			const limit = this._mtu - 5;

			const prepareWriteCallback = (chunk) => {
				return (resp) => {
					const opcode = resp[0];

					if (opcode != ATT_OP_PREPARE_WRITE_RESP) {
						debug(`${this._address}: unexpected reply opcode %d (expecting ATT_OP_PREPARE_WRITE_RESP)`, opcode);
					} else {
						const expected_length = chunk.length + 5;

						if (resp.length !== expected_length) {
							/* the response should contain the data packet echoed back to the caller */
							debug(`${this._address}: unexpected prepareWriteResponse length %d (expecting %d)`, resp.length, expected_length);
						}
					}
				};
			};

			/* split into prepare-write chunks and queue them */
			let offset = 0;

			while (offset < data.length) {
				const end = offset + limit;
				const chunk = data.slice(offset, end);
				this._queueCommand(this.prepareWriteRequest(handle, offset, chunk), prepareWriteCallback(chunk));
				offset = end;
			}

			/* queue the execute command with a callback to emit the write signal when done */
			this._queueCommand(this.executeWriteRequest(handle), (resp) => {
				const opcode = resp[0];

				if (opcode === ATT_OP_EXECUTE_WRITE_RESP && !withoutResponse) {
					this.emit('handleWrite', this._address, handle);
					resolve(this._address, handle);
				}
			});
		});

		return promise;
	}
}

module.exports = Gatt;
