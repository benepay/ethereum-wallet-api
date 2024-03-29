'use strict';
require('es6-promise').polyfill();
Object.assign = require('object.assign/polyfill')();

var assert = require('assert');
var hdkey = require('ethereumjs-wallet/hdkey');
var EthereumWallet = require('ethereumjs-wallet');
var EthereumTx = require('ethereumjs-tx');
var Big = require('big.js');
var BN = require('bn.js');
var API = require('./api');
var validator = require('./validator');
var Iban = require('./iban');
var ethUtil = require('ethereumjs-util');

function Wallet(options) {
    if (arguments.length === 0) return this;

    var seed = options.seed;
    var done = options.done;
    var txDone = options.txDone ? options.txDone : function () {
    };

    try {
        assert(seed, 'seed cannot be empty');
    } catch (err) {
        return doneError(err);
    }

    this.networkName = options.networkName;
    this.api = new API();
    this.balance = 0;
    this.confirmedBalance = 0;
    this.historyTxs = [];
    this.txsCount = 0;
    this.etherWallet = hdkey.fromMasterSeed(seed).getWallet();
    this.addressString = this.etherWallet.getAddressString();
    this.gasPrice = '0';
    this.gasLimit = '21000';
    this.minConf = options.minConf || 5;

    var that = this;

    Promise.all([
        that.api.addresses.balance(that.addressString, that.minConf),
        that.api.addresses.txsCount(that.addressString),
        that.api.common.gasPrice(),
        that.api.addresses.txs(that.addressString)
    ]).then(function (results) {

        that.balance = results[0].balance;
        that.confirmedBalance = results[0].confirmedBalance;
        that.txsCount = results[1];
        that.gasPrice = results[2];
        that.historyTxs = transformTxs(that.addressString, results[3]);

        done(null, that);
        txDone(null, that);

    }).catch(doneError);

    function doneError(err) {
        done(err);
        txDone(err);
    }
}

Wallet.prototype.getBalance = function () {
    return this.balance;
};

Wallet.prototype.getNextAddress = function () {
    return this.addressString;
};

Wallet.prototype.createTx = function (to, value) {
    validator.transaction({
        wallet: this,
        to: to,
        value: value
    });

    var tx = new EthereumTx({
        nonce: this.txsCount,
        gasPrice: new BN(this.gasPrice),
        gasLimit: new BN(this.gasLimit),
        to: to,
        value: new BN(value),
        chainId: 1
    });
    tx.sign(this.etherWallet.getPrivateKey());
    return tx;
};

Wallet.prototype.getPendingSpends = function () {
    var that = this;
    return that.historyTxs.reduce(function (sum, tx) {
        if (tx.confirmations < that.minConf && tx.from === that.addressString) {
            var amount = Big(tx.value).abs().plus(Big(tx.gas).times(tx.gasPrice));
            return sum.plus(amount);
        }
        return sum;
    }, Big(0));
};

Wallet.prototype.getDefaultFee = function () {
    return Big(this.gasLimit).times(this.gasPrice);
};

Wallet.prototype.sendTx = function (tx, done) {
    var that = this;
    var rawtx = '0x' + tx.serialize().toString('hex');
    that.api.transactions.propagate(rawtx).then(function (txId) {
        that.processTx(txId, done);
    }).catch(done);
};

Wallet.prototype.processTx = function (txId, done) {
    var that = this;
    that.api.transactions.get(txId, that.addressString).then(function (historyTx) {
        historyTx = transformTxs(that.addressString, historyTx);
        var maxFee = Big(historyTx.gas).times(historyTx.gasPrice);
        that.balance = Big(that.balance).plus(historyTx.value).minus(maxFee).toFixed();
        if (historyTx.from === that.addressString) {
            that.txsCount++;
        }
        that.historyTxs.unshift(historyTx);
        done(null, historyTx);
    }).catch(done);

};

function transformTxs(address, txs) {
    if (Array.isArray(txs)) {
        return txs.map(function (tx) {
            return transformTx(address, tx);
        });
    } else {
        return transformTx(address, txs);
    }

    function transformTx(address, tx) {
        tx.fee = tx.gasUsed ? (Big(tx.gasUsed).times(tx.gasPrice).toFixed()) : -1;
        if (tx.from === address) {
            tx.value = '-' + tx.value;
        }
        return tx;
    }
}

Wallet.prototype.getTransactionHistory = function () {
    return this.historyTxs;
};

Wallet.prototype.isValidIban = function (str) {
    return Iban.isValid(str);
};

Wallet.prototype.getAddressFromIban = function (str) {
    return new Iban(str).address();
};

Wallet.prototype.createPrivateKey = function (str) {
    if (str.indexOf('0x') === 0) {
        str = str.substr(2);
    }
    var privateKey = new Buffer(str, 'hex');
    if (!ethUtil.isValidPrivate(privateKey)) {
        throw new Error('Invalid private key');
    }
    return privateKey;
};

Wallet.prototype.createImportTx = function (options) {
    var amount = Big(options.amount).minus(options.fee);
    if (amount.lt(0)) {
        throw new Error('Insufficient funds');
    }
    var tx = new EthereumTx({
        nonce: options.txsCount,
        gasPrice: new BN(this.gasPrice),
        gasLimit: new BN(this.gasLimit),
        to: options.to,
        value: new BN(amount.toFixed()),
        chainId: 1
    });
    tx.sign(options.privateKey);
    return tx;
};

Wallet.prototype.getImportTxOptions = function (privateKey) {
    var that = this;
    var publicKey = ethUtil.privateToPublic(privateKey);
    var address = ethUtil.bufferToHex(ethUtil.pubToAddress(publicKey));
    return Promise.all([
        that.api.addresses.balance(address, that.minConf),
        that.api.addresses.txsCount(address)
    ]).then(function (results) {
        return {
            privateKey: privateKey,
            amount: results[0].confirmedBalance,
            txsCount: results[1]
        };
    });
};

Wallet.prototype.exportPrivateKeys = function () {
    var str = 'address,privatekey\n';
    str += this.addressString + ',' + this.etherWallet.getPrivateKeyString().substr(2);
    return str;
};

Wallet.prototype.serialize = function () {
    return JSON.stringify({
        networkName: this.networkName,
        balance: this.getBalance(),
        confirmedBalance: this.confirmedBalance,
        historyTxs: this.historyTxs,
        txsCount: this.txsCount,
        privateKey: this.etherWallet.getPrivateKeyString(),
        addressString: this.etherWallet.getAddressString(),
        gasPrice: this.gasPrice,
        gasLimit: this.gasLimit,
        minConf: this.minConf
    });
};

Wallet.deserialize = function (json) {
    var wallet = new Wallet();
    var deserialized = JSON.parse(json);
    var privateKey = wallet.createPrivateKey(deserialized.privateKey);

    wallet.networkName = deserialized.networkName;
    wallet.api = new API();
    wallet.balance = deserialized.balance;
    wallet.confirmedBalance = deserialized.confirmedBalance;
    wallet.historyTxs = deserialized.historyTxs;
    wallet.txsCount = deserialized.txsCount;
    wallet.etherWallet = EthereumWallet.fromPrivateKey(privateKey);
    wallet.addressString = deserialized.addressString;
    wallet.gasPrice = deserialized.gasPrice;
    wallet.gasLimit = deserialized.gasLimit;
    wallet.minConf = deserialized.minConf;
    return wallet;
};

module.exports = Wallet;
