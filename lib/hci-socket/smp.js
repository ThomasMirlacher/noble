'use strict';

const debug = require('debug')('acl-att-stream');

const EventEmitter = require('events');
const crypto = require('./crypto');

const SMP_PAIRING_REQUEST = 0x01;
const SMP_PAIRING_RESPONSE = 0x02;
const SMP_PAIRING_CONFIRM = 0x03;
const SMP_PAIRING_RANDOM = 0x04;
const SMP_PAIRING_FAILED = 0x05;
const SMP_ENCRYPT_INFO = 0x06;
const SMP_MASTER_IDENT = 0x07;
const SMP_SECURITY_REQUEST = 0x0B;

class Smp extends EventEmitter {
	static get CID() {return 0x0006;}

	constructor(hci, handle, localAddressType, localAddress, remoteAddressType, remoteAddress) {
		super();

		this._hci = hci;
		this._handle = handle;

		this._iat = new Buffer([(localAddressType === 'random') ? 0x01 : 0x00]);
		this._ia = new Buffer(localAddress.split(':').reverse().join(''), 'hex');
		this._rat = new Buffer([(remoteAddressType === 'random') ? 0x01 : 0x00]);
		this._ra = new Buffer(remoteAddress.split(':').reverse().join(''), 'hex');
	}

	write(cid, data) {
		this._hci.writeAclDataPkt(this._handle, cid, data);
	}

	// from hci:onSocketData -> bindings:onAclDataPkt
	onAclStreamData(data) {
		switch(data.readUInt8(0)) {
			case SMP_PAIRING_RESPONSE: this.pairingResponse(data); break;
			case SMP_PAIRING_CONFIRM: this.pairingConfirm(data); break;
			case SMP_PAIRING_RANDOM: this.pairingRandom(data); break;
			case SMP_PAIRING_FAILED: this.pairingFailed(data); break;
			case SMP_ENCRYPT_INFO: this.encryptInfo(data); break;
			case SMP_MASTER_IDENT: this.masterIdent(data); break;
			case SMP_SECURITY_REQUEST: this.securityRequest(data); break;
		}
	}

	pairingResponse(data) {
		this._pres = data;

		this._tk = new Buffer('00000000000000000000000000000000', 'hex');
		this._r = crypto.r();

		this.write(Smp.CID, Buffer.concat([
			new Buffer([SMP_PAIRING_CONFIRM]),
			crypto.c1(this._tk, this._r, this._pres, this._preq, this._iat, this._ia, this._rat, this._ra)
		]));
	}

	pairingConfirm(data) {
		this._pcnf = data;

		this.write(Smp.CID, Buffer.concat([
			new Buffer([SMP_PAIRING_RANDOM]),
			this._r
		]));
	}

	pairingRandom(data) {
		const r = data.slice(1);

		const pcnf = Buffer.concat([
			new Buffer([SMP_PAIRING_CONFIRM]),
			crypto.c1(this._tk, r, this._pres, this._preq, this._iat, this._ia, this._rat, this._ra)
		]);

		if (this._pcnf.toString('hex') === pcnf.toString('hex')) {
			const stk = crypto.s1(this._tk, r, this._r);

			const random = new Buffer('0000000000000000', 'hex');
			const diversifier = new Buffer('0000', 'hex');

			this._hci.startLeEncryption(this._handle, random, diversifier, stk);
		} else {
			this.write(Smp.CID, new Buffer([
				SMP_PAIRING_RANDOM,
				SMP_PAIRING_CONFIRM
			]));

			this.emit('encryptFail');
		}
	}

	pairingFailed(data) {
		this.emit('encryptFail');
	}

	encryptInfo(data) {
		const ltk = data.slice(1);

		this.emit('ltk', ltk);
	}

	masterIdent(data) {
		const ediv = data.slice(1, 3);
		const rand = data.slice(3);

		this.emit('masterIdent', ediv, rand);
	}

	securityRequest(data) {
		this._preq = new Buffer([
			SMP_PAIRING_REQUEST,
			0x03, // IO capability: NoInputNoOutput
			0x00, // OOB data: Authentication data not present
			0x01, // Authentication requirement: Bonding - No MITM
			0x10, // Max encryption key size
			0x00, // Initiator key distribution: <none>
			0x01 // Responder key distribution: EncKey
		]);

		this.write(Smp.CID, this._preq);
	}
}

module.exports = Smp;